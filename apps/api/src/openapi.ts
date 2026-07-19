export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Relay API",
    version: "0.1.1",
    description: "Durable donated inference with OpenAI-compatible synchronous surfaces.",
  },
  servers: [{ url: "/" }],
  paths: {
    "/healthz": { get: { summary: "Process liveness" } },
    "/readyz": { get: { summary: "Database-backed readiness" } },
    "/metrics": { get: { summary: "Bearer-protected Prometheus metrics" } },
    "/v1/models": { get: { summary: "List Relay virtual models" } },
    "/v1/capabilities": { get: { summary: "Describe the supported compatibility subset" } },
    "/v1/chat/completions": { post: { summary: "Create a buffered Chat Completion" } },
    "/v1/responses": { post: { summary: "Create a buffered Response" } },
    "/v1/jobs": { post: { summary: "Create a durable inference job" } },
    "/v1/jobs/{job_id}": {
      get: { summary: "Get job status" },
      delete: { summary: "Cancel a job and erase its prompt/result" },
    },
    "/v1/jobs/{job_id}/events": { get: { summary: "Replay and follow persisted job events" } },
    "/v1/jobs/{job_id}/result": { get: { summary: "Get a terminal result" } },
    "/v1/hosts/pairing-codes": { post: { summary: "Create a one-time donor pairing code" } },
    "/v1/hosts/pair": { post: { summary: "Redeem a donor pairing code" } },
    "/v1/hosts/me": { delete: { summary: "Revoke the current donor credential" } },
    "/v1/webhooks/secret": { get: { summary: "Get the account webhook signing secret" } },
    "/v1/api-keys": {
      get: { summary: "List API keys" },
      post: { summary: "Create a scoped API key" },
    },
    "/v1/api-keys/{api_key_id}": { delete: { summary: "Revoke an API key" } },
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  },
  security: [{ bearerAuth: [] }],
} as const;
