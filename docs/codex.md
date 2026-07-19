# Experimental Codex configuration

Relay exposes a deliberately limited Responses-compatible endpoint. Codex does not understand Relay's durable Jobs API, so interactive use needs compatible online donor capacity; otherwise it receives a retryable `503`.

Provider configuration belongs in user-level Codex configuration. Current Codex documentation says project-local config cannot override `model_provider` or `model_providers`; profile files live alongside the user config and are selected with `--profile` ([official config reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)).

Create `$CODEX_HOME/relay.config.toml` (normally `~/.codex/relay.config.toml`):

```toml
model = "community-code"
model_provider = "relay"

[model_providers.relay]
name = "Relay Community"
base_url = "https://api.example.com/v1"
wire_api = "responses"
env_key = "RELAY_API_KEY"
```

Run:

```bash
RELAY_API_KEY=lr_live_... codex --profile relay
```

Limitations:

- Text and basic function calls only; no claim of full Responses parity.
- Stateless: no durable `previous_response_id` conversation state.
- Buffered SSE only.
- Donated models may not be capable enough for reliable agent/tool behavior.
- Public donors see prompt/tool context; do not use private repositories or secrets.

The repository fixture tests Responses objects and typed streaming events. A real Codex probe should be repeated against the current CLI before every compatibility claim or launch.
