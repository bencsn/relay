# Relay

Relay turns intermittently available, donated inference capacity into a durable OpenAI-compatible API.

Consumers submit jobs without choosing a machine. Donors run an outbound-only host agent connected to an OpenAI-compatible local model server. Jobs wait when no donor is available, leases expire when donors disappear, and PostgreSQL atomically accepts exactly one result.

> [!WARNING]
> The selected donor processes prompt plaintext. The public pool is for non-confidential workloads only. Never send secrets, private keys, regulated data, or private source code. TLS protects transport; it cannot hide input from the machine performing inference.

## What is implemented

- Durable `POST /v1/jobs` with polling, replayable SSE, idempotency, cancellation, retention, and signed webhooks.
- OpenAI-compatible `GET /v1/models`, `POST /v1/chat/completions`, and a documented Responses subset.
- Buffered `stream: true` compatibility after a result commits; no misleading live failover claim.
- Authenticated outbound donor WebSocket with monotonic message sequences.
- Capability matching, FIFO queueing, consumer fair-share caps, leases, heartbeats, retries, and late-result rejection.
- Host-owned schedules, concurrency, request/response/context/output/time/daily/RSS limits.
- One-time donor pairing, hashed API/device credentials, API key scopes, rotation, and immediate revocation.
- SSRF-resistant HTTPS webhooks with DNS validation, pinned delivery address, HMAC signatures, and 24-hour retry state.
- Non-root, read-only API container; PostgreSQL is the only durable dependency.
- Bun tests covering queueing with zero donors, failover, exactly-one commit, SDK compatibility, SSE replay, SSRF controls, quotas, cancellation, expiry, and webhook retries.
- Pinned CI actions, CodeQL, Gitleaks, dependency review, Dependabot, SBOM/provenance-enabled containers, and attested release artifacts.

The detailed product scope is in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Operational limitations are documented in [docs/security.md](docs/security.md) and [docs/privacy.md](docs/privacy.md).

## Architecture

```text
consumer / OpenAI SDK
         |
         | HTTPS + Relay API key
         v
  Relay API (Hono/Bun) ------ PostgreSQL
         ^                     jobs, events, leases,
         | outbound WSS        attempts, webhook state
         |
   relay-host ------ local OpenAI-compatible model server
```

The consumer never receives donor identity or credentials. The donor receives the inference payload and opaque lease identifiers, but not the consumer API key, account identity, email, IP, or billing data.

## Local quick start

Requirements: Bun 1.3.14+, Docker, and Docker Compose.

1. Create local configuration and generate independent secrets:

   ```bash
   cp .env.example .env
   openssl rand -base64 48
   ```

   Put a different generated value in `POSTGRES_PASSWORD`, `KEY_PEPPER`, `DEVICE_TOKEN_PEPPER`, `WEBHOOK_SIGNING_SECRET`, and `METRICS_BEARER_TOKEN`. Never commit `.env`.

2. Start PostgreSQL and the API:

   ```bash
   docker compose --env-file .env -f deploy/docker-compose.yml up --build
   ```

3. Create a consumer key and donor pairing code:

   ```bash
   bun run bootstrap -- --show-secret
   ```

   Run this only in a private interactive terminal, then save the one-time credentials directly in a password manager. The command refuses non-interactive output to avoid accidental CI/log capture. Relay stores only HMAC digests of API/device credentials.

4. For a dependency-free local smoke test, start the prompt-free mock backend:

   ```bash
   bun run mock:provider
   ```

5. Pair and start a donor:

   ```bash
   bun apps/host/src/index.ts setup \
     --api http://127.0.0.1:8787 \
     --pairing-code 'pair_...' \
     --provider http://127.0.0.1:11434/v1 \
     --model local-code-model

   bun apps/host/src/index.ts doctor
   bun apps/host/src/index.ts start
   ```

6. Submit a durable job:

   ```bash
   curl http://127.0.0.1:8787/v1/jobs \
     -H "Authorization: Bearer $RELAY_API_KEY" \
     -H 'Content-Type: application/json' \
     -H 'Idempotency-Key: readme-example-1' \
     -d '{
       "request": {
         "api": "chat.completions",
         "body": {
           "model": "community-auto",
           "messages": [{"role": "user", "content": "Explain durable queues"}]
         }
       },
       "queue": {"max_wait_seconds": 3600}
     }'
   ```

See [docs/api.md](docs/api.md) for polling, SSE, webhooks, key management, Chat Completions, Responses, and SDK usage.

## Donor install

Release artifacts contain standalone Bun-compiled binaries, SHA-256 checksums, and GitHub artifact attestations.

```bash
curl -fsSL https://raw.githubusercontent.com/bencsn/relay/main/install.sh | sh
relay-host setup
relay-host doctor
relay-host start
```

Windows PowerShell users can download and inspect `install.ps1`, then run it locally. The installers pin downloads to GitHub HTTPS, verify release SHA-256, and verify GitHub build provenance when `gh` is installed.

Read [docs/donor.md](docs/donor.md) before donating capacity. Provider credentials remain local and use the OS credential store when available.

## Development

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
TEST_DATABASE_URL=postgres://relay:password@127.0.0.1:5432/relay bun test
bun run build
bun run build:host
bun audit
bun run secrets:check
```

`bun run demo` runs the deterministic two-donor lease-expiry demonstration against the configured PostgreSQL database.

## Production deployment

Do not expose the development Compose stack directly. Production requires TLS termination, a managed PostgreSQL service with encrypted storage/backups/PITR, independent secret-manager values, network restrictions, monitoring, and an incident owner. Follow [docs/deployment.md](docs/deployment.md) and do not launch until [docs/launch-checklist.md](docs/launch-checklist.md) is complete.

## Open source

Apache-2.0 licensed. Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
