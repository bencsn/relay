import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { configDirectory } from "./config.ts";

export type CredentialName = "device-token" | "provider-api-key";

async function commandExists(command: string) {
  const process = Bun.spawn([command, "--help"], { stdout: "ignore", stderr: "ignore" });
  return (await process.exited) === 0;
}

async function run(args: string[], stdin?: string) {
  const process = Bun.spawn(args, {
    stdin: stdin ? new Blob([stdin]) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `${args[0]} failed`);
  return stdout.trim();
}

function fallbackPath() {
  return join(configDirectory(), "secrets.json");
}

function forceFileBackend() {
  return process.env.RELAY_HOST_CREDENTIAL_BACKEND === "file";
}

async function readFallback(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(fallbackPath(), "utf8"));
  } catch {
    return {};
  }
}

async function writeFallback(values: Record<string, string>) {
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  await Bun.write(fallbackPath(), `${JSON.stringify(values)}\n`);
  await chmod(fallbackPath(), 0o600);
}

export async function credentialBackend() {
  if (forceFileBackend()) return "0600 local fallback (explicit)";
  if (process.platform === "darwin" && (await commandExists("security"))) return "macOS Keychain";
  if (process.platform === "linux" && (await commandExists("secret-tool"))) return "Secret Service";
  return "0600 local fallback";
}

export async function setCredential(name: CredentialName, value: string) {
  if (!forceFileBackend() && process.platform === "darwin" && (await commandExists("security"))) {
    await run([
      "security",
      "add-generic-password",
      "-a",
      "relay-host",
      "-s",
      `relay-host:${name}`,
      "-w",
      value,
      "-U",
    ]);
    return;
  }
  if (!forceFileBackend() && process.platform === "linux" && (await commandExists("secret-tool"))) {
    await run(
      [
        "secret-tool",
        "store",
        "--label",
        `Relay Host ${name}`,
        "service",
        "relay-host",
        "key",
        name,
      ],
      value,
    );
    return;
  }
  const values = await readFallback();
  values[name] = value;
  await writeFallback(values);
}

export async function getCredential(name: CredentialName) {
  if (!forceFileBackend() && process.platform === "darwin" && (await commandExists("security"))) {
    try {
      return await run([
        "security",
        "find-generic-password",
        "-a",
        "relay-host",
        "-s",
        `relay-host:${name}`,
        "-w",
      ]);
    } catch {
      return undefined;
    }
  }
  if (!forceFileBackend() && process.platform === "linux" && (await commandExists("secret-tool"))) {
    try {
      return await run(["secret-tool", "lookup", "service", "relay-host", "key", name]);
    } catch {
      return undefined;
    }
  }
  return (await readFallback())[name];
}

export async function deleteCredential(name: CredentialName) {
  if (!forceFileBackend() && process.platform === "darwin" && (await commandExists("security"))) {
    const child = Bun.spawn(
      ["security", "delete-generic-password", "-a", "relay-host", "-s", `relay-host:${name}`],
      { stdout: "ignore", stderr: "ignore" },
    );
    await child.exited;
    return;
  }
  if (!forceFileBackend() && process.platform === "linux" && (await commandExists("secret-tool"))) {
    const child = Bun.spawn(["secret-tool", "clear", "service", "relay-host", "key", name], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    return;
  }
  const values = await readFallback();
  delete values[name];
  if (Object.keys(values).length) await writeFallback(values);
  else await unlink(fallbackPath()).catch(() => undefined);
}
