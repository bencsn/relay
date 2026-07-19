import { timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "@relay/config";
import {
  type AuthContext,
  authenticateApiKey,
  authenticateDonor,
  countCompatibleHosts,
  createJob,
  createPairingCode,
  type Database,
  deleteJobContents,
  getJob,
  getJobEvents,
  issueApiKey,
  listApiKeys,
  OutstandingJobLimitError,
  redeemPairingCode,
  revokeApiKey,
  revokeDonor,
} from "@relay/db";
import {
  bufferedChatStream,
  bufferedResponsesStream,
  chatCompletionResult,
  chatToCanonical,
  durableRequestToCanonical,
  openAIError,
  responsesResult,
  responsesToCanonical,
} from "@relay/openai-compat";
import { durableJobRequestSchema } from "@relay/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { ZodError, z } from "zod";
import type { Logger } from "./logger.ts";
import { openapi } from "./openapi.ts";
import { TokenBucketLimiter } from "./rate-limit.ts";
import { accountWebhookSecret, validateWebhookUrl, WebhookUrlError } from "./webhooks.ts";

type Variables = { auth: AuthContext; requestId: string };

export interface AppDependencies {
  config: ServerConfig;
  sql: Database;
  logger: Logger;
}

function bearer(header?: string) {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function terminal(status: string) {
  return ["succeeded", "failed", "expired", "cancelled"].includes(status);
}

function secretsEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(deps: AppDependencies) {
  const app = new Hono<{ Variables: Variables }>();
  const limiter = new TokenBucketLimiter(deps.config.RATE_LIMIT_REQUESTS_PER_MINUTE);
  const pairingLimiter = new TokenBucketLimiter(60);
  const synchronousCounts = new Map<string, number>();
  const sseCounts = new Map<string, number>();

  app.use("*", secureHeaders());
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id")?.slice(0, 128) || crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    if (c.req.path.startsWith("/v1/")) c.header("cache-control", "no-store");
    const forwardedProtocol = deps.config.TRUST_PROXY_HEADERS
      ? c.req.header("x-forwarded-proto")?.split(",")[0]?.trim()
      : undefined;
    const protocol = forwardedProtocol ?? new URL(c.req.url).protocol.replace(":", "");
    if (deps.config.REQUIRE_HTTPS && protocol !== "https") {
      return c.json(
        openAIError("HTTPS is required.", "invalid_request_error", "https_required"),
        400,
      );
    }
    await next();
  });
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: deps.config.MAX_REQUEST_BYTES,
      onError: (c) =>
        c.json(
          openAIError(
            "Request body exceeds the Relay platform limit.",
            "invalid_request_error",
            "request_too_large",
          ),
          413,
        ),
    }),
  );

  const requireAuth = async (c: any, next: () => Promise<void>) => {
    const raw = bearer(c.req.header("authorization"));
    if (!raw)
      return c.json(
        openAIError("Missing bearer API key.", "authentication_error", "invalid_api_key"),
        401,
      );
    const auth = await authenticateApiKey(deps.sql, deps.config.KEY_PEPPER, raw);
    if (!auth)
      return c.json(
        openAIError("Invalid or revoked API key.", "authentication_error", "invalid_api_key"),
        401,
      );
    if (!limiter.take(auth.apiKeyId)) {
      c.header("retry-after", "60");
      return c.json(
        openAIError("API rate limit exceeded.", "rate_limit_error", "rate_limit_exceeded"),
        429,
      );
    }
    c.set("auth", auth);
    await next();
  };

  const requireScope = (scope: string) => async (c: any, next: () => Promise<void>) => {
    const auth = c.get("auth") as AuthContext;
    if (!auth.scopes.includes(scope))
      return c.json(
        openAIError(`API key lacks ${scope} scope.`, "permission_error", "insufficient_scope"),
        403,
      );
    await next();
  };

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    await deps.sql`SELECT 1`;
    return c.json({ status: "ready", features: { account_only_scheduling: true } });
  });
  app.get("/openapi.json", (c) => c.json(openapi));
  app.get("/metrics", async (c) => {
    const expected = deps.config.METRICS_BEARER_TOKEN;
    if (!expected) return c.notFound();
    const provided = bearer(c.req.header("authorization"));
    if (!provided || !secretsEqual(provided, expected)) return c.text("Unauthorized\n", 401);
    const [jobCounts, donorCounts, webhookCounts, queueAge] = await Promise.all([
      deps.sql<{ status: string; count: number }[]>`
        SELECT status, count(*)::int AS count FROM jobs GROUP BY status ORDER BY status
      `,
      deps.sql<{ status: string; count: number }[]>`
        SELECT status, count(*)::int AS count FROM donors GROUP BY status ORDER BY status
      `,
      deps.sql<{ status: string; count: number }[]>`
        SELECT status, count(*)::int AS count FROM webhook_deliveries GROUP BY status ORDER BY status
      `,
      deps.sql<{ seconds: number }[]>`
        SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float8 AS seconds
        FROM jobs WHERE status IN ('queued', 'retrying')
      `,
    ]);
    const lines = [
      "# HELP relay_jobs Jobs by durable state.",
      "# TYPE relay_jobs gauge",
      ...jobCounts.map((row) => `relay_jobs{status="${row.status}"} ${row.count}`),
      "# HELP relay_donors Donors by server-observed state.",
      "# TYPE relay_donors gauge",
      ...donorCounts.map((row) => `relay_donors{status="${row.status}"} ${row.count}`),
      "# HELP relay_webhook_deliveries Webhook deliveries by state.",
      "# TYPE relay_webhook_deliveries gauge",
      ...webhookCounts.map(
        (row) => `relay_webhook_deliveries{status="${row.status}"} ${row.count}`,
      ),
      "# HELP relay_oldest_queued_job_seconds Age of the oldest queued or retrying job.",
      "# TYPE relay_oldest_queued_job_seconds gauge",
      `relay_oldest_queued_job_seconds ${queueAge[0]?.seconds ?? 0}`,
      "",
    ];
    return c.body(lines.join("\n"), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  app.use("/v1/models", requireAuth);
  app.use("/v1/capabilities", requireAuth);
  app.use("/v1/chat/completions", requireAuth, requireScope("jobs:write"));
  app.use("/v1/responses", requireAuth, requireScope("jobs:write"));
  app.use("/v1/jobs", requireAuth, requireScope("jobs:write"));
  app.use("/v1/jobs/*", requireAuth);
  app.use("/v1/hosts/pairing-codes", requireAuth, requireScope("hosts:pair"));
  app.use("/v1/webhooks/secret", requireAuth, requireScope("jobs:write"));
  app.use("/v1/api-keys", requireAuth, requireScope("keys:write"));
  app.use("/v1/api-keys/*", requireAuth, requireScope("keys:write"));

  app.get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: ["community-auto", "community-code", "community-fast"].map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "relay-community",
        metadata: {
          availability: "best-effort",
          chat_completions: true,
          responses: true,
          tools: true,
        },
      })),
    }),
  );

  app.get("/v1/capabilities", (c) =>
    c.json({
      version: "2026-07-19",
      durability: {
        polling: true,
        replayable_sse: true,
        signed_webhooks: true,
        max_queue_wait_seconds: 604_800,
      },
      chat_completions: {
        non_streaming: true,
        buffered_streaming: true,
        live_streaming: false,
        text: true,
        function_tools: true,
      },
      responses: {
        status: "experimental",
        non_streaming: true,
        buffered_streaming: true,
        text: true,
        function_tools: true,
        stateful: false,
      },
      privacy: { donor_processes_plaintext: true, confidential_workloads_supported: false },
    }),
  );

  app.post("/v1/hosts/pairing-codes", async (c) => {
    const auth = c.get("auth");
    const code = await createPairingCode(deps.sql, deps.config.DEVICE_TOKEN_PEPPER, auth.accountId);
    return c.json({ pairing_code: code, expires_in: 600 }, 201);
  });

  app.post("/v1/hosts/pair", async (c) => {
    if (!pairingLimiter.take("pairing")) {
      c.header("retry-after", "60");
      return c.json(
        openAIError("Pairing rate limit exceeded.", "rate_limit_error", "rate_limit_exceeded"),
        429,
      );
    }
    const input = z
      .object({ pairing_code: z.string().min(16), name: z.string().min(1).max(128) })
      .parse(await c.req.json());
    const paired = await redeemPairingCode(
      deps.sql,
      deps.config.DEVICE_TOKEN_PEPPER,
      input.pairing_code,
      input.name,
    );
    if (!paired)
      return c.json(
        openAIError(
          "Pairing code is invalid, expired, or already used.",
          "authentication_error",
          "invalid_pairing_code",
        ),
        401,
      );
    deps.logger.info("donor.paired", { donor_id: paired.donorId });
    return c.json(
      {
        donor_id: paired.donorId,
        device_token: paired.deviceToken,
        websocket_url: `${deps.config.PUBLIC_BASE_URL.replace(/^http/, "ws")}/v1/hosts/connect`,
      },
      201,
    );
  });

  app.delete("/v1/hosts/me", async (c) => {
    const raw = bearer(c.req.header("authorization"));
    if (!raw)
      return c.json(
        openAIError("Missing donor credential.", "authentication_error", "invalid_device_token"),
        401,
      );
    const donor = await authenticateDonor(deps.sql, deps.config.DEVICE_TOKEN_PEPPER, raw);
    if (!donor)
      return c.json(
        openAIError("Invalid donor credential.", "authentication_error", "invalid_device_token"),
        401,
      );
    await revokeDonor(deps.sql, donor.id);
    return c.body(null, 204);
  });

  app.get("/v1/webhooks/secret", (c) => {
    const auth = c.get("auth");
    return c.json({
      signing_secret: accountWebhookSecret(deps.config.WEBHOOK_SIGNING_SECRET, auth.accountId),
      algorithm: "HMAC-SHA256",
    });
  });

  app.get("/v1/api-keys", async (c) => {
    const auth = c.get("auth");
    const keys = await listApiKeys(deps.sql, auth.accountId);
    return c.json({
      data: keys.map((key) => ({
        id: key.id,
        prefix: key.key_prefix,
        scopes: key.scopes,
        created_at: key.created_at.toISOString(),
        last_used_at: key.last_used_at?.toISOString() ?? null,
      })),
    });
  });

  app.post("/v1/api-keys", async (c) => {
    const auth = c.get("auth");
    const input = z
      .object({
        scopes: z
          .array(z.enum(["jobs:read", "jobs:write", "hosts:pair", "keys:write"]))
          .min(1)
          .optional(),
      })
      .parse(await c.req.json());
    const scopes = input.scopes ?? ["jobs:read", "jobs:write"];
    if (scopes.some((scope) => !auth.scopes.includes(scope))) {
      return c.json(
        openAIError(
          "A new API key cannot receive scopes held outside the creating key.",
          "permission_error",
          "scope_escalation",
        ),
        403,
      );
    }
    const created = await issueApiKey(deps.sql, deps.config.KEY_PEPPER, auth.accountId, scopes);
    return c.json({ id: created.id, key: created.key, prefix: created.prefix, scopes }, 201);
  });

  app.delete("/v1/api-keys/:apiKeyId", async (c) => {
    const auth = c.get("auth");
    const revoked = await revokeApiKey(deps.sql, auth.accountId, c.req.param("apiKeyId"));
    if (!revoked)
      return c.json(
        openAIError("API key not found.", "invalid_request_error", "api_key_not_found"),
        404,
      );
    return c.body(null, 204);
  });

  app.post("/v1/jobs", async (c) => {
    const auth = c.get("auth");
    const rawText = await c.req.text();
    const payload = durableJobRequestSchema.parse(JSON.parse(rawText));
    if (payload.webhook_url) await validateWebhookUrl(payload.webhook_url);
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey && idempotencyKey.length > 255)
      throw new ZodError([
        {
          code: "too_big",
          origin: "string",
          maximum: 255,
          inclusive: true,
          path: ["Idempotency-Key"],
          message: "Idempotency-Key is too long",
        },
      ]);
    const canonical = durableRequestToCanonical(payload.request);
    const { job, created } = await createJob(deps.sql, {
      accountId: auth.accountId,
      apiKeyId: auth.apiKeyId,
      idempotencyKey,
      request: canonical,
      requestBytes: Buffer.byteLength(rawText),
      maxWaitSeconds: payload.queue.max_wait_seconds,
      webhookUrl: payload.webhook_url,
      maxOutstandingJobs: deps.config.MAX_OUTSTANDING_JOBS_PER_ACCOUNT,
    });
    deps.logger.info("job.submitted", {
      job_id: job.id,
      account_id: auth.accountId,
      request_bytes: Buffer.byteLength(rawText),
      idempotent_replay: !created,
    });
    const body = jobAccepted(job);
    c.header("location", body.status_url);
    c.header("idempotent-replayed", created ? "false" : "true");
    return c.json(body, 202);
  });

  app.get("/v1/jobs/:jobId", async (c) => {
    const auth = c.get("auth");
    const job = await getJob(deps.sql, auth.accountId, c.req.param("jobId"));
    if (!job)
      return c.json(
        openAIError("Job not found.", "invalid_request_error", "job_not_found", "job_id"),
        404,
      );
    const compatible =
      job.deleted_at || !job.canonical_request
        ? 0
        : await countCompatibleHosts(deps.sql, job.canonical_request, auth.accountId);
    return c.json({
      id: job.id,
      status: job.status,
      attempt: job.attempt_count,
      compatible_hosts_online: compatible,
      created_at: job.created_at.toISOString(),
      updated_at: job.updated_at.toISOString(),
      expires_at: job.max_wait_at.toISOString(),
      result_expires_at: job.result_expires_at?.toISOString() ?? null,
      error: terminal(job.status) && job.status !== "succeeded" ? job.error : null,
    });
  });

  app.get("/v1/jobs/:jobId/result", async (c) => {
    const auth = c.get("auth");
    const job = await getJob(deps.sql, auth.accountId, c.req.param("jobId"));
    if (!job)
      return c.json(
        openAIError("Job not found.", "invalid_request_error", "job_not_found", "job_id"),
        404,
      );
    if (!terminal(job.status))
      return c.json(
        openAIError(
          "Job has not reached a terminal state.",
          "invalid_request_error",
          "job_not_complete",
          "job_id",
        ),
        409,
      );
    if (job.status === "succeeded" && !job.result)
      return c.json(
        openAIError(
          "The retained result has expired or was deleted.",
          "invalid_request_error",
          "result_gone",
          "job_id",
        ),
        410,
      );
    if (job.status === "succeeded") return c.json(job.result);
    return c.json({ id: job.id, status: job.status, error: job.error });
  });

  app.delete("/v1/jobs/:jobId", async (c) => {
    const auth = c.get("auth");
    const deleted = await deleteJobContents(deps.sql, auth.accountId, c.req.param("jobId"));
    if (!deleted)
      return c.json(
        openAIError("Job not found.", "invalid_request_error", "job_not_found", "job_id"),
        404,
      );
    return c.body(null, 204);
  });

  app.get("/v1/jobs/:jobId/events", async (c) => {
    const auth = c.get("auth");
    const activeStreams = sseCounts.get(auth.apiKeyId) ?? 0;
    if (activeStreams >= deps.config.MAX_SSE_CONNECTIONS_PER_KEY) {
      return c.json(
        openAIError(
          "Too many open event streams for this API key.",
          "rate_limit_error",
          "sse_connection_limit",
        ),
        429,
      );
    }
    const jobId = c.req.param("jobId");
    const job = await getJob(deps.sql, auth.accountId, jobId);
    if (!job)
      return c.json(
        openAIError("Job not found.", "invalid_request_error", "job_not_found", "job_id"),
        404,
      );
    const rawLastId = c.req.header("last-event-id") ?? c.req.query("after") ?? "0";
    let cursor = Number.parseInt(rawLastId, 10);
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
    sseCounts.set(auth.apiKeyId, activeStreams + 1);
    return streamSSE(c, async (stream) => {
      let stopped = false;
      stream.onAbort(() => {
        stopped = true;
      });
      try {
        while (!stopped) {
          const events = await getJobEvents(deps.sql, auth.accountId, jobId, cursor);
          for (const event of events) {
            cursor = Number(event.id);
            await stream.writeSSE({
              id: String(event.id),
              event: event.event_type,
              data: JSON.stringify({
                ...event.payload,
                timestamp: event.created_at.toISOString(),
              }),
            });
          }
          const current = await getJob(deps.sql, auth.accountId, jobId);
          if (!current || (terminal(current.status) && events.length === 0)) break;
          await stream.sleep(750);
        }
      } finally {
        const remaining = (sseCounts.get(auth.apiKeyId) ?? 1) - 1;
        if (remaining > 0) sseCounts.set(auth.apiKeyId, remaining);
        else sseCounts.delete(auth.apiKeyId);
      }
    });
  });

  async function synchronous(c: any, kind: "chat" | "responses") {
    const auth = c.get("auth") as AuthContext;
    const rawText = await c.req.text();
    const parsed =
      kind === "chat"
        ? chatToCanonical(JSON.parse(rawText))
        : responsesToCanonical(JSON.parse(rawText));
    const { job } = await createJob(deps.sql, {
      accountId: auth.accountId,
      apiKeyId: auth.apiKeyId,
      request: parsed.request,
      requestBytes: Buffer.byteLength(rawText),
      maxWaitSeconds: deps.config.SYNC_CAPACITY_WAIT_SECONDS,
      maxOutstandingJobs: deps.config.MAX_OUTSTANDING_JOBS_PER_ACCOUNT,
    });
    const capacityDeadline = Date.now() + deps.config.SYNC_CAPACITY_WAIT_SECONDS * 1000;
    let inferenceDeadline: number | undefined;
    while (true) {
      const current = await getJob(deps.sql, auth.accountId, job.id);
      if (!current) throw new Error("Synchronous job disappeared");
      if (current.status === "succeeded" && current.result) {
        if (kind === "chat") {
          if (parsed.stream)
            return c.body(
              bufferedChatStream(current.id, current.virtual_model, current.result),
              200,
              { "content-type": "text/event-stream", "cache-control": "no-cache" },
            );
          return c.json(chatCompletionResult(current.id, current.virtual_model, current.result));
        }
        if (parsed.stream)
          return c.body(
            bufferedResponsesStream(current.id, current.virtual_model, current.result),
            200,
            { "content-type": "text/event-stream", "cache-control": "no-cache" },
          );
        return c.json(responsesResult(current.id, current.virtual_model, current.result));
      }
      if (["leased", "running"].includes(current.status) && !inferenceDeadline)
        inferenceDeadline = Date.now() + deps.config.SYNC_INFERENCE_TIMEOUT_SECONDS * 1000;
      if (["failed", "expired", "cancelled"].includes(current.status)) {
        return c.json(
          openAIError(
            String(current.error?.message ?? "Inference failed."),
            "relay_inference_error",
            String(current.error?.code ?? "inference_failed"),
          ),
          502,
        );
      }
      if (!inferenceDeadline && Date.now() >= capacityDeadline) {
        await deleteJobContents(deps.sql, auth.accountId, job.id);
        c.header("retry-after", "5");
        c.header("x-relay-durable-jobs", "/v1/jobs");
        return c.json(
          openAIError(
            "No compatible donated inference host is currently available.",
            "relay_capacity_unavailable",
            "capacity_unavailable",
          ),
          503,
        );
      }
      if (inferenceDeadline && Date.now() >= inferenceDeadline) {
        await deleteJobContents(deps.sql, auth.accountId, job.id);
        return c.json(
          openAIError(
            "The donor did not finish before the synchronous deadline.",
            "relay_timeout",
            "inference_timeout",
          ),
          504,
        );
      }
      await Bun.sleep(100);
    }
  }

  const withSynchronousLimit = (kind: "chat" | "responses") => async (c: any) => {
    const auth = c.get("auth") as AuthContext;
    const current = synchronousCounts.get(auth.apiKeyId) ?? 0;
    if (current >= deps.config.MAX_SYNCHRONOUS_REQUESTS_PER_KEY) {
      return c.json(
        openAIError(
          "Too many synchronous requests for this API key.",
          "rate_limit_error",
          "synchronous_concurrency_limit",
        ),
        429,
      );
    }
    synchronousCounts.set(auth.apiKeyId, current + 1);
    try {
      return await synchronous(c, kind);
    } finally {
      const remaining = (synchronousCounts.get(auth.apiKeyId) ?? 1) - 1;
      if (remaining > 0) synchronousCounts.set(auth.apiKeyId, remaining);
      else synchronousCounts.delete(auth.apiKeyId);
    }
  };

  app.post("/v1/chat/completions", withSynchronousLimit("chat"));
  app.post("/v1/responses", withSynchronousLimit("responses"));

  app.notFound((c) =>
    c.json(openAIError("Route not found.", "invalid_request_error", "not_found"), 404),
  );
  app.onError((error, c) => {
    const requestId = c.get("requestId");
    if (error instanceof ZodError || error instanceof SyntaxError) {
      const details =
        error instanceof ZodError
          ? error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
          : undefined;
      return c.json(
        {
          ...openAIError("Request validation failed.", "invalid_request_error", "invalid_request"),
          details,
        },
        400,
      );
    }
    if (error instanceof OutstandingJobLimitError) {
      return c.json(openAIError(error.message, "rate_limit_error", "outstanding_job_limit"), 429);
    }
    if (error instanceof WebhookUrlError) {
      return c.json(
        openAIError(error.message, "invalid_request_error", "invalid_webhook_url", "webhook_url"),
        400,
      );
    }
    deps.logger.error("request.failed", {
      request_id: requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(openAIError("Internal Relay error.", "server_error", "internal_error"), 500);
  });

  return app;
}

function jobAccepted(job: { id: string; status: string; max_wait_at: Date }) {
  return {
    id: job.id,
    status: job.status,
    status_url: `/v1/jobs/${job.id}`,
    events_url: `/v1/jobs/${job.id}/events`,
    result_url: `/v1/jobs/${job.id}/result`,
    expires_at: job.max_wait_at.toISOString(),
  };
}
