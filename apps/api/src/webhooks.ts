import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export class WebhookUrlError extends Error {}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") return false;
    if (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff")
    )
      return false;
    if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
    return true;
  }
  return false;
}

export async function validateWebhookUrl(
  input: string,
  resolver: (hostname: string) => Promise<ResolvedAddress[]> = async (hostname) => {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.map((result) => ({ address: result.address, family: result.family as 4 | 6 }));
  },
) {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:") throw new WebhookUrlError("Webhook URLs must use HTTPS.");
    if (url.username || url.password)
      throw new WebhookUrlError("Webhook URLs must not contain credentials.");
    if (url.hostname === "localhost" || url.hostname.endsWith(".localhost"))
      throw new WebhookUrlError("Webhook host is not public.");
    const literalFamily = isIP(url.hostname.replace(/^\[|\]$/g, ""));
    const addresses = literalFamily
      ? [{ address: url.hostname.replace(/^\[|\]$/g, ""), family: literalFamily as 4 | 6 }]
      : await resolver(url.hostname);
    if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw new WebhookUrlError("Webhook host resolves to a non-public address.");
    }
    return { url, addresses };
  } catch (error) {
    if (error instanceof WebhookUrlError) throw error;
    throw new WebhookUrlError("Webhook URL could not be safely resolved.");
  }
}

export function accountWebhookSecret(masterSecret: string, accountId: string) {
  return `whsec_${createHmac("sha256", masterSecret).update(`account:${accountId}`).digest("base64url")}`;
}

export function signWebhook(secret: string, timestamp: number, body: string) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export async function deliverWebhook(
  urlString: string,
  body: string,
  secret: string,
  deliveryId: string,
  timeoutMs = 10_000,
) {
  const { url, addresses } = await validateWebhookUrl(urlString);
  const target = addresses[0];
  if (!target) throw new Error("Webhook host has no usable public address.");
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhook(secret, timestamp, body);
  await new Promise<void>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "POST",
        timeout: timeoutMs,
        servername: url.hostname,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": "Relay-Webhook/0.1",
          "x-relay-delivery": deliveryId,
          "x-relay-timestamp": String(timestamp),
          "x-relay-signature": signature,
        },
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      },
      (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300)
          resolve();
        else reject(new Error(`Webhook returned HTTP ${response.statusCode ?? "unknown"}`));
      },
    );
    request.on("timeout", () => request.destroy(new Error("Webhook request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}
