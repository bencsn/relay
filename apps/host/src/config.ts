import { chmod, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hostPolicySchema, type VirtualModel, virtualModelSchema } from "@relay/protocol";
import { parse, stringify } from "yaml";
import { z } from "zod";

export const hostConfigSchema = z.object({
  apiUrl: z.string().url(),
  donorId: z.string(),
  donorName: z.string(),
  provider: z.object({
    baseUrl: z.string().url(),
    model: z.string().min(1),
    credentialHeader: z.string().default("Authorization"),
  }),
  virtualModels: z.array(virtualModelSchema).min(1),
  allowTools: z.boolean().default(false),
  policy: hostPolicySchema,
  paused: z.boolean().default(false),
});
export type HostConfig = z.infer<typeof hostConfigSchema>;

export function configDirectory() {
  return process.env.RELAY_HOST_CONFIG_DIR ?? join(homedir(), ".config", "relay-host");
}

export function configPath() {
  return join(configDirectory(), "config.yaml");
}

export function usagePath() {
  return join(configDirectory(), "usage.json");
}

export async function readConfig() {
  return hostConfigSchema.parse(parse(await readFile(configPath(), "utf8")));
}

export async function writeConfig(config: HostConfig) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await Bun.write(temporary, stringify(config));
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function configExists() {
  try {
    await stat(configPath());
    return true;
  } catch {
    return false;
  }
}

export async function localStateBytes() {
  try {
    const entries = await readdir(configDirectory(), { withFileTypes: true });
    const sizes = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => stat(join(configDirectory(), entry.name))),
    );
    return sizes.reduce((total, entry) => total + entry.size, 0);
  } catch {
    return 0;
  }
}

export function defaultPolicy(overrides: Record<string, unknown> = {}) {
  return hostPolicySchema.parse({
    maxConcurrency: 1,
    maxRequestBytes: 262_144,
    maxResponseBytes: 1_048_576,
    maxContextTokens: 32_768,
    maxOutputTokens: 4096,
    maxJobSeconds: 300,
    maxJobsPerDay: 100,
    maxTokensPerDay: 500_000,
    maxRssBytes: 536_870_912,
    maxTemporaryDiskBytes: 268_435_456,
    schedule: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, windows: [] },
    ...overrides,
  });
}

export function parseVirtualModels(input?: string): VirtualModel[] {
  if (!input) return ["community-auto"];
  return input.split(",").map((value) => virtualModelSchema.parse(value.trim()));
}
