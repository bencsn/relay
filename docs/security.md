# Security model

## Boundaries

Relay protects control-plane credentials, ownership, queue state, and result commitment. It does not make a public donor a confidential computing environment.

Trusted:

- Relay API/control-plane operator.
- PostgreSQL and the production secret manager.
- The consumer for its own API key and payload.
- The donor for its own local provider credential and policy.

Untrusted or potentially malicious:

- Internet clients, API payloads, webhook destinations, donor messages, and model responses.
- Other consumers and donors.
- A public donor operator with respect to prompt confidentiality.

## Implemented controls

- High-entropy API/device credentials; only keyed HMAC digests are stored.
- One-time, expiring pairing codes and device revocation.
- Per-resource account ownership checks and scoped API keys.
- Strict Zod network schemas, request/response byte bounds, token/context/time bounds, and unknown-field rejection on supported API shapes.
- PostgreSQL row locks, `SKIP LOCKED`, one-active-lease and one-committed-attempt constraints.
- Lease expiry and late-result rejection independent of socket state.
- Monotonic donor sequence validation against replay/out-of-order messages.
- Prompt-free logs and structured redaction.
- In-memory API request throttling for the single-process MVP plus database outstanding/active-work limits.
- HTTPS-only production option, secure headers, and no CORS opt-in.
- HTTPS-only webhooks with public-address validation, DNS rebinding resistance through address pinning, no redirects, HMAC signatures, and persisted retries.
- Non-root/read-only container, dropped Linux capabilities, SBOM/provenance, secret/dependency/static analysis workflows.
- Bearer-protected, prompt-free Prometheus metrics for durable states, queue age, donor state, and webhook delivery state.
- Account suspension disables API authentication, stops that account's donors from receiving new work, and expires their active leases (`bun run account:status -- --account-id ... --status suspended`).
- The experimental Codex provider is forced to same-account jobs, concurrency one, no consumer tools, isolated file-based Codex auth, an empty per-job workspace, minimum-read/no-write/no-command-network permissions, no approvals, bounded subprocess output/time/process-tree RSS, and recursive local-state accounting.

## Production requirements outside the codebase

- TLS 1.2+ at an audited reverse proxy/load balancer; set `REQUIRE_HTTPS=true`.
- Set `TRUST_PROXY_HEADERS=true` only when the API is reachable exclusively through a trusted proxy that overwrites forwarded headers.
- Managed PostgreSQL with encrypted storage, TLS, point-in-time recovery, tested restores, least-privilege credentials, and private networking.
- Separate random values (48+ random bytes recommended) for each pepper/signing secret, stored in a cloud secret manager with rotation/incident procedures.
- Network-level rate limiting/WAF and connection caps. The built-in limiter is process-local by design because the MVP runs one API process.
- Egress controls allowing webhook TCP 443 while denying private/link-local/metadata networks as defense in depth.
- Central metrics/alerts for auth failures, queue age, lease expiry, webhook failure, error rate, resource use, and database capacity.
- Abuse reporting, consumer suspension, donor reporting, content-policy decision, terms/privacy policy, and an on-call owner.

## Known limitations

- Donors see plaintext prompts and outputs.
- Relay operators and PostgreSQL can access retained payloads unless infrastructure-level encryption/access controls prevent unauthorized access.
- No multi-region/high-availability control plane is included.
- Streaming is buffered, not live.
- Responses/Codex compatibility is a limited experimental subset.
- The Codex donor adapter runs an agent rather than a raw inference API. It is private/account-only, can consume usage more than once on retries, and is not approved for public subscription sharing. Native Windows is disabled until equivalent process resource enforcement is available.
- Release artifacts have signed GitHub provenance; Apple notarization and Windows Authenticode require project-owned certificates before broad native distribution.
- The fallback donor credential file is less desirable than an OS keychain; `doctor`/`status` report the active backend.

## Security review before launch

At minimum, commission an independent review of authentication, WebSocket state transitions, webhook egress, PostgreSQL privileges/backups, proxy header handling, and donor binary supply chain. Run load/malformed-input tests in an environment isolated from production data.
