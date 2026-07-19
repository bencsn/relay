# Relay API

All `/v1` consumer endpoints require `Authorization: Bearer lr_live_...`. Keys are scoped, stored as HMAC digests, and may be rotated or revoked without restarting Relay.

## Durable jobs

Create a job:

```http
POST /v1/jobs
Authorization: Bearer lr_live_...
Idempotency-Key: release-notes-42
Content-Type: application/json
```

```json
{
  "request": {
    "api": "chat.completions",
    "body": {
      "model": "community-auto",
      "messages": [{"role": "user", "content": "Write release notes"}],
      "max_tokens": 2000
    }
  },
  "queue": {"max_wait_seconds": 86400},
  "webhook_url": "https://consumer.example/hooks/relay"
}
```

Relay returns `202 Accepted` even when zero donors are online. The response contains `status_url`, `events_url`, `result_url`, and `expires_at`.

- `GET /v1/jobs/{id}` returns state, attempt number, compatible online hosts, and timestamps.
- `GET /v1/jobs/{id}/result` returns `409 job_not_complete` until terminal, then the canonical result/error.
- `DELETE /v1/jobs/{id}` cancels active work and erases the stored prompt/result.
- `GET /v1/jobs/{id}/events` replays persisted SSE events. Reconnect with `Last-Event-ID`.

Closing a request, browser, terminal, or SSE stream never owns or cancels a job.

## Webhooks

Only public HTTPS destinations are accepted. Relay rejects credentials in URLs, localhost, private/link-local ranges, metadata targets, and any hostname resolving to a non-public address. Each retry revalidates DNS; the HTTPS connection is pinned to the validated address and redirects are not followed.

Fetch the per-account signing secret once and store it securely:

```http
GET /v1/webhooks/secret
```

Headers:

```text
X-Relay-Delivery: <delivery UUID>
X-Relay-Timestamp: <Unix seconds>
X-Relay-Signature: v1=<hex HMAC>
```

Verify `HMAC-SHA256(signing_secret, timestamp + "." + raw_body)` with a constant-time comparison and reject timestamps outside a short replay window. Delivery retries use persisted exponential backoff for up to 24 hours. The job result URL remains canonical.

## OpenAI-compatible APIs

```text
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
GET  /v1/capabilities
```

Synchronous requests wait briefly for capacity. With no compatible donor, Relay returns `503`, `Retry-After`, and `X-Relay-Durable-Jobs: /v1/jobs`. Once leased, the normal inference timeout applies.

`stream: true` is buffered: Relay first commits the complete donor result and then emits compatible SSE. It does not claim live token delivery or transparent mid-stream failover.

The Responses implementation supports text/message inputs, instructions, function definitions/outputs, output text, usage, and typed buffered events. It is deliberately stateless and experimental. Relay follows the official distinction where Chat Completions streams `delta` chunks while Responses uses typed events such as `response.created`, `response.output_text.delta`, and `response.completed` ([OpenAI migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses#7-update-streaming-consumers)).

## Standard OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.RELAY_API_KEY,
  baseURL: "https://api.example.com/v1",
});

const completion = await client.chat.completions.create({
  model: "community-auto",
  messages: [{ role: "user", content: "Say hello" }],
});
```

The repository runs this path against the current OpenAI JavaScript SDK in CI.

## API key management

- `GET /v1/api-keys` lists prefixes and metadata, never raw keys.
- `POST /v1/api-keys` creates a key and returns its secret once. Requested scopes must be a subset of the creating key.
- `DELETE /v1/api-keys/{id}` revokes immediately.

Scopes: `jobs:read`, `jobs:write`, `hosts:pair`, and `keys:write`.

## Errors and limits

Errors use an OpenAI-style `{ "error": { "message", "type", "code", "param" } }` envelope. Important statuses:

- `400`: invalid request or unsafe webhook URL.
- `401`: invalid/revoked credential.
- `403`: insufficient scope.
- `404`: unknown or unowned resource.
- `409`: result not complete or invalid transition.
- `413`: request body too large.
- `429`: rate, concurrency, or outstanding-job limit.
- `503`: synchronous capacity unavailable.
- `504`: synchronous inference deadline.

Use `GET /v1/capabilities` rather than assuming unsupported OpenAI fields.
