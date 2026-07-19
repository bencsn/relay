import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const virtualModels = ["community-auto", "community-code", "community-fast"] as const;
export const virtualModelSchema = z.enum(virtualModels);
export type VirtualModel = z.infer<typeof virtualModelSchema>;

export const jobStatuses = [
  "queued",
  "matching",
  "leased",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
] as const;
export const terminalJobStatuses = ["succeeded", "failed", "expired", "cancelled"] as const;
export const jobStatusSchema = z.enum(jobStatuses);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const textContentPartSchema = z.object({ type: z.literal("text"), text: z.string() });
export const chatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(textContentPartSchema), z.null()]),
  name: z.string().min(1).max(64).optional(),
  tool_call_id: z.string().optional(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const functionToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1).max(64),
    description: z.string().max(4096).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

export const chatCompletionRequestSchema = z.strictObject({
  model: virtualModelSchema,
  messages: z.array(chatMessageSchema).min(1).max(256),
  max_tokens: z.number().int().min(1).max(32_768).optional(),
  max_completion_tokens: z.number().int().min(1).max(32_768).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().default(false),
  n: z.literal(1).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  tools: z.array(functionToolSchema).max(64).optional(),
  tool_choice: z
    .union([
      z.literal("none"),
      z.literal("auto"),
      z.literal("required"),
      z.record(z.string(), z.unknown()),
    ])
    .optional(),
  response_format: z.record(z.string(), z.unknown()).optional(),
  seed: z.number().int().optional(),
  user: z.string().max(128).optional(),
});
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

const responseInputTextSchema = z.object({
  type: z.enum(["input_text", "text"]),
  text: z.string(),
});
const responseInputMessageSchema = z.object({
  type: z.literal("message").optional(),
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: z.union([z.string(), z.array(responseInputTextSchema)]),
});
const functionCallOutputSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.union([z.string(), z.record(z.string(), z.unknown())]),
});

export const responsesRequestSchema = z.strictObject({
  model: virtualModelSchema,
  input: z.union([
    z.string(),
    z.array(z.union([responseInputMessageSchema, functionCallOutputSchema])),
  ]),
  instructions: z.string().max(100_000).optional(),
  max_output_tokens: z.number().int().min(1).max(32_768).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().default(false),
  store: z.boolean().optional(),
  tools: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
  tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  reasoning: z.record(z.string(), z.unknown()).optional(),
  include: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  truncation: z.enum(["auto", "disabled"]).optional(),
  prompt_cache_key: z.string().optional(),
});
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

export const durableJobRequestSchema = z.object({
  request: z.discriminatedUnion("api", [
    z.object({ api: z.literal("chat.completions"), body: chatCompletionRequestSchema }),
    z.object({ api: z.literal("responses"), body: responsesRequestSchema }),
  ]),
  queue: z
    .object({ max_wait_seconds: z.number().int().min(1).max(604_800).default(86_400) })
    .default({ max_wait_seconds: 86_400 }),
  webhook_url: z.string().url().max(2048).optional(),
});
export type DurableJobRequest = z.infer<typeof durableJobRequestSchema>;

export const canonicalToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const canonicalRequestSchema = z.object({
  api: z.enum(["chat.completions", "responses"]),
  model: virtualModelSchema,
  messages: z.array(chatMessageSchema).min(1),
  maxOutputTokens: z.number().int().min(1).max(32_768),
  inputTokensEstimate: z.number().int().nonnegative(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  tools: z.array(canonicalToolSchema).optional(),
  toolChoice: z.unknown().optional(),
});
export type CanonicalRequest = z.infer<typeof canonicalRequestSchema>;

export const canonicalToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
});
export const canonicalResultSchema = z.object({
  providerModel: z.string(),
  outputText: z.string(),
  finishReason: z.enum(["stop", "length", "tool_calls", "content_filter", "error"]).default("stop"),
  toolCalls: z.array(canonicalToolCallSchema).optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }),
});
export type CanonicalResult = z.infer<typeof canonicalResultSchema>;

export const hostPolicySchema = z.object({
  accountOnly: z.boolean().default(false),
  maxConcurrency: z.number().int().min(1).max(32).default(1),
  maxRequestBytes: z.number().int().min(1024).max(1_048_576).default(262_144),
  maxResponseBytes: z.number().int().min(1024).max(4_194_304).default(1_048_576),
  maxContextTokens: z.number().int().min(256).max(2_000_000).default(32_768),
  maxOutputTokens: z.number().int().min(1).max(32_768).default(4096),
  maxJobSeconds: z.number().int().min(1).max(3600).default(300),
  maxJobsPerDay: z.number().int().min(1).max(100_000).default(100),
  maxTokensPerDay: z.number().int().min(1).max(1_000_000_000).default(500_000),
  maxRssBytes: z.number().int().min(16_777_216).default(536_870_912),
  maxTemporaryDiskBytes: z.number().int().min(1_048_576).default(268_435_456),
  schedule: z
    .object({
      timezone: z.string().default("UTC"),
      windows: z
        .array(
          z.object({
            days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).min(1),
            start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
            end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          }),
        )
        .default([]),
    })
    .default({ timezone: "UTC", windows: [] }),
});
export type HostPolicy = z.infer<typeof hostPolicySchema>;

export const hostCapabilitiesSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  models: z
    .array(
      z.object({
        virtualModel: virtualModelSchema,
        providerModel: z.string().min(1).max(256),
        contextWindow: z.number().int().min(256).max(2_000_000),
        maxOutputTokens: z.number().int().min(1).max(32_768),
        features: z.object({
          chatCompletions: z.boolean(),
          responses: z.boolean(),
          tools: z.boolean(),
        }),
      }),
    )
    .min(1)
    .max(32),
  policy: hostPolicySchema,
});
export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

const clientEnvelope = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
});
export const hostMessageSchema = z.discriminatedUnion("type", [
  clientEnvelope.extend({
    type: z.literal("host.hello"),
    agentVersion: z.string(),
    donorName: z.string().max(128),
  }),
  clientEnvelope.extend({
    type: z.literal("host.capabilities"),
    capabilities: hostCapabilitiesSchema,
  }),
  clientEnvelope.extend({ type: z.literal("host.ready") }),
  clientEnvelope.extend({
    type: z.literal("lease.accept"),
    leaseId: z.string(),
    attemptId: z.string(),
  }),
  clientEnvelope.extend({
    type: z.literal("lease.heartbeat"),
    leaseId: z.string(),
    attemptId: z.string(),
  }),
  clientEnvelope.extend({
    type: z.literal("attempt.started"),
    leaseId: z.string(),
    attemptId: z.string(),
  }),
  clientEnvelope.extend({
    type: z.literal("attempt.completed"),
    leaseId: z.string(),
    attemptId: z.string(),
    result: canonicalResultSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  clientEnvelope.extend({
    type: z.literal("attempt.failed"),
    leaseId: z.string(),
    attemptId: z.string(),
    code: z.enum([
      "provider_validation",
      "provider_content",
      "provider_timeout",
      "provider_overloaded",
      "transport",
      "malformed_response",
      "host_policy",
    ]),
    retryable: z.boolean(),
    message: z.string().max(1024),
  }),
]);
export type HostMessage = z.infer<typeof hostMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("host.accepted"),
    sessionId: z.string().uuid(),
    heartbeatSeconds: z.number().int(),
    features: z
      .object({ accountOnlyScheduling: z.boolean() })
      .default({ accountOnlyScheduling: false }),
  }),
  z.object({
    type: z.literal("lease.offer"),
    leaseId: z.string(),
    attemptId: z.string(),
    expiresAt: z.string().datetime(),
    request: canonicalRequestSchema,
  }),
  z.object({ type: z.literal("lease.cancel"), leaseId: z.string(), reason: z.string() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function newId(prefix: "job" | "attempt" | "lease" | "event" | "donor") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
