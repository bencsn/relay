import { afterAll, describe, expect, test } from "bun:test";
import {
  CodexExecAdapter,
  OpenAICompatibleAdapter,
  type ProcessRequest,
  ProviderError,
  runBoundedProcess,
} from "../src/provider.ts";

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/models") return Response.json({ data: [{ id: "mock-model" }] });
    if (path === "/v1/chat/completions") {
      return Response.json({
        id: "chatcmpl_mock",
        model: "mock-model",
        choices: [
          { message: { role: "assistant", content: "provider result" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => server.stop(true));

describe("OpenAI-compatible donor adapter", () => {
  test("checks health and normalizes a bounded complete response", async () => {
    const adapter = new OpenAICompatibleAdapter(`http://127.0.0.1:${server.port}/v1`, "mock-model");
    expect((await adapter.health()).healthy).toBeTrue();
    const result = await adapter.infer(
      {
        api: "chat.completions",
        model: "community-auto",
        messages: [{ role: "user", content: "secret prompt is not logged" }],
        maxOutputTokens: 100,
        inputTokensEstimate: 10,
      },
      AbortSignal.timeout(5000),
    );
    expect(result.outputText).toBe("provider result");
    expect(result.usage.totalTokens).toBe(8);
  });
});

describe("isolated Codex exec donor adapter", () => {
  test("terminates a provider process whose captured output exceeds the local bound", async () => {
    await expect(
      runBoundedProcess({
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("x".repeat(4096))'],
        env: { PATH: process.env.PATH ?? "" },
        signal: AbortSignal.timeout(5000),
        maxStdoutBytes: 128,
        maxStderrBytes: 128,
      }),
    ).rejects.toThrow("output exceeded");
  });

  test("checks a dedicated login and returns only the final JSONL agent message", async () => {
    const calls: ProcessRequest[] = [];
    const adapter = new CodexExecAdapter(
      {
        executable: "codex-test",
        codexHome: "/tmp/relay-codex-test-home",
        maxOutputBytes: 65_536,
        maxRssBytes: 536_870_912,
      },
      async (request) => {
        calls.push(request);
        if (request.args[0] === "--version") {
          return { exitCode: 0, stdout: "codex-cli 0.144.6\n", stderr: "" };
        }
        if (request.args[0] === "login") {
          return { exitCode: 0, stdout: "Logged in using ChatGPT\n", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "turn.started" }),
            JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "Codex provider result" },
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: { input_tokens: 12, output_tokens: 4 },
            }),
          ].join("\n"),
          stderr: "progress is never returned to the consumer",
        };
      },
    );

    expect((await adapter.health()).healthy).toBeTrue();
    const result = await adapter.infer(
      {
        api: "chat.completions",
        model: "community-auto",
        messages: [{ role: "user", content: "Give a short answer" }],
        maxOutputTokens: 100,
        inputTokensEstimate: 8,
      },
      AbortSignal.timeout(5000),
    );

    expect(result.outputText).toBe("Codex provider result");
    expect(result.providerModel).toBe("codex:account-default");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4, totalTokens: 16 });
    const execution = calls.at(-1);
    expect(execution?.args).toContain("--ephemeral");
    expect(execution?.args).toContain("--ignore-user-config");
    expect(execution?.args).toContain('approval_policy="never"');
    expect(execution?.args).toContain('default_permissions="relay_provider"');
    expect(execution?.args).toContain("permissions.relay_provider.network.enabled=false");
    expect(execution?.input).toContain("Give a short answer");
    expect(execution?.env.OPENAI_API_KEY).toBeUndefined();
    expect(execution?.env.CODEX_API_KEY).toBeUndefined();
    expect(execution?.env.HOME).toBe(execution?.cwd);
    expect(execution?.env.CODEX_SQLITE_HOME).toBe(`${execution?.cwd}/codex-state`);
  });

  test("rejects consumer tools before starting Codex", async () => {
    let called = false;
    const adapter = new CodexExecAdapter(
      {
        executable: "codex-test",
        codexHome: "/tmp/relay-codex-test-home",
        maxOutputBytes: 65_536,
        maxRssBytes: 536_870_912,
      },
      async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );

    await expect(
      adapter.infer(
        {
          api: "chat.completions",
          model: "community-auto",
          messages: [{ role: "user", content: "Use a tool" }],
          maxOutputTokens: 100,
          inputTokensEstimate: 8,
          tools: [{ name: "shell" }],
        },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(called).toBeFalse();
  });

  test("rejects Codex versions without least-privilege permission profiles", async () => {
    const adapter = new CodexExecAdapter(
      {
        executable: "codex-test",
        codexHome: "/tmp/relay-codex-test-home",
        maxOutputBytes: 65_536,
        maxRssBytes: 536_870_912,
      },
      async () => ({ exitCode: 0, stdout: "codex-cli 0.137.0\n", stderr: "" }),
    );
    expect(await adapter.health()).toEqual({
      healthy: false,
      detail: "Codex CLI 0.138.0 or newer is required.",
    });
  });

  test("does not treat Codex's zero-exit not-logged-in status as healthy", async () => {
    const adapter = new CodexExecAdapter(
      {
        executable: "codex-test",
        codexHome: "/tmp/relay-codex-test-home",
        maxOutputBytes: 65_536,
        maxRssBytes: 536_870_912,
      },
      async (request) =>
        request.args[0] === "--version"
          ? { exitCode: 0, stdout: "codex-cli 0.144.6\n", stderr: "" }
          : { exitCode: 0, stdout: "Not logged in\n", stderr: "" },
    );
    expect(await adapter.health()).toEqual({
      healthy: false,
      detail: "Codex CLI is not authenticated; run relay-host codex-login.",
    });
  });
});
