import { createHash } from "node:crypto";
import {
  acceptLease,
  claimNextJob,
  commitAttempt,
  type Database,
  failAttempt,
  markAttemptStarted,
  updateDonorPresence,
} from "@relay/db";
import type { CanonicalRequest, CanonicalResult, HostCapabilities } from "@relay/protocol";

export function mockCapabilities(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    protocolVersion: 1,
    models: [
      {
        virtualModel: "community-auto",
        providerModel: "mock-model",
        contextWindow: 32_768,
        maxOutputTokens: 4096,
        features: { chatCompletions: true, responses: true, tools: true },
      },
    ],
    policy: {
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
      schedule: { timezone: "UTC", windows: [] },
    },
    ...overrides,
  };
}

export function deterministicResult(
  request: CanonicalRequest,
  text = "Mock donor response",
): CanonicalResult {
  const outputTokens = Math.ceil(text.length / 4);
  return {
    providerModel: "mock-model",
    outputText: text,
    finishReason: "stop",
    usage: {
      inputTokens: request.inputTokensEstimate,
      outputTokens,
      totalTokens: request.inputTokensEstimate + outputTokens,
    },
  };
}

export class MockDonor {
  constructor(
    private readonly sql: Database,
    readonly donorId: string,
    readonly capabilities = mockCapabilities(),
  ) {}

  async connect() {
    await updateDonorPresence(this.sql, this.donorId, this.capabilities);
  }

  async claim(leaseSeconds = 20) {
    return claimNextJob(this.sql, this.donorId, this.capabilities, leaseSeconds);
  }

  async complete(offer: NonNullable<Awaited<ReturnType<MockDonor["claim"]>>>, text?: string) {
    await acceptLease(this.sql, this.donorId, offer.leaseId, offer.attemptId);
    await markAttemptStarted(this.sql, this.donorId, offer.leaseId, offer.attemptId);
    const result = deterministicResult(offer.request, text);
    const hash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    return commitAttempt(
      this.sql,
      this.donorId,
      offer.leaseId,
      offer.attemptId,
      result,
      hash,
      604_800,
    );
  }

  async fail(offer: NonNullable<Awaited<ReturnType<MockDonor["claim"]>>>, retryable = true) {
    return failAttempt(this.sql, this.donorId, offer.leaseId, offer.attemptId, {
      code: "transport",
      message: "Injected mock failure",
      retryable,
    });
  }

  async runOne(text?: string) {
    const offer = await this.claim();
    if (!offer) return null;
    await this.complete(offer, text);
    return offer;
  }
}
