import { createHmac, randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  CanonicalRequest,
  CanonicalResult,
  HostCapabilities,
  JobStatus,
} from "@relay/protocol";
import { newId } from "@relay/protocol";
import { matchRequest, policyAllowsNow, quotaAllows, retryDecision } from "@relay/scheduler";
import postgres, { type Sql } from "postgres";

export type Database = Sql<Record<string, postgres.PostgresType>>;
type Queryable = Database | postgres.TransactionSql<Record<string, postgres.PostgresType>>;

function json(value: unknown) {
  return value as postgres.JSONValue;
}

export function connectDatabase(
  url: string,
  options: postgres.Options<Record<string, postgres.PostgresType>> = {},
) {
  return postgres(url, { max: 10, idle_timeout: 20, connect_timeout: 10, ...options });
}

export async function migrate(sql: Database, migrationsDirectory?: string) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const directory =
    migrationsDirectory ??
    ((await Bun.file(`${process.cwd()}/migrations/001_initial.sql`).exists())
      ? `${process.cwd()}/migrations`
      : fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const files = (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  for (const file of files) {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('relay_schema_migrations'))`;
      const applied = await tx`SELECT 1 FROM schema_migrations WHERE version = ${file}`;
      if (applied.length) return;
      const source = await Bun.file(`${directory}/${file}`).text();
      await tx.unsafe(source);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
    });
  }
}

function digest(secret: string, value: string) {
  // API and device tokens contain at least 144 bits of CSPRNG entropy; this is a
  // keyed lookup digest, not a human password hash, so a fast HMAC is intentional.
  // codeql[js/insufficient-password-hash]
  return createHmac("sha256", secret).update(value).digest("hex");
}

function token(prefix: string, bytes = 32) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export interface AuthContext {
  accountId: string;
  apiKeyId: string;
  scopes: string[];
  keyPrefix: string;
}

export async function issueApiKey(
  sql: Database,
  keyPepper: string,
  accountId: string,
  scopes = ["jobs:read", "jobs:write", "hosts:pair", "keys:write"],
  suppliedKey?: string,
) {
  const raw = suppliedKey ?? token("lr_live");
  const keyPrefix = raw.slice(0, 16);
  const id = crypto.randomUUID();
  const [stored] = await sql<{ id: string }[]>`
    INSERT INTO api_keys (id, account_id, key_prefix, key_hash, scopes)
    VALUES (${id}, ${accountId}, ${keyPrefix}, ${digest(keyPepper, raw)}, ${scopes})
    ON CONFLICT (key_hash) DO UPDATE SET revoked_at = NULL, scopes = EXCLUDED.scopes
    RETURNING id
  `;
  if (!stored) throw new Error("Failed to issue API key");
  return { id: stored.id, key: raw, prefix: keyPrefix };
}

export async function bootstrapAccount(
  sql: Database,
  keyPepper: string,
  name: string,
  suppliedKey?: string,
) {
  let [account] = await sql<
    { id: string }[]
  >`SELECT id FROM accounts WHERE name = ${name} ORDER BY created_at LIMIT 1`;
  if (!account) {
    const id = crypto.randomUUID();
    [account] = await sql<
      { id: string }[]
    >`INSERT INTO accounts (id, name) VALUES (${id}, ${name}) RETURNING id`;
  }
  if (!account) throw new Error("Failed to create bootstrap account");
  const apiKey = await issueApiKey(
    sql,
    keyPepper,
    account.id,
    ["jobs:read", "jobs:write", "hosts:pair", "keys:write"],
    suppliedKey,
  );
  return { accountId: account.id, ...apiKey };
}

export async function authenticateApiKey(
  sql: Database,
  keyPepper: string,
  raw: string,
): Promise<AuthContext | null> {
  const [row] = await sql<
    { account_id: string; api_key_id: string; scopes: string[]; key_prefix: string }[]
  >`
    SELECT a.id AS account_id, k.id AS api_key_id, k.scopes, k.key_prefix
    FROM api_keys k JOIN accounts a ON a.id = k.account_id
    WHERE k.key_hash = ${digest(keyPepper, raw)} AND k.revoked_at IS NULL AND a.status = 'active'
  `;
  if (!row) return null;
  void sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.api_key_id}`;
  return {
    accountId: row.account_id,
    apiKeyId: row.api_key_id,
    scopes: row.scopes,
    keyPrefix: row.key_prefix,
  };
}

export async function revokeApiKey(sql: Database, accountId: string, apiKeyId: string) {
  const result =
    await sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${apiKeyId} AND account_id = ${accountId}`;
  return result.count === 1;
}

export async function listApiKeys(sql: Database, accountId: string) {
  return sql<
    {
      id: string;
      key_prefix: string;
      scopes: string[];
      created_at: Date;
      last_used_at: Date | null;
    }[]
  >`
    SELECT id, key_prefix, scopes, created_at, last_used_at
    FROM api_keys WHERE account_id = ${accountId} AND revoked_at IS NULL
    ORDER BY created_at DESC
  `;
}

export async function createPairingCode(
  sql: Database,
  devicePepper: string,
  accountId: string,
  ttlSeconds = 600,
) {
  const code = token("pair", 18);
  await sql`
    INSERT INTO pairing_codes (id, account_id, code_hash, expires_at)
    VALUES (${crypto.randomUUID()}, ${accountId}, ${digest(devicePepper, code)}, now() + (${ttlSeconds} * interval '1 second'))
  `;
  return code;
}

export async function redeemPairingCode(
  sql: Database,
  devicePepper: string,
  code: string,
  donorName: string,
) {
  return sql.begin(async (tx) => {
    const [pairing] = await tx<{ id: string; account_id: string }[]>`
      SELECT id, account_id FROM pairing_codes
      WHERE code_hash = ${digest(devicePepper, code)} AND used_at IS NULL AND expires_at > now()
      FOR UPDATE
    `;
    if (!pairing) return null;
    const donorId = newId("donor");
    const rawToken = token("lrd_live");
    await tx`UPDATE pairing_codes SET used_at = now() WHERE id = ${pairing.id}`;
    await tx`
      INSERT INTO donors (id, account_id, name, token_prefix, token_hash)
      VALUES (${donorId}, ${pairing.account_id}, ${donorName}, ${rawToken.slice(0, 17)}, ${digest(devicePepper, rawToken)})
    `;
    return { donorId, deviceToken: rawToken };
  });
}

export async function authenticateDonor(sql: Database, devicePepper: string, raw: string) {
  const [row] = await sql<{ id: string; account_id: string; name: string }[]>`
    SELECT d.id, d.account_id, d.name FROM donors d JOIN accounts a ON a.id = d.account_id
    WHERE d.token_hash = ${digest(devicePepper, raw)} AND d.status <> 'revoked' AND a.status = 'active'
  `;
  return row ?? null;
}

export async function setAccountStatus(
  sql: Database,
  accountId: string,
  status: "active" | "suspended",
) {
  return sql.begin(async (tx) => {
    const updated = await tx`UPDATE accounts SET status = ${status} WHERE id = ${accountId}`;
    if (updated.count !== 1) return false;
    if (status === "suspended") {
      await tx`
        UPDATE leases SET expires_at = now()
        WHERE status = 'active' AND (
          donor_id IN (SELECT id FROM donors WHERE account_id = ${accountId})
          OR job_id IN (SELECT id FROM jobs WHERE account_id = ${accountId})
        )
      `;
      await tx`
        UPDATE donors SET status = 'offline'
        WHERE account_id = ${accountId} AND status <> 'revoked'
      `;
    }
    return true;
  });
}

export async function updateDonorPresence(
  sql: Database,
  donorId: string,
  capabilities: HostCapabilities,
  status: "online" | "paused" = "online",
) {
  await sql`
    UPDATE donors SET status = ${status}, capabilities = ${sql.json(capabilities)}, policy = ${sql.json(capabilities.policy)}, last_seen_at = now()
    WHERE id = ${donorId} AND status <> 'revoked'
      AND EXISTS (SELECT 1 FROM accounts WHERE id = donors.account_id AND status = 'active')
  `;
}

export async function touchDonor(sql: Database, donorId: string) {
  await sql`UPDATE donors SET last_seen_at = now() WHERE id = ${donorId} AND status = 'online'`;
}

export async function markDonorOffline(sql: Database, donorId: string) {
  await sql`UPDATE donors SET status = 'offline' WHERE id = ${donorId} AND status <> 'revoked'`;
}

export async function revokeDonor(sql: Database, donorId: string) {
  return sql.begin(async (tx) => {
    const result =
      await tx`UPDATE donors SET status = 'revoked' WHERE id = ${donorId} AND status <> 'revoked'`;
    await tx`UPDATE leases SET expires_at = now() WHERE donor_id = ${donorId} AND status = 'active'`;
    return result.count === 1;
  });
}

interface CreateJobInput {
  accountId: string;
  apiKeyId: string;
  idempotencyKey?: string;
  request: CanonicalRequest;
  requestBytes: number;
  maxWaitSeconds: number;
  webhookUrl?: string;
  maxOutstandingJobs?: number;
}

export class OutstandingJobLimitError extends Error {}

export async function createJob(sql: Database, input: CreateJobInput) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.accountId}, 0))`;
    if (input.idempotencyKey) {
      const [existing] = await tx<JobRow[]>`
        SELECT * FROM jobs WHERE api_key_id = ${input.apiKeyId} AND idempotency_key = ${input.idempotencyKey}
      `;
      if (existing) return { job: existing, created: false };
    }
    const [outstanding] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM jobs
      WHERE account_id = ${input.accountId} AND status IN ('queued', 'matching', 'leased', 'running', 'retrying')
    `;
    if ((outstanding?.count ?? 0) >= (input.maxOutstandingJobs ?? 1000)) {
      throw new OutstandingJobLimitError("Account has too many outstanding jobs.");
    }
    const id = newId("job");
    const rows = await tx<JobRow[]>`
      INSERT INTO jobs (
        id, account_id, api_key_id, idempotency_key, original_api, virtual_model,
        canonical_request, request_bytes, status, max_wait_at, webhook_url
      ) VALUES (
        ${id}, ${input.accountId}, ${input.apiKeyId}, ${input.idempotencyKey ?? null},
        ${input.request.api}, ${input.request.model}, ${tx.json(json(input.request))}, ${input.requestBytes},
        'queued', now() + (${input.maxWaitSeconds} * interval '1 second'), ${input.webhookUrl ?? null}
      )
      ON CONFLICT (api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING *
    `;
    let job = rows[0];
    if (!job && input.idempotencyKey) {
      [job] = await tx<
        JobRow[]
      >`SELECT * FROM jobs WHERE api_key_id = ${input.apiKeyId} AND idempotency_key = ${input.idempotencyKey}`;
      if (job) return { job, created: false };
    }
    if (!job) throw new Error("Unable to create job");
    await insertEvent(tx, job.id, "job.queued", { status: "queued", attempt: 0 });
    return { job, created: true };
  });
}

export interface JobRow {
  id: string;
  account_id: string;
  api_key_id: string;
  original_api: "chat.completions" | "responses";
  virtual_model: string;
  canonical_request: CanonicalRequest | null;
  request_bytes: number;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  state_version: number;
  max_wait_at: Date;
  result_expires_at: Date | null;
  webhook_url: string | null;
  result: CanonicalResult | null;
  error: Record<string, unknown> | null;
  deleted_at: Date | null;
  terminal_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function getJob(sql: Database, accountId: string, jobId: string) {
  const [job] = await sql<
    JobRow[]
  >`SELECT * FROM jobs WHERE id = ${jobId} AND account_id = ${accountId}`;
  return job ?? null;
}

export async function getJobInternal(sql: Database, jobId: string) {
  const [job] = await sql<JobRow[]>`SELECT * FROM jobs WHERE id = ${jobId}`;
  return job ?? null;
}

export async function getJobEvents(sql: Database, accountId: string, jobId: string, afterId = 0) {
  return sql<
    { id: number; event_type: string; payload: Record<string, unknown>; created_at: Date }[]
  >`
    SELECT e.id, e.event_type, e.payload, e.created_at
    FROM job_events e JOIN jobs j ON j.id = e.job_id
    WHERE e.job_id = ${jobId} AND j.account_id = ${accountId} AND e.id > ${afterId}
    ORDER BY e.id ASC LIMIT 1000
  `;
}

async function insertEvent(
  tx: Queryable,
  jobId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  const [event] = await tx<{ id: number }[]>`
    INSERT INTO job_events (job_id, event_type, payload) VALUES (${jobId}, ${eventType}, ${tx.json(json(payload))}) RETURNING id
  `;
  if (!event) throw new Error("Failed to persist event");
  return event.id;
}

async function enqueueWebhook(tx: Queryable, job: JobRow, eventId: number) {
  if (!job.webhook_url) return;
  await tx`
    INSERT INTO webhook_deliveries (id, job_id, account_id, event_id, url)
    VALUES (${crypto.randomUUID()}, ${job.id}, ${job.account_id}, ${eventId}, ${job.webhook_url})
  `;
}

export async function deleteJobContents(sql: Database, accountId: string, jobId: string) {
  return sql.begin(async (tx) => {
    const [job] = await tx<
      JobRow[]
    >`SELECT * FROM jobs WHERE id = ${jobId} AND account_id = ${accountId} FOR UPDATE`;
    if (!job) return null;
    await tx`UPDATE leases SET status = 'cancelled' WHERE job_id = ${jobId} AND status = 'active'`;
    await tx`UPDATE attempts SET status = 'cancelled', finished_at = now() WHERE job_id = ${jobId} AND status IN ('offered', 'accepted', 'running')`;
    await tx`
      UPDATE jobs SET status = 'cancelled', canonical_request = NULL, result = NULL,
        error = ${tx.json({ code: "deleted_by_consumer", message: "Job content was deleted by its owner." })},
        webhook_url = NULL, deleted_at = now(), terminal_at = COALESCE(terminal_at, now()), updated_at = now(), state_version = state_version + 1
      WHERE id = ${jobId}
    `;
    await insertEvent(tx, jobId, "job.cancelled", {
      status: "cancelled",
      reason: "deleted_by_consumer",
    });
    return { previousStatus: job.status };
  });
}

export interface LeaseOffer {
  leaseId: string;
  attemptId: string;
  expiresAt: Date;
  request: CanonicalRequest;
  jobId: string;
}

export async function claimNextJob(
  sql: Database,
  donorId: string,
  capabilities: HostCapabilities,
  leaseSeconds: number,
  maxConsumerActiveLeases = 3,
): Promise<LeaseOffer | null> {
  if (!policyAllowsNow(capabilities.policy)) return null;
  return sql.begin(async (tx) => {
    const [eligible] = await tx`
      SELECT 1 FROM donors d JOIN accounts a ON a.id = d.account_id
      WHERE d.id = ${donorId} AND d.status = 'online' AND a.status = 'active'
    `;
    if (!eligible) return null;
    const [usage] = await tx<{ jobs: number; tokens: number }[]>`
      SELECT jobs, tokens FROM donor_usage WHERE donor_id = ${donorId} AND usage_date = current_date
    `;
    if (!quotaAllows(capabilities.policy, usage?.jobs ?? 0, usage?.tokens ?? 0)) return null;
    const [active] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM leases WHERE donor_id = ${donorId} AND status = 'active'
    `;
    if ((active?.count ?? 0) >= capabilities.policy.maxConcurrency) return null;
    const candidates = await tx<JobRow[]>`
      SELECT j.* FROM jobs j JOIN accounts owner ON owner.id = j.account_id
      WHERE j.status IN ('queued', 'retrying') AND j.max_wait_at > now()
        AND owner.status = 'active'
        AND (SELECT count(*) FROM jobs active WHERE active.account_id = j.account_id AND active.status IN ('leased', 'running')) < ${maxConsumerActiveLeases}
      ORDER BY j.created_at ASC, j.id ASC
      FOR UPDATE SKIP LOCKED LIMIT 50
    `;
    const job = candidates.find(
      (candidate) =>
        candidate.canonical_request &&
        matchRequest(candidate.canonical_request, capabilities).compatible,
    );
    if (!job?.canonical_request) return null;
    const jobRequest = job.canonical_request;
    const attemptNumber = job.attempt_count + 1;
    const attemptId = newId("attempt");
    const leaseId = newId("lease");
    await tx`
      INSERT INTO attempts (id, job_id, donor_id, number, status)
      VALUES (${attemptId}, ${job.id}, ${donorId}, ${attemptNumber}, 'offered')
    `;
    const [lease] = await tx<{ expires_at: Date }[]>`
      INSERT INTO leases (id, job_id, attempt_id, donor_id, status, expires_at)
      VALUES (${leaseId}, ${job.id}, ${attemptId}, ${donorId}, 'active', now() + (${leaseSeconds} * interval '1 second'))
      RETURNING expires_at
    `;
    await tx`
      UPDATE jobs SET status = 'leased', attempt_count = ${attemptNumber}, updated_at = now(), state_version = state_version + 1
      WHERE id = ${job.id}
    `;
    await insertEvent(tx, job.id, "job.leased", {
      status: "leased",
      attempt: attemptNumber,
      lease_id: leaseId,
    });
    return {
      leaseId,
      attemptId,
      expiresAt: lease?.expires_at ?? new Date(Date.now() + leaseSeconds * 1000),
      request: jobRequest,
      jobId: job.id,
    };
  });
}

export async function acceptLease(
  sql: Database,
  donorId: string,
  leaseId: string,
  attemptId: string,
) {
  const result = await sql`
    UPDATE attempts a SET status = 'accepted'
    FROM leases l
    WHERE a.id = ${attemptId} AND l.id = ${leaseId} AND l.attempt_id = a.id AND l.donor_id = ${donorId}
      AND l.status = 'active' AND l.expires_at > now() AND a.status = 'offered'
  `;
  return result.count === 1;
}

export async function heartbeatLease(
  sql: Database,
  donorId: string,
  leaseId: string,
  attemptId: string,
  leaseSeconds: number,
) {
  const result = await sql`
    UPDATE leases SET last_heartbeat_at = now(), expires_at = now() + (${leaseSeconds} * interval '1 second')
    WHERE id = ${leaseId} AND attempt_id = ${attemptId} AND donor_id = ${donorId} AND status = 'active' AND expires_at > now()
  `;
  await touchDonor(sql, donorId);
  return result.count === 1;
}

export async function markAttemptStarted(
  sql: Database,
  donorId: string,
  leaseId: string,
  attemptId: string,
) {
  return sql.begin(async (tx) => {
    const [lease] = await tx<{ job_id: string }[]>`
      SELECT job_id FROM leases WHERE id = ${leaseId} AND attempt_id = ${attemptId} AND donor_id = ${donorId}
        AND status = 'active' AND expires_at > now() FOR UPDATE
    `;
    if (!lease) return false;
    const updated = await tx`
      UPDATE attempts SET status = 'running', started_at = COALESCE(started_at, now())
      WHERE id = ${attemptId} AND status IN ('offered', 'accepted')
    `;
    if (updated.count !== 1) return false;
    const [job] = await tx<JobRow[]>`
      UPDATE jobs SET status = 'running', updated_at = now(), state_version = state_version + 1 WHERE id = ${lease.job_id} RETURNING *
    `;
    if (!job) return false;
    await insertEvent(tx, job.id, "job.running", { status: "running", attempt: job.attempt_count });
    return true;
  });
}

export type CompletionOutcome = "committed" | "late_or_invalid" | "already_committed";

export async function commitAttempt(
  sql: Database,
  donorId: string,
  leaseId: string,
  attemptId: string,
  result: CanonicalResult,
  resultHash: string,
  retentionSeconds: number,
): Promise<CompletionOutcome> {
  return sql.begin(async (tx) => {
    const [lease] = await tx<{ job_id: string; status: string; expires_at: Date }[]>`
      SELECT job_id, status, expires_at FROM leases WHERE id = ${leaseId} AND attempt_id = ${attemptId} AND donor_id = ${donorId} FOR UPDATE
    `;
    if (lease?.status !== "active" || lease.expires_at.getTime() <= Date.now())
      return "late_or_invalid";
    const [job] = await tx<JobRow[]>`SELECT * FROM jobs WHERE id = ${lease.job_id} FOR UPDATE`;
    if (!job) return "late_or_invalid";
    if (job.status === "succeeded") return "already_committed";
    if (["failed", "expired", "cancelled"].includes(job.status)) return "late_or_invalid";
    await tx`UPDATE leases SET status = 'completed' WHERE id = ${leaseId}`;
    await tx`
      UPDATE attempts SET status = 'succeeded', result_hash = ${resultHash}, committed = true, finished_at = now()
      WHERE id = ${attemptId}
    `;
    const [updatedJob] = await tx<JobRow[]>`
      UPDATE jobs SET status = 'succeeded', result = ${tx.json(result)}, terminal_at = now(),
        result_expires_at = now() + (${retentionSeconds} * interval '1 second'), updated_at = now(), state_version = state_version + 1
      WHERE id = ${job.id} RETURNING *
    `;
    await tx`
      INSERT INTO donor_usage (donor_id, usage_date, jobs, tokens)
      VALUES (${donorId}, current_date, 1, ${result.usage.totalTokens})
      ON CONFLICT (donor_id, usage_date) DO UPDATE
      SET jobs = donor_usage.jobs + 1, tokens = donor_usage.tokens + EXCLUDED.tokens
    `;
    if (!updatedJob) throw new Error("Failed to commit job result");
    const eventId = await insertEvent(tx, job.id, "job.succeeded", {
      status: "succeeded",
      attempt: job.attempt_count,
      result_url: `/v1/jobs/${job.id}/result`,
    });
    await enqueueWebhook(tx, updatedJob, eventId);
    return "committed";
  });
}

export async function failAttempt(
  sql: Database,
  donorId: string,
  leaseId: string,
  attemptId: string,
  failure: { code: string; message: string; retryable: boolean },
  retentionSeconds = 604_800,
) {
  return sql.begin(async (tx) => {
    const [lease] = await tx<{ job_id: string }[]>`
      SELECT job_id FROM leases WHERE id = ${leaseId} AND attempt_id = ${attemptId} AND donor_id = ${donorId} AND status = 'active' FOR UPDATE
    `;
    if (!lease) return "late_or_invalid" as const;
    const [job] = await tx<JobRow[]>`SELECT * FROM jobs WHERE id = ${lease.job_id} FOR UPDATE`;
    if (!job || ["succeeded", "failed", "expired", "cancelled"].includes(job.status))
      return "late_or_invalid" as const;
    const decision = retryDecision(job.attempt_count, failure.retryable, job.max_attempts);
    const status = decision.retry ? "retrying" : "failed";
    await tx`UPDATE leases SET status = 'failed' WHERE id = ${leaseId}`;
    await tx`
      UPDATE attempts SET status = 'failed', failure_code = ${failure.code}, failure_message = ${failure.message}, finished_at = now()
      WHERE id = ${attemptId}
    `;
    const [updatedJob] = await tx<JobRow[]>`
      UPDATE jobs SET status = ${status}, error = ${tx.json({ code: failure.code, message: failure.message })},
        terminal_at = CASE WHEN ${status} = 'failed' THEN now() ELSE terminal_at END,
        result_expires_at = CASE WHEN ${status} = 'failed'
          THEN now() + (${retentionSeconds} * interval '1 second') ELSE result_expires_at END,
        updated_at = now(), state_version = state_version + 1
      WHERE id = ${job.id} RETURNING *
    `;
    const eventId = await insertEvent(tx, job.id, `job.${status}`, {
      status,
      attempt: job.attempt_count,
      reason: failure.code,
    });
    if (status === "failed" && updatedJob) await enqueueWebhook(tx, updatedJob, eventId);
    return status;
  });
}

export async function reclaimExpiredLeases(sql: Database, retentionSeconds = 604_800) {
  return sql.begin(async (tx) => {
    const leases = await tx<{ id: string; job_id: string; attempt_id: string }[]>`
      SELECT id, job_id, attempt_id FROM leases WHERE status = 'active' AND expires_at <= now()
      ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 100
    `;
    let reclaimed = 0;
    for (const lease of leases) {
      const [job] = await tx<JobRow[]>`SELECT * FROM jobs WHERE id = ${lease.job_id} FOR UPDATE`;
      await tx`UPDATE leases SET status = 'expired' WHERE id = ${lease.id}`;
      await tx`UPDATE attempts SET status = 'expired', failure_code = 'lease_expired', finished_at = now() WHERE id = ${lease.attempt_id} AND status <> 'succeeded'`;
      if (!job || ["succeeded", "failed", "expired", "cancelled"].includes(job.status)) continue;
      const status = job.attempt_count >= job.max_attempts ? "failed" : "retrying";
      const [updatedJob] = await tx<JobRow[]>`
        UPDATE jobs SET status = ${status}, error = ${tx.json({ code: "lease_expired", message: "The donor lease expired before completion." })},
          terminal_at = CASE WHEN ${status} = 'failed' THEN now() ELSE terminal_at END,
          result_expires_at = CASE WHEN ${status} = 'failed'
            THEN now() + (${retentionSeconds} * interval '1 second') ELSE result_expires_at END,
          updated_at = now(), state_version = state_version + 1 WHERE id = ${job.id} RETURNING *
      `;
      const eventId = await insertEvent(tx, job.id, `job.${status}`, {
        status,
        attempt: job.attempt_count,
        reason: "lease_expired",
      });
      if (status === "failed" && updatedJob) await enqueueWebhook(tx, updatedJob, eventId);
      reclaimed += 1;
    }
    return reclaimed;
  });
}

export async function expireQueuedJobs(sql: Database, retentionSeconds = 604_800) {
  return sql.begin(async (tx) => {
    const jobs = await tx<JobRow[]>`
      SELECT * FROM jobs WHERE status IN ('queued', 'retrying') AND max_wait_at <= now()
      FOR UPDATE SKIP LOCKED LIMIT 100
    `;
    for (const job of jobs) {
      const [updatedJob] = await tx<JobRow[]>`
        UPDATE jobs SET status = 'expired', error = ${tx.json({ code: "queue_expired", message: "No compatible donor became available before the queue deadline." })},
          terminal_at = now(), result_expires_at = now() + (${retentionSeconds} * interval '1 second'),
          updated_at = now(), state_version = state_version + 1 WHERE id = ${job.id} RETURNING *
      `;
      const eventId = await insertEvent(tx, job.id, "job.expired", {
        status: "expired",
        attempt: job.attempt_count,
      });
      if (updatedJob) await enqueueWebhook(tx, updatedJob, eventId);
    }
    return jobs.length;
  });
}

export async function purgeExpiredResults(sql: Database) {
  const result = await sql`
    UPDATE jobs SET result = NULL, canonical_request = NULL, deleted_at = COALESCE(deleted_at, now()), updated_at = now()
    WHERE status IN ('succeeded', 'failed', 'expired', 'cancelled')
      AND result_expires_at <= now() AND (result IS NOT NULL OR canonical_request IS NOT NULL)
  `;
  return result.count;
}

export async function countCompatibleHosts(sql: Database, request: CanonicalRequest) {
  const donors = await sql<{ capabilities: HostCapabilities }[]>`
    SELECT capabilities FROM donors WHERE status = 'online' AND last_seen_at > now() - interval '20 seconds' AND capabilities IS NOT NULL
  `;
  return donors.filter((donor) => matchRequest(request, donor.capabilities).compatible).length;
}

export interface WebhookDeliveryRow {
  id: string;
  job_id: string;
  account_id: string;
  event_id: number;
  url: string;
  attempt_count: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export async function claimWebhookDelivery(sql: Database) {
  return sql.begin(async (tx) => {
    const [delivery] = await tx<WebhookDeliveryRow[]>`
      SELECT d.id, d.job_id, d.account_id, d.event_id, d.url, d.attempt_count, e.event_type, e.payload, e.created_at
      FROM webhook_deliveries d JOIN job_events e ON e.id = d.event_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= now()
      ORDER BY d.next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1
    `;
    if (!delivery) return null;
    await tx`UPDATE webhook_deliveries SET status = 'delivering', attempt_count = attempt_count + 1 WHERE id = ${delivery.id}`;
    return delivery;
  });
}

export async function finishWebhookDelivery(
  sql: Database,
  id: string,
  success: boolean,
  error?: string,
) {
  if (success) {
    await sql`UPDATE webhook_deliveries SET status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = ${id}`;
    return;
  }
  const [row] = await sql<
    { attempt_count: number; created_at: Date }[]
  >`SELECT attempt_count, created_at FROM webhook_deliveries WHERE id = ${id}`;
  if (!row) return;
  const age = Date.now() - row.created_at.getTime();
  if (age >= 86_400_000) {
    await sql`UPDATE webhook_deliveries SET status = 'abandoned', last_error = ${error?.slice(0, 1024) ?? "delivery_failed"} WHERE id = ${id}`;
    return;
  }
  const delaySeconds = Math.min(3600, 2 ** Math.min(row.attempt_count, 12));
  await sql`
    UPDATE webhook_deliveries SET status = 'pending', last_error = ${error?.slice(0, 1024) ?? "delivery_failed"},
      next_attempt_at = now() + (${delaySeconds} * interval '1 second') WHERE id = ${id}
  `;
}

export async function resetStuckWebhookDeliveries(sql: Database) {
  const result = await sql`
    UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = now()
    WHERE status = 'delivering' AND next_attempt_at < now() - interval '5 minutes'
  `;
  return result.count;
}
