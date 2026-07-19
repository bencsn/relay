import type { CanonicalRequest, CanonicalResult } from "@relay/protocol";

export interface HealthResult {
  healthy: boolean;
  detail: string;
}

export interface InferenceAdapter {
  health(): Promise<HealthResult>;
  infer(request: CanonicalRequest, signal: AbortSignal): Promise<CanonicalResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "provider_validation"
      | "provider_content"
      | "provider_timeout"
      | "provider_overloaded"
      | "transport"
      | "malformed_response",
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class OpenAICompatibleAdapter implements InferenceAdapter {
  readonly #baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly model: string,
    private readonly credential?: string,
    private readonly credentialHeader = "Authorization",
  ) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  #headers() {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.credential) {
      headers[this.credentialHeader] =
        this.credentialHeader.toLowerCase() === "authorization" &&
        !this.credential.startsWith("Bearer ")
          ? `Bearer ${this.credential}`
          : this.credential;
    }
    return headers;
  }

  async health(): Promise<HealthResult> {
    try {
      const response = await fetch(`${this.#baseUrl}/models`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        return { healthy: false, detail: `GET /models returned ${response.status}` };
      const body = (await response.json()) as { data?: { id?: string }[] };
      const models = body.data?.map((entry) => entry.id).filter(Boolean) ?? [];
      return {
        healthy: true,
        detail: models.includes(this.model)
          ? `model ${this.model} is available`
          : `endpoint is healthy; model ${this.model} was not listed`,
      };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async infer(request: CanonicalRequest, signal: AbortSignal): Promise<CanonicalResult> {
    const body = {
      model: this.model,
      messages: request.messages,
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      top_p: request.topP,
      stream: false,
      tools: request.tools?.map((tool) => ({ type: "function", function: tool })),
      tool_choice: request.toolChoice,
    };
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted)
        throw new ProviderError(
          "Provider request timed out or was cancelled.",
          "provider_timeout",
          true,
        );
      throw new ProviderError(
        error instanceof Error ? error.message : "Provider transport failed.",
        "transport",
        true,
      );
    }
    if (!response.ok) {
      const message = `Provider returned HTTP ${response.status}`;
      if (response.status === 429 || response.status >= 500)
        throw new ProviderError(message, "provider_overloaded", true);
      if (response.status === 400 || response.status === 422)
        throw new ProviderError(message, "provider_validation", false);
      throw new ProviderError(message, "provider_content", false);
    }
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError("Provider response was not valid JSON.", "malformed_response", true);
    }
    const choice = payload?.choices?.[0];
    if (!choice?.message)
      throw new ProviderError(
        "Provider response did not include choices[0].message.",
        "malformed_response",
        true,
      );
    const toolCalls = Array.isArray(choice.message.tool_calls)
      ? choice.message.tool_calls.map((call: any) => ({
          id: String(call.id),
          name: String(call.function?.name),
          arguments:
            typeof call.function?.arguments === "string"
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments ?? {}),
        }))
      : undefined;
    const outputText = typeof choice.message.content === "string" ? choice.message.content : "";
    const inputTokens = Number(payload.usage?.prompt_tokens ?? request.inputTokensEstimate);
    const outputTokens = Number(
      payload.usage?.completion_tokens ?? Math.ceil(outputText.length / 4),
    );
    return {
      providerModel: String(payload.model ?? this.model),
      outputText,
      finishReason:
        choice.finish_reason === "tool_calls"
          ? "tool_calls"
          : choice.finish_reason === "length"
            ? "length"
            : "stop",
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: Number(payload.usage?.total_tokens ?? inputTokens + outputTokens),
      },
    };
  }
}
