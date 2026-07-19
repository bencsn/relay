# Contributing

Thanks for helping improve Relay.

1. Open an issue for security-sensitive or architecture-changing work before implementation. Report vulnerabilities privately via `SECURITY.md`, never a public issue.
2. Use Bun 1.3.14 and PostgreSQL 18.4 for the reference environment.
3. Keep PostgreSQL as the queue/source of truth. Do not add Redis, Kafka, microservices, or a second auth/state system without an accepted design.
4. Preserve the privacy boundary: no prompt/credential logging, no arbitrary donor URL fetching, and no consumer code execution.
5. Add tests for state transitions, race/failure behavior, network schema changes, and security controls.

Before a pull request:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
TEST_DATABASE_URL=postgres://... bun test
bun run build
bun audit
bun run secrets:check
```

Use focused commits, explain operational/security impact, and update API/runbook documentation with behavior changes.
