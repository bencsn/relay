import { z } from "zod";

const secret = z.string().min(32, "must contain at least 32 characters");
const booleanFromEnv = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() === "true" : value),
  z.boolean(),
);
const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  secret.optional(),
);

export const serverConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:8787"),
  KEY_PEPPER: secret,
  DEVICE_TOKEN_PEPPER: secret,
  WEBHOOK_SIGNING_SECRET: secret,
  METRICS_BEARER_TOKEN: optionalSecret,
  RELAY_BOOTSTRAP_API_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(24).optional(),
  ),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LEASE_SECONDS: z.coerce.number().int().min(10).max(120).default(20),
  HEARTBEAT_SECONDS: z.coerce.number().int().min(2).max(30).default(5),
  SYNC_CAPACITY_WAIT_SECONDS: z.coerce.number().int().min(1).max(30).default(15),
  SYNC_INFERENCE_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(900).default(300),
  RESULT_RETENTION_SECONDS: z.coerce.number().int().min(3600).default(604_800),
  MAX_REQUEST_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(262_144),
  MAX_OUTPUT_BYTES: z.coerce.number().int().min(1024).max(4_194_304).default(1_048_576),
  MAX_CONSUMER_ACTIVE_LEASES: z.coerce.number().int().min(1).max(100).default(3),
  RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  MAX_OUTSTANDING_JOBS_PER_ACCOUNT: z.coerce.number().int().min(1).max(100_000).default(1000),
  MAX_SYNCHRONOUS_REQUESTS_PER_KEY: z.coerce.number().int().min(1).max(100).default(5),
  MAX_SSE_CONNECTIONS_PER_KEY: z.coerce.number().int().min(1).max(1000).default(10),
  REQUIRE_HTTPS: booleanFromEnv.default(false),
  TRUST_PROXY_HEADERS: booleanFromEnv.default(false),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function loadServerConfig(env: Record<string, string | undefined> = process.env) {
  const result = serverConfigSchema.safeParse(env);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid Relay configuration: ${detail}`);
  }
  return result.data;
}

export const defaults = {
  leaseSeconds: 20,
  heartbeatSeconds: 5,
  maxQueueWaitSeconds: 86_400,
  maxQueueWaitCeilingSeconds: 604_800,
  maxAttempts: 3,
  resultRetentionSeconds: 604_800,
  maxConsumerActiveLeases: 3,
  virtualModels: ["community-auto", "community-code", "community-fast"] as const,
};
