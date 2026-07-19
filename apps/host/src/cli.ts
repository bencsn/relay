import { chmod, mkdir, rm, unlink } from "node:fs/promises";
import { hostPolicySchema } from "@relay/protocol";
import { runAgent } from "./agent.ts";
import {
  codexHomeDirectory,
  configExists,
  configPath,
  defaultPolicy,
  type HostProviderConfig,
  hostConfigSchema,
  parseVirtualModels,
  readConfig,
  writeConfig,
} from "./config.ts";
import {
  credentialBackend,
  deleteCredential,
  getCredential,
  setCredential,
} from "./credentials.ts";
import { createInferenceAdapter, providerModel } from "./provider.ts";
import { readUsage } from "./usage.ts";

function parseFlags(args: string[]) {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item?.startsWith("--")) continue;
    const [name, inline] = item.slice(2).split("=", 2);
    if (!name) continue;
    const next = args[index + 1];
    if (inline !== undefined) flags.set(name, inline);
    else if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else flags.set(name, true);
  }
  return flags;
}

function flag(flags: Map<string, string | boolean>, name: string) {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function ask(label: string, supplied?: string, fallback?: string) {
  if (supplied) return supplied;
  const answer = prompt(`${label}${fallback ? ` [${fallback}]` : ""}:`)?.trim();
  return answer || fallback || "";
}

export async function runCli(args = process.argv.slice(2)) {
  const command = args[0] ?? "help";
  const flags = parseFlags(args.slice(1));
  switch (command) {
    case "setup":
      await setup(flags);
      return;
    case "start":
      if (!(await configExists())) throw new Error("Host is not configured; run relay-host setup.");
      await runAgent();
      return;
    case "status":
      await status();
      return;
    case "pause":
      await setPaused(true);
      return;
    case "resume":
      await setPaused(false);
      return;
    case "doctor":
      await doctor();
      return;
    case "codex-login":
      await codexLogin();
      return;
    case "codex-logout":
      await codexLogout();
      return;
    case "logout":
      await logout(flags);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(help);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${help}`);
  }
}

async function setup(flags: Map<string, string | boolean>) {
  if (await configExists()) {
    throw new Error(
      "A host is already configured. Stop it and run relay-host logout before configuring another provider.",
    );
  }
  const apiUrl = ask("Relay API URL", flag(flags, "api"), "http://127.0.0.1:8787").replace(
    /\/$/,
    "",
  );
  const pairingCode = ask("Pairing code", flag(flags, "pairing-code"));
  const providerType = flag(flags, "provider-type") ?? "openai-compatible";
  if (providerType !== "openai-compatible" && providerType !== "codex-exec") {
    throw new Error("--provider-type must be openai-compatible or codex-exec.");
  }
  const allowTools = flags.has("allow-tools");
  let providerConfig: HostProviderConfig;
  if (providerType === "codex-exec") {
    if (!flags.has("acknowledge-codex-exec-risk")) {
      throw new Error(
        "Codex execution is for private experiments only. Re-run with --acknowledge-codex-exec-risk after reading docs/codex-provider.md.",
      );
    }
    if (allowTools) throw new Error("Consumer tool calls cannot be enabled for codex-exec.");
    const model =
      flag(flags, "model") ??
      (flags.has("yes")
        ? undefined
        : prompt("Codex model (leave empty for account default):")?.trim());
    providerConfig = {
      type: "codex-exec",
      executable: flag(flags, "codex-executable") ?? "codex",
      codexHome: codexHomeDirectory(),
      model: model || undefined,
      acknowledgedUntrustedPromptRisk: true,
    };
  } else {
    const provider = ask(
      "OpenAI-compatible provider base URL",
      flag(flags, "provider"),
      "http://127.0.0.1:11434/v1",
    ).replace(/\/$/, "");
    providerConfig = {
      type: "openai-compatible",
      baseUrl: provider,
      model: ask("Provider model", flag(flags, "model"), "local-code-model"),
      credentialHeader: "Authorization",
    };
  }
  const donorName = ask(
    "Donor name",
    flag(flags, "name"),
    `donor-${crypto.randomUUID().slice(0, 8)}`,
  );
  if (!pairingCode) throw new Error("A pairing code is required.");
  const numeric = (name: string, fallback: number) => Number(flag(flags, name) ?? fallback);
  const maxConcurrency = numeric("max-concurrency", 1);
  if (providerType === "codex-exec" && maxConcurrency !== 1) {
    throw new Error("codex-exec requires --max-concurrency 1.");
  }
  const policy = hostPolicySchema.parse(
    defaultPolicy({
      accountOnly: providerType === "codex-exec",
      maxConcurrency,
      maxRequestBytes: numeric("max-request-bytes", 262_144),
      maxContextTokens: numeric("max-context-tokens", 32_768),
      maxOutputTokens: numeric("max-output-tokens", 4096),
      maxResponseBytes: numeric("max-response-bytes", 1_048_576),
      maxJobSeconds: numeric("max-job-seconds", providerType === "codex-exec" ? 120 : 300),
      maxJobsPerDay: numeric("max-jobs-per-day", providerType === "codex-exec" ? 25 : 100),
      maxTokensPerDay: numeric(
        "max-tokens-per-day",
        providerType === "codex-exec" ? 100_000 : 500_000,
      ),
      maxRssBytes: numeric("max-rss-bytes", 536_870_912),
      maxTemporaryDiskBytes: numeric("max-temporary-disk-bytes", 268_435_456),
    }),
  );
  const virtualModels = parseVirtualModels(flag(flags, "virtual-models"));
  hostConfigSchema.parse({
    apiUrl,
    donorId: "pending-validation",
    donorName,
    provider: providerConfig,
    virtualModels,
    allowTools,
    policy,
    paused: false,
  });
  const response = await fetch(`${apiUrl}/v1/hosts/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairing_code: pairingCode, name: donorName }),
  });
  if (!response.ok) throw new Error(`Pairing failed with HTTP ${response.status}`);
  const paired = (await response.json()) as { donor_id: string; device_token: string };
  await setCredential("device-token", paired.device_token);
  await deleteCredential("provider-api-key");
  if (providerType === "openai-compatible") {
    const providerKey =
      flag(flags, "provider-key") ??
      (flags.has("yes")
        ? undefined
        : prompt("Provider API key (leave empty for local unauthenticated servers):")?.trim());
    if (providerKey) await setCredential("provider-api-key", providerKey);
  }
  await writeConfig({
    apiUrl,
    donorId: paired.donor_id,
    donorName,
    provider: providerConfig,
    virtualModels,
    allowTools,
    policy,
    paused: false,
  });
  console.log(
    `Relay host configured at ${configPath()}. Credential backend: ${await credentialBackend()}.`,
  );
  if (providerType === "codex-exec") {
    console.log("Run relay-host codex-login, then relay-host doctor before starting the host.");
  }
}

async function setPaused(paused: boolean) {
  const config = await readConfig();
  config.paused = paused;
  await writeConfig(config);
  console.log(
    paused
      ? "Relay host paused. Active work will be aborted on the next heartbeat."
      : "Relay host resumed.",
  );
}

async function status() {
  const config = await readConfig();
  const usage = await readUsage();
  console.log(
    JSON.stringify(
      {
        donor_id: config.donorId,
        paused: config.paused,
        provider_type: config.provider.type,
        provider:
          config.provider.type === "codex-exec" ? "isolated codex exec" : config.provider.baseUrl,
        model: providerModel(config.provider),
        virtual_models: config.virtualModels,
        account_only: config.policy.accountOnly,
        consumer_tools: config.provider.type === "openai-compatible" && config.allowTools,
        usage_today: usage,
        credential_backend: await credentialBackend(),
      },
      null,
      2,
    ),
  );
}

async function doctor() {
  const config = await readConfig();
  const deviceToken = await getCredential("device-token");
  const providerKey = await getCredential("provider-api-key");
  const adapter = createInferenceAdapter(config.provider, {
    credential: providerKey,
    maxOutputBytes: config.policy.maxResponseBytes,
    maxRssBytes: config.policy.maxRssBytes,
  });
  const [relay, provider] = await Promise.all([
    fetch(`${config.apiUrl}/readyz`, { signal: AbortSignal.timeout(5000) })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          features?: { account_only_scheduling?: boolean };
        };
        const accountIsolationAvailable = body.features?.account_only_scheduling === true;
        return {
          healthy: response.ok && (!config.policy.accountOnly || accountIsolationAvailable),
          detail:
            config.policy.accountOnly && !accountIsolationAvailable
              ? "Relay API lacks required account-only scheduling support"
              : `HTTP ${response.status}`,
        };
      })
      .catch((error) => ({ healthy: false, detail: String(error) })),
    adapter.health(),
  ]);
  const report = {
    config: true,
    device_credential: Boolean(deviceToken),
    credential_backend: await credentialBackend(),
    relay,
    provider,
    policy: hostPolicySchema.safeParse(config.policy).success,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.device_credential || !relay.healthy || !provider.healthy || !report.policy)
    process.exitCode = 1;
}

function codexAuthEnvironment(codexHome: string) {
  const env: Record<string, string> = { CODEX_HOME: codexHome };
  for (const name of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "BROWSER",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SSL_CERT_FILE",
    "CODEX_CA_CERTIFICATE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
  ]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

async function runCodexAuth(command: "login" | "logout") {
  const config = await readConfig();
  if (config.provider.type !== "codex-exec") {
    throw new Error(
      `${command === "login" ? "codex-login" : "codex-logout"} requires a codex-exec provider.`,
    );
  }
  await mkdir(config.provider.codexHome, { recursive: true, mode: 0o700 });
  await chmod(config.provider.codexHome, 0o700);
  const child = Bun.spawn(
    [config.provider.executable, command, "-c", 'cli_auth_credentials_store="file"'],
    {
      env: codexAuthEnvironment(config.provider.codexHome),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`codex ${command} failed with exit code ${exitCode}.`);
  if (command === "logout") {
    await rm(config.provider.codexHome, { recursive: true, force: true });
  }
}

async function codexLogin() {
  await runCodexAuth("login");
}

async function codexLogout() {
  await runCodexAuth("logout");
}

async function logout(flags: Map<string, string | boolean>) {
  const existingConfig = (await configExists()) ? await readConfig() : undefined;
  const provider: HostProviderConfig | undefined = existingConfig?.provider;
  const token = await getCredential("device-token");
  if (token && existingConfig) {
    try {
      const response = await fetch(`${existingConfig.apiUrl}/v1/hosts/me`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok && response.status !== 401) {
        throw new Error(`Relay returned HTTP ${response.status}`);
      }
    } catch (error) {
      if (!flags.has("force-local")) {
        throw new Error(
          `Could not revoke the donor credential remotely (${error instanceof Error ? error.message : String(error)}). Retry online, or use --force-local only if server-side revocation is handled separately.`,
        );
      }
    }
  }
  if (provider?.type === "codex-exec" && !flags.has("keep-provider-auth")) {
    try {
      await runCodexAuth("logout");
    } catch (error) {
      if (!flags.has("force-local")) throw error;
      await rm(provider.codexHome, { recursive: true, force: true });
    }
  }
  await deleteCredential("device-token");
  await deleteCredential("provider-api-key");
  await unlink(configPath()).catch(() => undefined);
  console.log("Relay host credentials and local configuration removed.");
}

const help = `relay-host <command>

Commands:
  setup    Pair this machine and configure its local provider and hard limits (--allow-tools opts in)
  start    Connect outbound to Relay and donate inference
  doctor   Test Relay, provider, credentials, and policy
  codex-login   Sign in to the isolated Codex state used by a codex-exec provider
  codex-logout  Remove the isolated Codex login and state
  status   Show prompt-free local status and daily usage
  pause    Stop accepting work and abort active work promptly
  resume   Resume accepting work
  logout   Revoke local use and remove credentials/config (--keep-provider-auth preserves Codex login)`;
