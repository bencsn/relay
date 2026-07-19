import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CanonicalRequest } from "@relay/protocol";
import { deterministicResult, MockDonor, mockCapabilities } from "@relay/testkit";
import {
  bootstrapAccount,
  claimWebhookDelivery,
  commitAttempt,
  connectDatabase,
  createJob,
  createPairingCode,
  type Database,
  deleteJobContents,
  expireQueuedJobs,
  finishWebhookDelivery,
  getJob,
  getJobEvents,
  migrate,
  purgeExpiredResults,
  reclaimExpiredLeases,
  redeemPairingCode,
  setAccountStatus,
} from "../src/index.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.serial : describe.skip;
let sql: Database;
const keyPepper = "integration-key-pepper-with-32-characters";
const devicePepper = "integration-device-pepper-32-characters";

const request: CanonicalRequest = {
  api: "chat.completions",
  model: "community-code",
  messages: [{ role: "user", content: "integration prompt" }],
  maxOutputTokens: 100,
  inputTokensEstimate: 20,
};
const dbCapabilities = mockCapabilities({
  models: [
    {
      virtualModel: "community-code",
      providerModel: "mock-code-model",
      contextWindow: 32_768,
      maxOutputTokens: 4096,
      features: { chatCompletions: true, responses: true, tools: true },
    },
  ],
});

beforeAll(async () => {
  if (!databaseUrl) return;
  sql = connectDatabase(databaseUrl);
  await migrate(sql);
  await sql`
    DELETE FROM jobs WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE 'integration-%')
      OR id IN (
        SELECT job_id FROM attempts
        WHERE donor_id IN (SELECT id FROM donors WHERE account_id IN (
          SELECT id FROM accounts WHERE name LIKE 'integration-%'
        ))
      )
  `;
  await sql`DELETE FROM accounts WHERE name LIKE 'integration-%'`;
});

afterAll(async () => {
  if (sql) await sql.end();
});

async function setup() {
  const suffix = crypto.randomUUID();
  const account = await bootstrapAccount(
    sql,
    keyPepper,
    `integration-${suffix}`,
    `lr_test_${suffix}_${"x".repeat(24)}`,
  );
  const pair = await createPairingCode(sql, devicePepper, account.accountId);
  const donor = await redeemPairingCode(sql, devicePepper, pair, `donor-${suffix}`);
  if (!donor) throw new Error("Could not create integration donor");
  return { ...account, donor };
}

integration("PostgreSQL durability and failover", () => {
  test("queues with zero donors, preserves idempotency, then completes later", async () => {
    const context = await setup();
    const input = {
      accountId: context.accountId,
      apiKeyId: context.id,
      idempotencyKey: "same-logical-request",
      request,
      requestBytes: 128,
      maxWaitSeconds: 3600,
    };
    const first = await createJob(sql, input);
    const replay = await createJob(sql, { ...input, maxOutstandingJobs: 1 });
    expect(first.created).toBeTrue();
    expect(replay.created).toBeFalse();
    expect(replay.job.id).toBe(first.job.id);
    expect((await getJob(sql, context.accountId, first.job.id))?.status).toBe("queued");

    const donor = new MockDonor(sql, context.donor.donorId, dbCapabilities);
    await donor.connect();
    const offer = await donor.runOne("completed after donor connected");
    expect(offer?.jobId).toBe(first.job.id);
    const completed = await getJob(sql, context.accountId, first.job.id);
    expect(completed?.status).toBe("succeeded");
    expect(completed?.result?.outputText).toBe("completed after donor connected");
    const [usage] = await sql<{ jobs: number; tokens: number }[]>`
      SELECT jobs, tokens::int AS tokens FROM donor_usage
      WHERE donor_id = ${context.donor.donorId} AND usage_date = current_date
    `;
    expect(usage?.jobs).toBe(1);
    expect(usage?.tokens).toBeGreaterThan(0);
    const events = await getJobEvents(sql, context.accountId, first.job.id);
    expect(events.map((event) => event.event_type)).toEqual([
      "job.queued",
      "job.leased",
      "job.running",
      "job.succeeded",
    ]);
  });

  test("reassigns an expired lease and rejects the late completion", async () => {
    const context = await setup();
    const secondPair = await createPairingCode(sql, devicePepper, context.accountId);
    const donorB = await redeemPairingCode(sql, devicePepper, secondPair, "donor-b");
    if (!donorB) throw new Error("Could not create second donor");
    const created = await createJob(sql, {
      accountId: context.accountId,
      apiKeyId: context.id,
      request,
      requestBytes: 128,
      maxWaitSeconds: 3600,
    });
    const capabilities = dbCapabilities;
    const firstDonor = new MockDonor(sql, context.donor.donorId, capabilities);
    await firstDonor.connect();
    const offerA = await firstDonor.claim(0.05);
    expect(offerA?.jobId).toBe(created.job.id);
    await Bun.sleep(80);
    expect(await reclaimExpiredLeases(sql)).toBe(1);
    const donor = new MockDonor(sql, donorB.donorId, capabilities);
    await donor.connect();
    const offerB = await donor.claim();
    if (!offerA || !offerB) throw new Error("Expected both failover offers");
    expect(await donor.complete(offerB, "winner")).toBe("committed");

    const lateResult = deterministicResult(offerA.request, "late loser");
    const lateHash = createHash("sha256").update(JSON.stringify(lateResult)).digest("hex");
    expect(
      await commitAttempt(
        sql,
        context.donor.donorId,
        offerA.leaseId,
        offerA.attemptId,
        lateResult,
        lateHash,
        604_800,
      ),
    ).toBe("late_or_invalid");
    const [commits] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM attempts WHERE job_id = ${created.job.id} AND committed
    `;
    expect(commits?.count).toBe(1);
    expect((await getJob(sql, context.accountId, created.job.id))?.result?.outputText).toBe(
      "winner",
    );
  });

  test("erases cancelled content and expires queued jobs", async () => {
    const context = await setup();
    const cancelled = await createJob(sql, {
      accountId: context.accountId,
      apiKeyId: context.id,
      request,
      requestBytes: 128,
      maxWaitSeconds: 3600,
    });
    await deleteJobContents(sql, context.accountId, cancelled.job.id);
    const deleted = await getJob(sql, context.accountId, cancelled.job.id);
    expect(deleted?.status).toBe("cancelled");
    expect(deleted?.canonical_request).toBeNull();

    const expiring = await createJob(sql, {
      accountId: context.accountId,
      apiKeyId: context.id,
      request,
      requestBytes: 128,
      maxWaitSeconds: 0.02,
    });
    await Bun.sleep(40);
    expect(await expireQueuedJobs(sql)).toBeGreaterThanOrEqual(1);
    expect((await getJob(sql, context.accountId, expiring.job.id))?.status).toBe("expired");
  });

  test("persists webhook retries independently of the job result", async () => {
    const context = await setup();
    const created = await createJob(sql, {
      accountId: context.accountId,
      apiKeyId: context.id,
      request,
      requestBytes: 128,
      maxWaitSeconds: 3600,
      webhookUrl: "https://consumer.example/relay",
    });
    const donor = new MockDonor(sql, context.donor.donorId, dbCapabilities);
    await donor.connect();
    await donor.runOne("webhook result");
    const first = await claimWebhookDelivery(sql);
    expect(first?.job_id).toBe(created.job.id);
    if (!first) throw new Error("Expected webhook delivery");
    await finishWebhookDelivery(sql, first.id, false, "injected failure");
    const [retry] = await sql<{ status: string; attempt_count: number }[]>`
      UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = ${first.id}
      RETURNING status, attempt_count
    `;
    expect(retry).toEqual({ status: "pending", attempt_count: 1 });
    const second = await claimWebhookDelivery(sql);
    expect(second?.id).toBe(first.id);
    if (!second) throw new Error("Expected retried webhook delivery");
    await finishWebhookDelivery(sql, second.id, true);
    const [delivered] = await sql<{ status: string }[]>`
      SELECT status FROM webhook_deliveries WHERE id = ${first.id}
    `;
    expect(delivered?.status).toBe("delivered");
    expect((await getJob(sql, context.accountId, created.job.id))?.result?.outputText).toBe(
      "webhook result",
    );
  });

  test("erases retained successful payloads without losing terminal state", async () => {
    const context = await setup();
    const created = await createJob(sql, {
      accountId: context.accountId,
      apiKeyId: context.id,
      request,
      requestBytes: 128,
      maxWaitSeconds: 3600,
    });
    const donor = new MockDonor(sql, context.donor.donorId, dbCapabilities);
    await donor.connect();
    await donor.runOne("short-lived result");
    await sql`UPDATE jobs SET result_expires_at = now() - interval '1 second' WHERE id = ${created.job.id}`;
    expect(await purgeExpiredResults(sql)).toBeGreaterThanOrEqual(1);
    const retained = await getJob(sql, context.accountId, created.job.id);
    expect(retained?.status).toBe("succeeded");
    expect(retained?.result).toBeNull();
    expect(retained?.canonical_request).toBeNull();
    expect(retained?.deleted_at).not.toBeNull();
  });

  test("suspends an account as an immediate scheduling kill switch", async () => {
    const consumer = await setup();
    const provider = await setup();
    const donor = new MockDonor(sql, provider.donor.donorId, dbCapabilities);
    await donor.connect();
    await createJob(sql, {
      accountId: consumer.accountId,
      apiKeyId: consumer.id,
      request,
      requestBytes: 128,
      maxWaitSeconds: 3600,
    });
    expect(await setAccountStatus(sql, consumer.accountId, "suspended")).toBeTrue();
    expect(await donor.claim()).toBeNull();
  });

  test("keeps account-only donor capacity inside the pairing account", async () => {
    const otherAccount = await setup();
    const donorAccount = await setup();
    const otherJob = await createJob(sql, {
      accountId: otherAccount.accountId,
      apiKeyId: otherAccount.id,
      request,
      requestBytes: 128,
      maxWaitSeconds: 3600,
    });
    const ownJob = await createJob(sql, {
      accountId: donorAccount.accountId,
      apiKeyId: donorAccount.id,
      request,
      requestBytes: 128,
      maxWaitSeconds: 3600,
    });
    const restrictedCapabilities = structuredClone(dbCapabilities);
    restrictedCapabilities.policy.accountOnly = true;
    const donor = new MockDonor(sql, donorAccount.donor.donorId, restrictedCapabilities);
    await donor.connect();
    const offer = await donor.claim();
    expect(offer?.jobId).toBe(ownJob.job.id);
    expect((await getJob(sql, otherAccount.accountId, otherJob.job.id))?.status).toBe("queued");
  });
});
