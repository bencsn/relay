import { unlink } from "node:fs/promises";
import { hostPolicySchema } from "@relay/protocol";
import { runAgent } from "./agent.ts";
import {
  configExists,
  configPath,
  defaultPolicy,
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
import { OpenAICompatibleAdapter } from "./provider.ts";
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
  const apiUrl = ask("Relay API URL", flag(flags, "api"), "http://127.0.0.1:8787").replace(
    /\/$/,
    "",
  );
  const pairingCode = ask("Pairing code", flag(flags, "pairing-code"));
  const provider = ask(
    "OpenAI-compatible provider base URL",
    flag(flags, "provider"),
    "http://127.0.0.1:11434/v1",
  ).replace(/\/$/, "");
  const model = ask("Provider model", flag(flags, "model"), "local-code-model");
  const donorName = ask(
    "Donor name",
    flag(flags, "name"),
    `donor-${crypto.randomUUID().slice(0, 8)}`,
  );
  if (!pairingCode) throw new Error("A pairing code is required.");
  const response = await fetch(`${apiUrl}/v1/hosts/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairing_code: pairingCode, name: donorName }),
  });
  if (!response.ok) throw new Error(`Pairing failed with HTTP ${response.status}`);
  const paired = (await response.json()) as { donor_id: string; device_token: string };
  const numeric = (name: string, fallback: number) => Number(flag(flags, name) ?? fallback);
  const policy = hostPolicySchema.parse(
    defaultPolicy({
      maxConcurrency: numeric("max-concurrency", 1),
      maxContextTokens: numeric("max-context-tokens", 32_768),
      maxOutputTokens: numeric("max-output-tokens", 4096),
      maxResponseBytes: numeric("max-response-bytes", 1_048_576),
      maxJobSeconds: numeric("max-job-seconds", 300),
      maxJobsPerDay: numeric("max-jobs-per-day", 100),
      maxTokensPerDay: numeric("max-tokens-per-day", 500_000),
    }),
  );
  await setCredential("device-token", paired.device_token);
  const providerKey =
    flag(flags, "provider-key") ??
    (flags.has("yes")
      ? undefined
      : prompt("Provider API key (leave empty for local unauthenticated servers):")?.trim());
  if (providerKey) await setCredential("provider-api-key", providerKey);
  await writeConfig({
    apiUrl,
    donorId: paired.donor_id,
    donorName,
    provider: { baseUrl: provider, model, credentialHeader: "Authorization" },
    virtualModels: parseVirtualModels(flag(flags, "virtual-models")),
    allowTools: flags.has("allow-tools"),
    policy,
    paused: false,
  });
  console.log(
    `Relay host configured at ${configPath()}. Credential backend: ${await credentialBackend()}.`,
  );
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
        provider: config.provider.baseUrl,
        model: config.provider.model,
        virtual_models: config.virtualModels,
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
  const adapter = new OpenAICompatibleAdapter(
    config.provider.baseUrl,
    config.provider.model,
    providerKey,
    config.provider.credentialHeader,
  );
  const [relay, provider] = await Promise.all([
    fetch(`${config.apiUrl}/readyz`, { signal: AbortSignal.timeout(5000) })
      .then((response) => ({ healthy: response.ok, detail: `HTTP ${response.status}` }))
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

async function logout(flags: Map<string, string | boolean>) {
  const token = await getCredential("device-token");
  if (token && (await configExists())) {
    const config = await readConfig();
    try {
      const response = await fetch(`${config.apiUrl}/v1/hosts/me`, {
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
  status   Show prompt-free local status and daily usage
  pause    Stop accepting work and abort active work promptly
  resume   Resume accepting work
  logout   Revoke local use by removing device/provider credentials and config`;
