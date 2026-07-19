import {
  type CanonicalRequest,
  type CanonicalResult,
  type ChatCompletionRequest,
  type ChatMessage,
  chatCompletionRequestSchema,
  type ResponsesRequest,
  responsesRequestSchema,
} from "@relay/protocol";

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content === null) return "";
  return content.map((part) => part.text).join("\n");
}

function estimateInputTokens(messages: ChatMessage[]) {
  const chars = messages.reduce(
    (count, message) => count + textOf(message.content).length + message.role.length,
    0,
  );
  return Math.ceil(chars / 4) + messages.length * 4;
}

export function chatToCanonical(input: unknown): { request: CanonicalRequest; stream: boolean } {
  const body = chatCompletionRequestSchema.parse(input);
  const maxOutputTokens = body.max_completion_tokens ?? body.max_tokens ?? 1024;
  return {
    stream: body.stream,
    request: {
      api: "chat.completions",
      model: body.model,
      messages: body.messages,
      maxOutputTokens,
      inputTokensEstimate: estimateInputTokens(body.messages),
      temperature: body.temperature,
      topP: body.top_p,
      tools: body.tools?.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
      toolChoice: body.tool_choice,
    },
  };
}

function responseInputToMessages(body: ResponsesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (body.instructions) messages.push({ role: "developer", content: body.instructions });
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
    return messages;
  }
  for (const item of body.input) {
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
      });
      continue;
    }
    const content =
      typeof item.content === "string"
        ? item.content
        : item.content.map((part) => part.text).join("\n");
    messages.push({ role: item.role, content });
  }
  return messages;
}

export function responsesToCanonical(input: unknown): {
  request: CanonicalRequest;
  stream: boolean;
} {
  const body = responsesRequestSchema.parse(input);
  const messages = responseInputToMessages(body);
  const tools = body.tools
    ?.filter((tool) => tool.type === "function" && typeof tool.name === "string")
    .map((tool) => ({
      name: String(tool.name),
      description: typeof tool.description === "string" ? tool.description : undefined,
      parameters:
        typeof tool.parameters === "object" && tool.parameters
          ? (tool.parameters as Record<string, unknown>)
          : undefined,
    }));
  return {
    stream: body.stream,
    request: {
      api: "responses",
      model: body.model,
      messages,
      maxOutputTokens: body.max_output_tokens ?? 1024,
      inputTokensEstimate: estimateInputTokens(messages),
      temperature: body.temperature,
      topP: body.top_p,
      tools,
      toolChoice: body.tool_choice,
    },
  };
}

export function durableRequestToCanonical(
  request:
    | { api: "chat.completions"; body: ChatCompletionRequest }
    | { api: "responses"; body: ResponsesRequest },
) {
  return request.api === "chat.completions"
    ? chatToCanonical(request.body).request
    : responsesToCanonical(request.body).request;
}

export function chatCompletionResult(jobId: string, model: string, result: CanonicalResult) {
  const toolCalls = result.toolCalls?.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: call.arguments },
  }));
  return {
    id: `chatcmpl_${jobId.replace(/^job_/, "")}`,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: toolCalls?.length ? null : result.outputText,
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: result.finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.totalTokens,
    },
  };
}

export function responsesResult(jobId: string, model: string, result: CanonicalResult) {
  const responseId = `resp_${jobId.replace(/^job_/, "")}`;
  const output = result.toolCalls?.length
    ? result.toolCalls.map((call) => ({
        type: "function_call" as const,
        id: call.id,
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
        status: "completed" as const,
      }))
    : [
        {
          type: "message" as const,
          id: `msg_${jobId.replace(/^job_/, "")}`,
          status: "completed" as const,
          role: "assistant" as const,
          content: [{ type: "output_text" as const, text: result.outputText, annotations: [] }],
        },
      ];
  return {
    id: responseId,
    object: "response" as const,
    created_at: Math.floor(Date.now() / 1000),
    status: "completed" as const,
    model,
    output,
    output_text: result.outputText,
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      total_tokens: result.usage.totalTokens,
    },
  };
}

function sse(event: string | undefined, data: unknown) {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

export function bufferedChatStream(jobId: string, model: string, result: CanonicalResult) {
  const completed = chatCompletionResult(jobId, model, result);
  const base = {
    id: completed.id,
    object: "chat.completion.chunk",
    created: completed.created,
    model,
  };
  return [
    sse(undefined, {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }),
    sse(undefined, {
      ...base,
      choices: [
        { index: 0, delta: { content: result.outputText }, finish_reason: null, logprobs: null },
      ],
    }),
    sse(undefined, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: result.finishReason, logprobs: null }],
    }),
    "data: [DONE]\n\n",
  ].join("");
}

export function bufferedResponsesStream(jobId: string, model: string, result: CanonicalResult) {
  const response = responsesResult(jobId, model, result);
  const message = response.output[0];
  if (message?.type !== "message") {
    return [
      sse("response.created", {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      }),
      sse("response.completed", { type: "response.completed", response }),
    ].join("");
  }
  const part = message.content[0];
  return [
    sse("response.created", {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    }),
    sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    }),
    sse("response.content_part.added", {
      type: "response.content_part.added",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    sse("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: result.outputText,
    }),
    sse("response.output_text.done", {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text: result.outputText,
    }),
    sse("response.content_part.done", {
      type: "response.content_part.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part,
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: message,
    }),
    sse("response.completed", { type: "response.completed", response }),
  ].join("");
}

export function openAIError(
  message: string,
  type: string,
  code: string,
  param: string | null = null,
) {
  return { error: { message, type, code, param } };
}
