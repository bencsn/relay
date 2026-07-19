import { describe, expect, test } from "bun:test";
import {
  durableJobRequestSchema,
  hostMessageSchema,
  hostPolicySchema,
  responsesRequestSchema,
  serverMessageSchema,
} from "../src/index.ts";

describe("external protocol validation", () => {
  test("accepts a bounded durable chat job", () => {
    const parsed = durableJobRequestSchema.parse({
      request: {
        api: "chat.completions",
        body: {
          model: "community-auto",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      queue: { max_wait_seconds: 3600 },
    });
    expect(parsed.queue.max_wait_seconds).toBe(3600);
    expect(parsed.request.api).toBe("chat.completions");
  });

  test("rejects unknown request fields and waits over seven days", () => {
    expect(() =>
      durableJobRequestSchema.parse({
        request: {
          api: "chat.completions",
          body: {
            model: "community-auto",
            messages: [{ role: "user", content: "hello" }],
            arbitrary_url: "http://127.0.0.1/admin",
          },
        },
        queue: { max_wait_seconds: 604_801 },
      }),
    ).toThrow();
  });

  test("supports Codex-shaped text and function tool inputs", () => {
    const parsed = responsesRequestSchema.parse({
      model: "community-code",
      instructions: "Be concise",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
      stream: true,
      store: false,
      parallel_tool_calls: true,
    });
    expect(parsed.stream).toBeTrue();
  });

  test("bounds donor policy and wire messages", () => {
    expect(() => hostPolicySchema.parse({ maxConcurrency: 1000 })).toThrow();
    expect(() =>
      hostMessageSchema.parse({
        protocolVersion: 1,
        sessionId: crypto.randomUUID(),
        sequence: -1,
        type: "host.ready",
      }),
    ).toThrow();
  });

  test("fails closed when an older Relay API omits account-only scheduling support", () => {
    const accepted = serverMessageSchema.parse({
      type: "host.accepted",
      sessionId: crypto.randomUUID(),
      heartbeatSeconds: 5,
    });
    if (accepted.type !== "host.accepted") throw new Error("Expected accepted message");
    expect(accepted.features.accountOnlyScheduling).toBeFalse();
  });
});
