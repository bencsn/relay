# Public launch checklist

Do not mark Relay production-ready or submit it to Product Hunt until every launch-blocking item is complete.

## Launch blocking

- [ ] Independent application security review completed; critical/high findings fixed and moderate findings triaged.
- [ ] External privacy policy, terms, acceptable-use policy, and public-donor plaintext warning published.
- [ ] Named security/on-call owner, private disclosure channel, incident runbook, and kill switches tested.
- [ ] Managed PostgreSQL private networking, TLS, encrypted storage, PITR, restore drill, least privilege, and capacity alerts verified.
- [ ] Unique production secrets in a managed secret store; no bootstrap key in deployment configuration.
- [ ] TLS edge, trusted proxy headers, WAF/rate limits, body/header/slow-client limits, and WebSocket/SSE behavior verified.
- [ ] Webhook egress firewall denies private, link-local, metadata, and non-HTTPS destinations as defense in depth.
- [ ] API logs/traces/metrics inspected to prove prompts and credentials are absent by default.
- [ ] Abuse suspension and donor-report workflows tested.
- [ ] Zero-donor queue, donor loss before/while running, late result, result race, cancellation, expiry, SSE resume, webhook retry, key/device revocation all pass in staging.
- [ ] Current OpenAI SDK fixture passes; any Codex/OpenCode claim has a dated real-client test.
- [ ] Container SBOM/provenance and standalone binary checksums/attestations verify from a clean machine.
- [ ] Apple notarization and Windows Authenticode completed before advertising frictionless native installs on those platforms.
- [ ] Dependency audit, CodeQL, Gitleaks, branch protection, required reviews/checks, secret scanning, and Dependabot enabled on GitHub.
- [ ] Load/soak tests establish safe queue, connection, database, webhook, and donor-churn limits.
- [ ] Backup, rollback, secret rotation, API key revocation, donor revocation, webhook disable, and service shutdown drills completed.

## Launch copy must say

- Best-effort donated inference, not an SLA.
- Public donors process plaintext and may inspect it.
- No confidential/private/regulated workloads.
- No consumer-supplied code execution or repository transfer. The optional account-only Codex experiment runs only model-selected actions inside its documented empty least-privilege sandbox and is not public-pool capacity.
- Buffered streaming, not live token failover.
- Local/open or explicitly permitted provider capacity only.
- Codex CLI donor mode remains private, account-only, explicitly acknowledged, and excluded from public subscription-capacity claims.
- Responses/Codex compatibility is experimental unless the launch build has a dated proof.

## Recommended staged rollout

1. Maintainer-only staging.
2. Allowlisted donors and consumers with synthetic/public prompts.
3. Small private alpha with incident coverage.
4. Public waitlist and capped keys.
5. Product Hunt launch only after operational evidence from the earlier stages.
