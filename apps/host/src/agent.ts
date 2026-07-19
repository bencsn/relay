import { createHash } from "node:crypto";
import {
  type CanonicalRequest,
  type HostCapabilities,
  type HostMessage,
  serverMessageSchema,
} from "@relay/protocol";
import { policyAllowsNow, quotaAllows } from "@relay/scheduler";
import { type HostConfig, localStateBytes, readConfig, writeConfig } from "./config.ts";
import { getCredential } from "./credentials.ts";
import {
  createInferenceAdapter,
  type InferenceAdapter,
  ProviderError,
  providerModel,
} from "./provider.ts";
import { addUsage, readUsage } from "./usage.ts";

interface ActiveAttempt {
  controller: AbortController;
  heartbeat: ReturnType<typeof setInterval>;
}

type WithoutEnvelope<T> = T extends unknown
  ? Omit<T, "protocolVersion" | "sessionId" | "sequence">
  : never;
type OutgoingHostMessage = WithoutEnvelope<HostMessage>;

export async function runAgent() {
  const initialConfig = await readConfig();
  const token = await getCredential("device-token");
  if (!token) throw new Error("Relay device credential is missing; run relay-host setup.");
  let stopping = false;
  const active = new Map<string, ActiveAttempt>();

  const stop = () => {
    stopping = true;
    for (const attempt of active.values()) attempt.controller.abort("host_stopping");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let backoff = 1000;
  while (!stopping) {
    try {
      await connectOnce(initialConfig.apiUrl, token, active, () => stopping);
      backoff = 1000;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "connection.failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (!stopping) {
      await Bun.sleep(backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  }
}

async function connectOnce(
  apiUrl: string,
  token: string,
  active: Map<string, ActiveAttempt>,
  isStopping: () => boolean,
) {
  const config = await readConfig();
  const providerKey = await getCredential("provider-api-key");
  const adapter = createInferenceAdapter(config.provider, {
    credential: providerKey,
    maxOutputBytes: config.policy.maxResponseBytes,
    maxRssBytes: config.policy.maxRssBytes,
  });
  const advertisedProviderModel = providerModel(config.provider);
  const capabilities: HostCapabilities = {
    protocolVersion: 1,
    models: config.virtualModels.map((virtualModel) => ({
      virtualModel,
      providerModel: advertisedProviderModel,
      contextWindow: config.policy.maxContextTokens,
      maxOutputTokens: config.policy.maxOutputTokens,
      features: {
        chatCompletions: true,
        responses: true,
        tools: config.provider.type === "openai-compatible" && config.allowTools,
      },
    })),
    policy: config.policy,
  };
  const wsUrl = `${apiUrl.replace(/^http/, "ws").replace(/\/$/, "")}/v1/hosts/connect`;
  const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } } as never);
  const sessionId = crypto.randomUUID();
  let sequence = 0;
  let heartbeatSeconds = 5;

  const send = (message: OutgoingHostMessage) => {
    socket.send(
      JSON.stringify({ ...message, protocolVersion: 1, sessionId, sequence: sequence++ }),
    );
  };

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      console.log(
        JSON.stringify({ level: "info", event: "host.connected", donor_id: config.donorId }),
      );
      send({ type: "host.hello", agentVersion: "0.1.1", donorName: config.donorName });
    });
    socket.addEventListener("message", (event) => {
      void (async () => {
        const message = serverMessageSchema.parse(JSON.parse(String(event.data)));
        if (message.type === "host.accepted") {
          heartbeatSeconds = message.heartbeatSeconds;
          if (config.policy.accountOnly && !message.features.accountOnlyScheduling) {
            socket.close(1008, "account-only scheduling is required");
            throw new Error("Relay API does not support required account-only scheduling.");
          }
          send({ type: "host.capabilities", capabilities });
          send({ type: "host.ready" });
          return;
        }
        if (message.type === "lease.cancel") {
          active.get(message.leaseId)?.controller.abort(message.reason);
          return;
        }
        if (message.type === "error") {
          console.error(
            JSON.stringify({ level: "warn", event: "server.message_rejected", code: message.code }),
          );
          return;
        }
        await handleOffer(message, adapter, send, active, heartbeatSeconds);
      })().catch((error) =>
        console.error(
          JSON.stringify({
            level: "error",
            event: "lease.handler_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    });
    socket.addEventListener("error", () => reject(new Error("Relay WebSocket connection failed.")));
    socket.addEventListener("close", () => {
      for (const attempt of active.values()) attempt.controller.abort("relay_disconnected");
      active.clear();
      if (isStopping()) resolve();
      else reject(new Error("Relay WebSocket disconnected."));
    });
  });
}

async function handleOffer(
  offer: Extract<ReturnType<typeof serverMessageSchema.parse>, { type: "lease.offer" }>,
  adapter: InferenceAdapter,
  send: (message: any) => void,
  active: Map<string, ActiveAttempt>,
  heartbeatSeconds: number,
) {
  const config = await readConfig();
  const usage = await readUsage();
  const requestBytes = Buffer.byteLength(JSON.stringify(offer.request));
  const resourceViolation = await localResourceViolation(config);
  if (resourceViolation) await pauseForResourceLimit(config, resourceViolation);
  const policyDenied =
    config.paused ||
    !policyAllowsNow(config.policy) ||
    !quotaAllows(config.policy, usage.jobs, usage.tokens) ||
    requestBytes > config.policy.maxRequestBytes ||
    offer.request.maxOutputTokens > config.policy.maxOutputTokens ||
    offer.request.inputTokensEstimate + offer.request.maxOutputTokens >
      config.policy.maxContextTokens ||
    Boolean(resourceViolation);
  if (policyDenied) {
    send({
      type: "attempt.failed",
      leaseId: offer.leaseId,
      attemptId: offer.attemptId,
      code: "host_policy",
      retryable: true,
      message: "Local donor policy rejected this lease.",
    });
    return;
  }
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void readConfig().then(async (current) => {
      const violation = await localResourceViolation(current);
      if (violation) await pauseForResourceLimit(current, violation);
      if (current.paused || violation) controller.abort("host_paused_or_resource_limit");
      else send({ type: "lease.heartbeat", leaseId: offer.leaseId, attemptId: offer.attemptId });
    });
  }, heartbeatSeconds * 1000);
  active.set(offer.leaseId, { controller, heartbeat });
  send({ type: "lease.accept", leaseId: offer.leaseId, attemptId: offer.attemptId });
  send({ type: "attempt.started", leaseId: offer.leaseId, attemptId: offer.attemptId });
  try {
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(config.policy.maxJobSeconds * 1000),
    ]);
    const result = await adapter.infer(offer.request as CanonicalRequest, signal);
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > config.policy.maxResponseBytes)
      throw new ProviderError(
        "Provider response exceeds the local response buffer.",
        "malformed_response",
        false,
      );
    const contentHash = createHash("sha256").update(serialized).digest("hex");
    send({
      type: "attempt.completed",
      leaseId: offer.leaseId,
      attemptId: offer.attemptId,
      result,
      contentHash,
    });
    await addUsage(result.usage.totalTokens);
  } catch (error) {
    const providerError =
      error instanceof ProviderError
        ? error
        : new ProviderError(
            error instanceof Error ? error.message : "Inference failed.",
            controller.signal.aborted ? "provider_timeout" : "transport",
            true,
          );
    send({
      type: "attempt.failed",
      leaseId: offer.leaseId,
      attemptId: offer.attemptId,
      code: providerError.code,
      retryable: providerError.retryable,
      message: providerError.message.slice(0, 1024),
    });
  } finally {
    clearInterval(heartbeat);
    active.delete(offer.leaseId);
  }
}

async function localResourceViolation(config: HostConfig) {
  if (process.memoryUsage().rss > config.policy.maxRssBytes) return "rss_limit_exceeded";
  if ((await localStateBytes()) > config.policy.maxTemporaryDiskBytes)
    return "temporary_disk_limit_exceeded";
  return undefined;
}

async function pauseForResourceLimit(config: HostConfig, reason: string) {
  if (config.paused) return;
  config.paused = true;
  await writeConfig(config);
  console.error(JSON.stringify({ level: "warn", event: "host.auto_paused", reason }));
}
