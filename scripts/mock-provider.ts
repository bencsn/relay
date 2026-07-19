const port = Number(process.env.MOCK_PROVIDER_PORT ?? 11434);
const delay = Number(process.env.MOCK_PROVIDER_DELAY_MS ?? 50);

const server = Bun.serve({
  port,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "local-code-model", object: "model" }] });
    }
    if (path === "/v1/chat/completions" && request.method === "POST") {
      await request.json();
      await Bun.sleep(delay);
      return Response.json({
        id: `chatcmpl_mock_${crypto.randomUUID().replaceAll("-", "")}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "local-code-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Relay mock provider completed this request." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
    }
    return Response.json({ error: { message: "Not found" } }, { status: 404 });
  },
});

console.log(JSON.stringify({ event: "mock_provider.started", port: server.port }));
