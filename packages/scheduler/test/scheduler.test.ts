import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "@relay/protocol";
import { mockCapabilities } from "@relay/testkit";
import {
  effectiveLimits,
  matchRequest,
  policyAllowsNow,
  quotaAllows,
  retryDecision,
} from "../src/index.ts";

const request: CanonicalRequest = {
  api: "chat.completions",
  model: "community-auto",
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 1000,
  inputTokensEstimate: 100,
};

describe("scheduler policy", () => {
  test("matches protocol, virtual model, context, output, and features", () => {
    expect(matchRequest(request, mockCapabilities()).compatible).toBeTrue();
    const tooSmall = mockCapabilities();
    const smallModel = tooSmall.models[0];
    if (!smallModel) throw new Error("Mock capabilities did not include a model");
    smallModel.contextWindow = 500;
    expect(matchRequest(request, tooSmall)).toEqual({
      compatible: false,
      reason: "capability_mismatch",
    });
    const noResponses = mockCapabilities();
    const responseModel = noResponses.models[0];
    if (!responseModel) throw new Error("Mock capabilities did not include a model");
    responseModel.features.responses = false;
    expect(matchRequest({ ...request, api: "responses" }, noResponses).compatible).toBeFalse();
  });

  test("uses the minimum effective limit", () => {
    expect(
      effectiveLimits(
        { maxRequestBytes: 100, maxContextTokens: 1000, maxOutputTokens: 300, maxJobSeconds: 60 },
        { maxRequestBytes: 80, maxContextTokens: 2000, maxOutputTokens: 200, maxJobSeconds: 30 },
      ),
    ).toEqual({
      maxRequestBytes: 80,
      maxContextTokens: 1000,
      maxOutputTokens: 200,
      maxJobSeconds: 30,
    });
  });

  test("enforces schedules, quotas, and attempt limits", () => {
    const capabilities = mockCapabilities();
    capabilities.policy.schedule = {
      timezone: "UTC",
      windows: [{ days: ["sun"], start: "11:00", end: "13:00" }],
    };
    expect(policyAllowsNow(capabilities.policy, new Date("2026-07-19T12:00:00Z"))).toBeTrue();
    expect(policyAllowsNow(capabilities.policy, new Date("2026-07-19T14:00:00Z"))).toBeFalse();
    expect(quotaAllows(capabilities.policy, 99, 499_999)).toBeTrue();
    expect(quotaAllows(capabilities.policy, 100, 0)).toBeFalse();
    expect(retryDecision(2, true, 3).retry).toBeTrue();
    expect(retryDecision(3, true, 3).retry).toBeFalse();
    expect(retryDecision(1, false, 3).retry).toBeFalse();
  });
});
