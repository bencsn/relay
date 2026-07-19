# Donor guide

The host agent opens one outbound TLS WebSocket to Relay and normally calls only the locally configured OpenAI-compatible provider URL. It opens no public listener and never executes consumer-supplied code, tools, URLs, repositories, or files.

An explicitly enabled, account-only [Codex provider experiment](codex-provider.md) can start `codex exec` for text prompts. It uses an empty workspace and a least-privilege permission profile that denies writes, command network access, approvals, and reads outside minimum runtime paths. It is not public-pool capacity.

## Safe provider choices

Use a local/open model server or an upstream source whose terms explicitly permit this use. Do not donate personal subscription access unless the provider has explicitly approved sharing.

Supported backends include Ollama, LM Studio, llama.cpp servers, and other OpenAI-compatible chat endpoints. Relay does not load models or change provider RAM/VRAM settings.

The Codex CLI adapter is a private experiment, not a generally safe provider choice. OpenAI recommends API keys for programmatic automation and says not to expose Codex execution in untrusted or public environments. Relay therefore enforces same-account scheduling for this adapter and requires explicit risk acknowledgement.

## Setup

Create a ten-minute pairing code with a consumer key holding `hosts:pair`, then run:

```bash
relay-host setup \
  --api https://api.example.com \
  --pairing-code pair_... \
  --provider http://127.0.0.1:11434/v1 \
  --model local-code-model \
  --virtual-models community-auto,community-code

relay-host doctor
relay-host start
```

Interactive setup asks for any missing values. Provider credentials stay on the donor machine. macOS uses Keychain and Linux uses Secret Service when available; otherwise the CLI clearly reports its mode and uses a `0600` fallback file. Set `RELAY_HOST_CONFIG_DIR` only when intentionally relocating non-secret policy configuration.

Tool calls are disabled by default. Add `--allow-tools` only if the configured model server correctly supports OpenAI function-tool requests. Relay never executes returned tool calls.

## Commands

```text
relay-host setup
relay-host start
relay-host doctor
relay-host status
relay-host codex-login
relay-host codex-logout
relay-host pause
relay-host resume
relay-host logout
```

`pause` changes local policy immediately; active work aborts on the next heartbeat. `logout` first revokes the server-side device credential, then erases local credentials/config. If Relay cannot be reached, it refuses to imply successful revocation unless `--force-local` is explicitly used and server-side revocation is handled separately.

## Local hard limits

Defaults:

```yaml
accountOnly: false
maxConcurrency: 1
maxRequestBytes: 262144
maxResponseBytes: 1048576
maxContextTokens: 32768
maxOutputTokens: 4096
maxJobSeconds: 300
maxJobsPerDay: 100
maxTokensPerDay: 500000
maxRssBytes: 536870912
maxTemporaryDiskBytes: 268435456
```

The Codex experiment forces `accountOnly: true`, concurrency `1`, a 120-second job limit, 25 jobs/day, and 100,000 tokens/day unless the donor selects stricter values. It cannot be configured for cross-account scheduling.

Schedule windows use an IANA timezone. An empty window list means always available. Effective limits are the minimum of the consumer request, Relay platform, donor policy, and backend capability. Remote messages cannot raise local limits.

The agent keeps request/response data in bounded memory, does not spool prompts, writes prompt-free structured output, and checks its own RSS and local state footprint. Crossing either resource limit automatically pauses the host. The external model server remains separately managed; configure its VRAM/RAM and model loading locally.

## Release verification

Unix installers verify SHA-256. When GitHub CLI is installed, the installer also verifies GitHub artifact attestation provenance. Manual verification:

```bash
gh attestation verify relay-host-linux-x64.tar.gz --repo bencsn/relay
sha256sum -c SHA256SUMS
```
