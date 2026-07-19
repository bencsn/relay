import { afterAll, describe, expect, test } from "bun:test";
import { OpenAICompatibleAdapter } from "../src/provider.ts";

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
