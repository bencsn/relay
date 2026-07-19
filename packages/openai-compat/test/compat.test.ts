import { describe, expect, test } from "bun:test";
import {
  bufferedChatStream,
  bufferedResponsesStream,
  chatCompletionResult,
  chatToCanonical,
  responsesResult,
  responsesToCanonical,
} from "../src/index.ts";

const result = {
  providerModel: "local-model",
  outputText: "hello from Relay",
  finishReason: "stop" as const,
  usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 },
};

describe("OpenAI compatibility translation", () => {
  test("normalizes Chat Completions without donor identity", () => {
    const normalized = chatToCanonical({
      model: "community-auto",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 50,
    });
    expect(normalized.request.maxOutputTokens).toBe(50);
    expect(normalized.request.model).toBe("community-auto");
    const response = chatCompletionResult("job_abc", "community-auto", result);
    expect(response.choices[0]?.message.content).toBe("hello from Relay");
    expect(JSON.stringify(response)).not.toContain("local-model");
  });

  test("normalizes Responses inputs and typed buffered events", () => {
    const normalized = responsesToCanonical({
      model: "community-code",
      instructions: "Be useful",
      input: "hello",
      stream: true,
    });
    expect(normalized.request.messages).toHaveLength(2);
    const response = responsesResult("job_abc", "community-code", result);
    expect(response.output_text).toBe("hello from Relay");
    const stream = bufferedResponsesStream("job_abc", "community-code", result);
    expect(stream).toContain("event: response.created");
    expect(stream).toContain("event: response.output_text.delta");
    expect(stream).toContain("event: response.completed");
  });

  test("emits standards-shaped buffered Chat SSE", () => {
    const stream = bufferedChatStream("job_abc", "community-auto", result);
    expect(stream).toContain('"object":"chat.completion.chunk"');
    expect(stream).toEndWith("data: [DONE]\n\n");
  });
});
