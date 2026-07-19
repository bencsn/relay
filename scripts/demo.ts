import { createHash } from "node:crypto";
import { loadServerConfig } from "@relay/config";
import {
  bootstrapAccount,
  claimNextJob,
  commitAttempt,
  connectDatabase,
  createJob,
  createPairingCode,
  getJob,
  getJobEvents,
  migrate,
  reclaimExpiredLeases,
  redeemPairingCode,
} from "@relay/db";
import { deterministicResult, MockDonor, mockCapabilities } from "@relay/testkit";

const config = loadServerConfig();
const sql = connectDatabase(config.DATABASE_URL);
try {
  await migrate(sql);
  const suffix = crypto.randomUUID();
  const account = await bootstrapAccount(sql, config.KEY_PEPPER, `relay-demo-${suffix}`);
  const donorIds: string[] = [];
  for (const name of ["demo-donor-a", "demo-donor-b"]) {
    const code = await createPairingCode(sql, config.DEVICE_TOKEN_PEPPER, account.accountId);
    const donor = await redeemPairingCode(sql, config.DEVICE_TOKEN_PEPPER, code, name);
    if (!donor) throw new Error(`Could not create ${name}`);
    donorIds.push(donor.donorId);
  }
  const created = await createJob(sql, {
    accountId: account.accountId,
    apiKeyId: account.id,
    requestBytes: 128,
    maxWaitSeconds: 3600,
    request: {
      api: "chat.completions",
      model: "community-auto",
      messages: [{ role: "user", content: "Demonstrate durable failover" }],
      maxOutputTokens: 100,
      inputTokensEstimate: 10,
    },
  });
  console.log(
    JSON.stringify({
      step: "submitted_with_zero_donors",
      job_id: created.job.id,
      status: created.job.status,
    }),
  );

  const capabilities = mockCapabilities();
  const firstId = donorIds[0];
  const secondId = donorIds[1];
  if (!firstId || !secondId) throw new Error("Demo donors missing");
  const first = new MockDonor(sql, firstId, capabilities);
  await first.connect();
  const abandoned = await claimNextJob(sql, firstId, capabilities, 0.1);
  if (!abandoned) throw new Error("Donor A did not receive the queued job");
  console.log(JSON.stringify({ step: "donor_a_leased", attempt_id: abandoned.attemptId }));
  await Bun.sleep(150);
  await reclaimExpiredLeases(sql);
  console.log(
    JSON.stringify({
      step: "donor_a_lost",
      status: (await getJob(sql, account.accountId, created.job.id))?.status,
    }),
  );

  const second = new MockDonor(sql, secondId, capabilities);
  await second.connect();
  const winner = await second.claim();
  if (!winner) throw new Error("Donor B did not receive the retry");
  await second.complete(winner, "Donor B completed after failover.");

  const late = deterministicResult(abandoned.request, "late donor A result");
  const lateHash = createHash("sha256").update(JSON.stringify(late)).digest("hex");
  const lateOutcome = await commitAttempt(
    sql,
    firstId,
    abandoned.leaseId,
    abandoned.attemptId,
    late,
    lateHash,
    config.RESULT_RETENTION_SECONDS,
  );
  const final = await getJob(sql, account.accountId, created.job.id);
  const events = await getJobEvents(sql, account.accountId, created.job.id);
  const [commits] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM attempts WHERE job_id = ${created.job.id} AND committed
  `;
  console.log(
    JSON.stringify({
      step: "completed",
      status: final?.status,
      result: final?.result?.outputText,
      late_completion: lateOutcome,
      committed_results: commits?.count,
      events: events.map((event) => event.event_type),
    }),
  );
} finally {
  await sql.end();
}
