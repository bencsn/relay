# Production deployment

The repository supplies a single stateless API container plus PostgreSQL. PostgreSQL remains the queue and source of truth; do not add a second queue without redesigning lease/commit invariants.

## Required environment

```text
DATABASE_URL
PUBLIC_BASE_URL
KEY_PEPPER
DEVICE_TOKEN_PEPPER
WEBHOOK_SIGNING_SECRET
METRICS_BEARER_TOKEN
PORT=8787
REQUIRE_HTTPS=true
TRUST_PROXY_HEADERS=true   # only behind a trusted, overwriting proxy
```

Generate independent secrets using a cryptographic generator. Never reuse the database password, API-key pepper, device-token pepper, or webhook signing secret. Avoid `RELAY_BOOTSTRAP_API_KEY` in normal production; create accounts with `bun run key:create -- --name <name> --show-secret` from an audited, private interactive terminal and transfer the one-time output directly to a password manager. Credential-issuing scripts refuse non-interactive output so CI cannot capture raw keys accidentally.

## PostgreSQL

The local stack pins PostgreSQL 18.4, the current supported 18.x release used during implementation ([official release notes](https://www.postgresql.org/docs/release/18.4/)). Production may use a compatible managed 18.x service.

Require:

- TLS certificate verification.
- Private network/firewall access from the API only.
- A dedicated non-superuser Relay role with schema migration separated from runtime privileges where possible.
- Encrypted storage and backups.
- Point-in-time recovery and quarterly restore drills.
- Connection, storage, replication, lock-wait, and slow-query alerts.
- A migration rehearsal on a restored production snapshot before deploy.

The Compose volume mounts `/var/lib/postgresql`, required by the PostgreSQL 18 container layout.

## Edge/TLS

Terminate TLS at a maintained load balancer or reverse proxy. Preserve WebSocket upgrades and disable request buffering for `/v1/jobs/*/events`. Apply:

- Maximum request body no larger than Relay's configured limit.
- Per-IP/account request and concurrent connection limits.
- Slow-client/header timeouts.
- No public access to PostgreSQL.
- Forwarded headers overwritten by the trusted edge, never appended from clients.

## Container

The image runs as `bun`, uses a read-only filesystem in Compose, drops all Linux capabilities, and needs only outbound PostgreSQL plus public HTTPS webhook egress. The tag workflow publishes multi-architecture GHCR images with SBOM and signed provenance.

Verify before deploying:

```bash
docker build -t relay-api:local .
docker inspect relay-api:local --format '{{.Config.User}}'
gh attestation verify oci://ghcr.io/bencsn/relay:<tag> --repo bencsn/relay
```

## Rollout

1. Back up and verify restore readiness.
2. Run migrations as an isolated deploy step.
3. Deploy one API process; the MVP's throttler and donor connection registry are process-local.
4. Verify `/healthz`, `/readyz`, authenticated `/v1/models`, a zero-donor queued job, donor pairing, completion, lease-expiry failover, SSE replay, webhook signature/retry, and revocation.
5. Scrape `/metrics` with `Authorization: Bearer $METRICS_BEARER_TOKEN`; inspect prompt-free logs and alert on queue age, failures, donor availability, and webhook backlog.
6. Roll back application code if needed; do not blindly reverse destructive schema migrations.

Horizontal API scaling is not a supported production topology until donor connection routing and process-local rate limiting are externalized or redesigned.
