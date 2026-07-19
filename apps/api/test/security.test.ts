import { describe, expect, test } from "bun:test";
import { redact } from "../src/logger.ts";
import {
  accountWebhookSecret,
  isPublicAddress,
  signWebhook,
  validateWebhookUrl,
} from "../src/webhooks.ts";

describe("launch security boundaries", () => {
  test("rejects private, loopback, link-local, and metadata webhook targets", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(isPublicAddress(address)).toBeFalse();
    }
    expect(isPublicAddress("8.8.8.8")).toBeTrue();
    await expect(validateWebhookUrl("http://example.com/hook")).rejects.toThrow("HTTPS");
    await expect(validateWebhookUrl("https://localhost/hook")).rejects.toThrow("not public");
    await expect(
      validateWebhookUrl("https://attacker.example/hook", async () => [
        { address: "203.0.113.10", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]),
    ).rejects.toThrow("non-public");
  });

  test("signs timestamped webhook bodies with per-account secrets", () => {
    const secretA = accountWebhookSecret(
      "master-secret-at-least-thirty-two-characters",
      "account-a",
    );
    const secretB = accountWebhookSecret(
      "master-secret-at-least-thirty-two-characters",
      "account-b",
    );
    expect(secretA).not.toBe(secretB);
    expect(signWebhook(secretA, 123, '{"ok":true}')).toMatch(/^v1=[a-f0-9]{64}$/);
    expect(signWebhook(secretA, 123, '{"ok":true}')).not.toBe(
      signWebhook(secretA, 124, '{"ok":true}'),
    );
  });

  test("redacts prompt and credential material from structured logs", () => {
    const value = redact({
      job_id: "job_1",
      api_key: "lr_live_secret",
      messages: [{ content: "private prompt" }],
      nested: { authorization: "Bearer secret" },
    });
    expect(JSON.stringify(value)).toBe(
      '{"job_id":"job_1","api_key":"[REDACTED]","messages":"[REDACTED]","nested":{"authorization":"[REDACTED]"}}',
    );
  });
});
