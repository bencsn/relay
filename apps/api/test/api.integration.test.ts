import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadServerConfig } from "@relay/config";
import {
  bootstrapAccount,
  connectDatabase,
  createPairingCode,
  type Database,
  getJobEvents,
  migrate,
  redeemPairingCode,
} from "@relay/db";
import { MockDonor } from "@relay/testkit";
import OpenAI from "openai";
import { createApp } from "../src/app.ts";
import { createLogger } from "../src/logger.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.serial : describe.skip;
const keyPepper = "api-integration-key-pepper-32-characters";
const devicePepper = "api-integration-device-pepper-32-chars";
let sql: Database;

const config = loadServerConfig({
  DATABASE_URL: databaseUrl ?? "postgres://unused",
  PORT: "8787",
  PUBLIC_BASE_URL: "http://relay.test",
  KEY_PEPPER: keyPepper,
  DEVICE_TOKEN_PEPPER: devicePepper,
  WEBHOOK_SIGNING_SECRET: "api-integration-webhook-secret-32-chars",
  METRICS_BEARER_TOKEN: "api-integration-metrics-token-32-chars",
  SYNC_CAPACITY_WAIT_SECONDS: "2",
  SYNC_INFERENCE_TIMEOUT_SECONDS: "10",
  RATE_LIMIT_REQUESTS_PER_MINUTE: "1000",
});

beforeAll(async () => {
  if (!databaseUrl) return;
  sql = connectDatabase(databaseUrl);
  await migrate(sql);
  await sql`
    DELETE FROM jobs WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE 'api-%')
      OR id IN (
        SELECT job_id FROM attempts
        WHERE donor_id IN (SELECT id FROM donors WHERE account_id IN (
          SELECT id FROM accounts WHERE name LIKE 'api-%'
        ))
      )
  `;
  await sql`DELETE FROM accounts WHERE name LIKE 'api-%'`;
});

afterAll(async () => {
  if (sql) await sql.end();
});

async function context() {
  const suffix = crypto.randomUUID();
  const account = await bootstrapAccount(
    sql,
    keyPepper,
    `api-${suffix}`,
    `lr_test_${suffix}_${"a".repeat(24)}`,
  );
  const pairingCode = await createPairingCode(sql, devicePepper, account.accountId);
  const paired = await redeemPairingCode(sql, devicePepper, pairingCode, `api-donor-${suffix}`);
  if (!paired) throw new Error("Failed to create API test donor");
  const donor = new MockDonor(sql, paired.donorId);
  await donor.connect();
  const app = createApp({ config, sql, logger: createLogger("error") });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    return await app.fetch(request);
  };
  return { account, donor, app, fetch };
}

async function donateNext<T>(
  donor: MockDonor,
  action: () => Promise<T>,
  text = "SDK-compatible result",
) {
  let stopped = false;
  const donation = (async () => {
    while (!stopped) {
      const offer = await donor.claim();
      if (offer) {
        await donor.complete(offer, text);
        return;
      }
      await Bun.sleep(10);
    }
  })();
  try {
    return await action();
  } finally {
    stopped = true;
    await donation;
  }
}

integration("HTTP API and compatibility clients", () => {
  test("protects prompt-free operational metrics", async () => {
    const testContext = await context();
    expect((await testContext.app.request("/metrics")).status).toBe(401);
    const response = await testContext.app.request("/metrics", {
      headers: { authorization: "Bearer api-integration-metrics-token-32-chars" },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("relay_jobs");
    expect(body).toContain("relay_oldest_queued_job_seconds");
    expect(body).not.toContain("integration prompt");
  });

  test("authenticates, isolates ownership, preserves idempotency, and replays SSE", async () => {
    const first = await context();
    const unauthorized = await first.app.request("/v1/models");
    expect(unauthorized.status).toBe(401);

    const issuedResponse = await first.app.request("/v1/api-keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${first.account.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scopes: ["jobs:read"] }),
    });
    expect(issuedResponse.status).toBe(201);
    const issued = (await issuedResponse.json()) as { id: string; key: string };
    expect(
      (
        await first.app.request("/v1/api-keys", {
          method: "DELETE",
          headers: { authorization: `Bearer ${issued.key}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await first.app.request(`/v1/api-keys/${issued.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${first.account.key}` },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await first.app.request("/v1/models", {
          headers: { authorization: `Bearer ${issued.key}` },
        })
      ).status,
    ).toBe(401);

    const payload = {
      request: {
        api: "chat.completions",
        body: {
          model: "community-auto",
          messages: [{ role: "user", content: "durable job" }],
        },
      },
      queue: { max_wait_seconds: 3600 },
    };
    const submit = () =>
      first.app.request("/v1/jobs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${first.account.key}`,
          "content-type": "application/json",
          "idempotency-key": "api-integration-idempotency",
        },
        body: JSON.stringify(payload),
      });
    const response = await submit();
    expect(response.status).toBe(202);
    const accepted = (await response.json()) as { id: string };
    const replay = await submit();
    expect((await replay.json()).id).toBe(accepted.id);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");

    const second = await context();
    expect(
      (
        await second.app.request(`/v1/jobs/${accepted.id}`, {
          headers: { authorization: `Bearer ${second.account.key}` },
        })
      ).status,
    ).toBe(404);

    await first.donor.runOne("durable result");
    const events = await getJobEvents(sql, first.account.accountId, accepted.id);
    const eventResponse = await first.app.request(`/v1/jobs/${accepted.id}/events`, {
      headers: {
        authorization: `Bearer ${first.account.key}`,
        "last-event-id": String(events[0]?.id ?? 0),
      },
    });
    const replayed = await eventResponse.text();
    expect(replayed).not.toContain("event: job.queued");
    expect(replayed).toContain("event: job.succeeded");
    expect(replayed).toContain("id:");
  });

  test("rejects private webhook URLs before persisting", async () => {
    const current = await context();
    const response = await current.app.request("/v1/jobs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${current.account.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        request: {
          api: "chat.completions",
          body: { model: "community-auto", messages: [{ role: "user", content: "no SSRF" }] },
        },
        webhook_url: "https://127.0.0.1/admin",
      }),
    });
    expect(response.status).toBe(400);

    const oversized = await current.app.request("/v1/jobs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${current.account.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(config.MAX_REQUEST_BYTES) }),
    });
    expect(oversized.status).toBe(413);
  });

  test("works through the current standard OpenAI SDK", async () => {
    const current = await context();
    const client = new OpenAI({
      apiKey: current.account.key,
      baseURL: "http://relay.test/v1",
      fetch: current.fetch,
    });
    const completion = await donateNext(current.donor, () =>
      client.chat.completions.create({
        model: "community-auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    expect(completion.choices[0]?.message.content).toBe("SDK-compatible result");

    const stream = await donateNext(current.donor, () =>
      client.chat.completions.create({
        model: "community-auto",
        messages: [{ role: "user", content: "stream" }],
        stream: true,
      }),
    );
    let streamed = "";
    for await (const chunk of stream) streamed += chunk.choices[0]?.delta.content ?? "";
    expect(streamed).toBe("SDK-compatible result");

    const response = await donateNext(current.donor, () =>
      client.responses.create({ model: "community-auto", input: "responses test", store: false }),
    );
    expect(response.output_text).toBe("SDK-compatible result");
  });
});
