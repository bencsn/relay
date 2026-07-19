import { describe, expect, test } from "bun:test";
import { defaultPolicy, hostConfigSchema } from "../src/config.ts";

const base = {
  apiUrl: "http://127.0.0.1:8787",
  donorId: "donor_test",
  donorName: "test donor",
  virtualModels: ["community-auto"],
  allowTools: false,
  policy: defaultPolicy(),
  paused: false,
};

const codexPolicy = defaultPolicy({
  accountOnly: true,
  maxJobSeconds: 120,
  maxJobsPerDay: 25,
  maxTokensPerDay: 100_000,
});

describe("host provider configuration", () => {
  test("keeps existing OpenAI-compatible host configurations valid", () => {
    const parsed = hostConfigSchema.parse({
      ...base,
      provider: {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "local-model",
        credentialHeader: "Authorization",
      },
    });
    expect(parsed.provider.type).toBe("openai-compatible");
  });

  test("requires an explicit risk acknowledgement for Codex execution", () => {
    expect(() =>
      hostConfigSchema.parse({
        ...base,
        provider: {
          type: "codex-exec",
          executable: "codex",
          codexHome: "/tmp/relay-codex-home",
        },
      }),
    ).toThrow();

    const parsed = hostConfigSchema.parse({
      ...base,
      policy: codexPolicy,
      provider: {
        type: "codex-exec",
        executable: "codex",
        codexHome: "/tmp/relay-codex-home",
        acknowledgedUntrustedPromptRisk: true,
      },
    });
    expect(parsed.provider.type).toBe("codex-exec");
  });

  test("cannot weaken Codex account isolation or concurrency in the config file", () => {
    expect(() =>
      hostConfigSchema.parse({
        ...base,
        provider: {
          type: "codex-exec",
          executable: "codex",
          codexHome: "/tmp/relay-codex-home",
          acknowledgedUntrustedPromptRisk: true,
        },
      }),
    ).toThrow();
    expect(() =>
      hostConfigSchema.parse({
        ...base,
        policy: defaultPolicy({ accountOnly: true, maxConcurrency: 2 }),
        provider: {
          type: "codex-exec",
          executable: "codex",
          codexHome: "/tmp/relay-codex-home",
          acknowledgedUntrustedPromptRisk: true,
        },
      }),
    ).toThrow();
    expect(() =>
      hostConfigSchema.parse({
        ...base,
        policy: defaultPolicy({ accountOnly: true, maxJobSeconds: 121 }),
        provider: {
          type: "codex-exec",
          executable: "codex",
          codexHome: "/tmp/relay-codex-home",
          acknowledgedUntrustedPromptRisk: true,
        },
      }),
    ).toThrow();
  });
});
