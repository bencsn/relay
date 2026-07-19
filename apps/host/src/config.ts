import { chmod, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { hostPolicySchema, type VirtualModel, virtualModelSchema } from "@relay/protocol";
import { parse, stringify } from "yaml";
import { z } from "zod";

const openAICompatibleProviderSchema = z.object({
  type: z.literal("openai-compatible").default("openai-compatible"),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  credentialHeader: z.string().default("Authorization"),
});

const codexExecProviderSchema = z.object({
  type: z.literal("codex-exec"),
  executable: z.string().min(1).default("codex"),
  codexHome: z.string().min(1).refine(isAbsolute, "Codex home must be an absolute path"),
  model: z.string().min(1).optional(),
  acknowledgedUntrustedPromptRisk: z.literal(true),
});

export const hostProviderSchema = z.union([
  codexExecProviderSchema,
  openAICompatibleProviderSchema,
]);
export type HostProviderConfig = z.infer<typeof hostProviderSchema>;

export const hostConfigSchema = z
  .object({
    apiUrl: z.string().url(),
    donorId: z.string(),
    donorName: z.string(),
    provider: hostProviderSchema,
    virtualModels: z.array(virtualModelSchema).min(1),
    allowTools: z.boolean().default(false),
    policy: hostPolicySchema,
    paused: z.boolean().default(false),
  })
  .superRefine((config, context) => {
    if (config.provider.type !== "codex-exec") return;
    if (!config.policy.accountOnly) {
      context.addIssue({
        code: "custom",
        path: ["policy", "accountOnly"],
        message: "codex-exec must remain account-only",
      });
    }
    if (config.policy.maxConcurrency !== 1) {
      context.addIssue({
        code: "custom",
        path: ["policy", "maxConcurrency"],
        message: "codex-exec requires maxConcurrency 1",
      });
    }
    if (config.allowTools) {
      context.addIssue({
        code: "custom",
        path: ["allowTools"],
        message: "codex-exec cannot accept consumer tools",
      });
    }
    const ceilings = {
      maxRequestBytes: 262_144,
      maxResponseBytes: 1_048_576,
      maxContextTokens: 32_768,
      maxOutputTokens: 4096,
      maxJobSeconds: 120,
      maxJobsPerDay: 25,
      maxTokensPerDay: 100_000,
      maxRssBytes: 536_870_912,
      maxTemporaryDiskBytes: 268_435_456,
    } as const;
    for (const [name, ceiling] of Object.entries(ceilings)) {
      const value = config.policy[name as keyof typeof ceilings];
      if (value > ceiling) {
        context.addIssue({
          code: "custom",
          path: ["policy", name],
          message: `codex-exec cannot raise ${name} above ${ceiling}`,
        });
      }
    }
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

export function codexHomeDirectory() {
  return join(configDirectory(), "codex-home");
}

export async function readConfig() {
  return hostConfigSchema.parse(parse(await readFile(configPath(), "utf8")));
}

export async function writeConfig(config: HostConfig) {
  const validated = hostConfigSchema.parse(config);
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await Bun.write(temporary, stringify(validated));
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
  async function directoryBytes(path: string): Promise<number> {
    const entries = await readdir(path, { withFileTypes: true });
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(path, entry.name);
        if (entry.isDirectory()) return directoryBytes(entryPath);
        if (!entry.isFile()) return 0;
        return (await stat(entryPath)).size;
      }),
    );
    return sizes.reduce((total, size) => total + size, 0);
  }
  try {
    return await directoryBytes(configDirectory());
  } catch {
    return 0;
  }
}

export function defaultPolicy(overrides: Record<string, unknown> = {}) {
  return hostPolicySchema.parse({
    accountOnly: false,
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
