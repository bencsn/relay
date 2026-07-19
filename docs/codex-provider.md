# Experimental Codex donor provider

Relay can use a locally installed, logged-in Codex CLI as an account-only text provider:

```text
consumer prompt -> Relay queue -> relay-host -> isolated codex exec -> text result
```

This backend is for private experiments on macOS, Linux, or WSL. It is not enabled by default, is not part of the public donor pool, and must not be marketed as transferable subscription inference. OpenAI's Codex documentation supports `codex exec` for trusted local automation and explicitly says not to expose Codex execution in untrusted or public environments ([non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)). Confirm that your account, workspace policy, and provider terms permit the intended use.

## Security boundary

A `codex-exec` host is forcibly restricted to jobs owned by the same Relay account that paired it. The host configuration rejects attempts to disable account isolation, raise concurrency above one, or enable consumer tool calls.

The host also requires an account-isolation capability in both `/readyz` and the authenticated WebSocket handshake. It refuses to advertise capacity to an older Relay API that does not understand this policy, preventing an unsafe mixed-version fallback into the public pool.

Each request:

- starts `codex exec` directly without a shell and sends the prompt through stdin;
- uses a dedicated Relay-owned `CODEX_HOME`, separate from normal Codex instructions and configuration;
- redirects SQLite and temporary state into the per-job directory, denies command access to it, and deletes it after the request;
- uses `--ephemeral`, `--ignore-user-config`, and `--ignore-rules`;
- runs with a Codex permission profile that can read only minimum runtime files and an empty per-job workspace;
- denies workspace writes, command network access, web search, approvals, MCP configuration, and consumer tools;
- inherits a small environment allowlist that excludes Relay and OpenAI API-key variables;
- caps concurrency, runtime, captured output, process-tree RSS, daily jobs, and daily token usage;
- recursively accounts for Relay/Codex state on disk and removes the per-job workspace afterward.

Codex remains an agent, not a raw model API. It may attempt commands inside the sandbox, and retries may consume account usage more than once. The prompt preamble asks Codex not to use tools, but the permission profile—not the prompt—is the security boundary.

## Local setup

Requirements:

- Codex CLI 0.138.0 or newer (`codex --version`).
- Relay API and PostgreSQL already running.
- A pairing code from the same Relay account whose API key will submit consumer prompts.

If another host configuration is active, stop it and run `relay-host logout` first. Then configure the experimental backend:

```bash
relay-host setup \
  --api http://127.0.0.1:8787 \
  --pairing-code 'pair_...' \
  --provider-type codex-exec \
  --virtual-models community-auto \
  --max-concurrency 1 \
  --acknowledge-codex-exec-risk \
  --yes
```

When running from source, replace `relay-host` with `bun apps/host/src/index.ts`.

Sign in through the isolated Relay-owned Codex state. This opens the normal Codex browser login and does not reuse or copy `~/.codex/auth.json`:

```bash
relay-host codex-login
relay-host doctor
relay-host start
```

If `codex` is not on the host process's `PATH`, pass an absolute trusted executable during setup:

```bash
--codex-executable /absolute/path/to/codex
```

Optionally pin an account-available model with `--model`. Omitting it uses the account default.

## Consumer smoke test

Use a `jobs:write` API key from the same Relay account:

```bash
curl -sS http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $RELAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "community-auto",
    "messages": [{"role": "user", "content": "Explain durable queues in two sentences."}]
  }'
```

The synchronous endpoint requires the Codex host to be online. The durable Jobs API can queue while it is offline, but lease expiry or retries can cause more than one Codex invocation.

## Stop and revoke

`logout` revokes the Relay device credential, signs out the dedicated Codex state, removes that state, and deletes the host configuration:

```bash
relay-host logout
```

Use `--keep-provider-auth` only when deliberately preserving the isolated Codex login for a later re-pairing. `relay-host codex-logout` removes only the isolated Codex login and state.

## Non-goals

- No public or cross-account Codex capacity.
- No consumer-selected tools, repositories, files, URLs, or shell commands.
- No guarantee that personal subscription sharing is permitted.
- No exactly-once upstream usage or billing guarantee.
- No Windows-native support until equivalent process-tree resource enforcement is implemented and tested.
