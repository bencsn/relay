import type { DurableJobRequest, JobStatus } from "@relay/protocol";

export interface RelayClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export interface JobStatusResponse {
  id: string;
  status: JobStatus;
  attempt: number;
  compatible_hosts_online: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  result_expires_at: string | null;
  error: unknown;
}

export interface JobEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class RelayClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: RelayClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async submit(payload: DurableJobRequest, idempotencyKey?: string) {
    const response = await this.#request("/v1/jobs", {
      method: "POST",
      headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as { id: string };
    return new RelayJob(this, body.id);
  }

  job(id: string) {
    return new RelayJob(this, id);
  }

  async status(id: string) {
    const response = await this.#request(`/v1/jobs/${encodeURIComponent(id)}`);
    return (await response.json()) as JobStatusResponse;
  }

  async result<T = unknown>(id: string) {
    const response = await this.#request(`/v1/jobs/${encodeURIComponent(id)}/result`);
    return (await response.json()) as T;
  }

  async cancel(id: string) {
    await this.#request(`/v1/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async *events(
    id: string,
    options: { lastEventId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<JobEvent> {
    const headers: Record<string, string> = {};
    if (options.lastEventId) headers["last-event-id"] = options.lastEventId;
    const response = await this.#request(`/v1/jobs/${encodeURIComponent(id)}/events`, {
      headers,
      signal: options.signal,
    });
    if (!response.body) return;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const lines = Object.fromEntries(
          block
            .split("\n")
            .map((line) => line.match(/^([^:]+):\s?(.*)$/))
            .filter((match): match is RegExpMatchArray => Boolean(match))
            .map((match) => [match[1], match[2]]),
        );
        if (lines.data) {
          yield {
            id: lines.id ?? "",
            type: lines.event ?? "message",
            data: JSON.parse(lines.data),
          };
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  }

  async #request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#apiKey}`);
    if (init.body) headers.set("content-type", "application/json");
    const response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      let body: any;
      try {
        body = await response.json();
      } catch {
        body = {};
      }
      throw new RelayError(
        body.error?.message ?? `Relay returned HTTP ${response.status}`,
        response.status,
        body.error?.code,
      );
    }
    return response;
  }
}

export class RelayJob {
  constructor(
    private readonly client: RelayClient,
    readonly id: string,
  ) {}

  status() {
    return this.client.status(this.id);
  }

  result<T = unknown>() {
    return this.client.result<T>(this.id);
  }

  cancel() {
    return this.client.cancel(this.id);
  }

  events(options?: { lastEventId?: string; signal?: AbortSignal }) {
    return this.client.events(this.id, options);
  }

  async wait(options: { pollIntervalMs?: number; signal?: AbortSignal } = {}) {
    const interval = options.pollIntervalMs ?? 1000;
    while (true) {
      options.signal?.throwIfAborted();
      const status = await this.status();
      if (status.status === "succeeded") return this.result();
      if (["failed", "expired", "cancelled"].includes(status.status)) {
        throw new RelayError(`Job ended with status ${status.status}`, 409, status.status);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}
