import type { CanonicalRequest, HostCapabilities, HostPolicy } from "@relay/protocol";

export interface MatchResult {
  compatible: boolean;
  providerModel?: string;
  reason?: string;
}

export function matchRequest(request: CanonicalRequest, host: HostCapabilities): MatchResult {
  if (host.protocolVersion !== 1) return { compatible: false, reason: "protocol_version" };
  const requiredContext = request.inputTokensEstimate + request.maxOutputTokens;
  const model = host.models.find((candidate) => {
    if (candidate.virtualModel !== request.model) return false;
    if (candidate.contextWindow < requiredContext) return false;
    if (candidate.maxOutputTokens < request.maxOutputTokens) return false;
    if (request.api === "chat.completions" && !candidate.features.chatCompletions) return false;
    if (request.api === "responses" && !candidate.features.responses) return false;
    if (request.tools?.length && !candidate.features.tools) return false;
    return true;
  });
  return model
    ? { compatible: true, providerModel: model.providerModel }
    : { compatible: false, reason: "capability_mismatch" };
}

export interface LimitSet {
  maxRequestBytes: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  maxJobSeconds: number;
}

export function effectiveLimits(...limits: LimitSet[]): LimitSet {
  if (limits.length === 0) throw new Error("At least one limit set is required");
  return {
    maxRequestBytes: Math.min(...limits.map((limit) => limit.maxRequestBytes)),
    maxContextTokens: Math.min(...limits.map((limit) => limit.maxContextTokens)),
    maxOutputTokens: Math.min(...limits.map((limit) => limit.maxOutputTokens)),
    maxJobSeconds: Math.min(...limits.map((limit) => limit.maxJobSeconds)),
  };
}

const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function policyAllowsNow(policy: HostPolicy, at = new Date()): boolean {
  if (policy.schedule.windows.length === 0) return true;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: policy.schedule.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const weekday = parts
    .find((part) => part.type === "weekday")
    ?.value.toLowerCase()
    .slice(0, 3);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  const nowMinutes = Number(hour) * 60 + Number(minute);
  const day = dayNames.find((candidate) => candidate === weekday);
  if (!day) return false;
  return policy.schedule.windows.some((window) => {
    if (!window.days.includes(day)) return false;
    const [startHour = 0, startMinute = 0] = window.start.split(":").map(Number);
    const [endHour = 0, endMinute = 0] = window.end.split(":").map(Number);
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    return start <= end
      ? nowMinutes >= start && nowMinutes < end
      : nowMinutes >= start || nowMinutes < end;
  });
}

export function quotaAllows(policy: HostPolicy, jobsToday: number, tokensToday: number) {
  return jobsToday < policy.maxJobsPerDay && tokensToday < policy.maxTokensPerDay;
}

export function retryDecision(attemptNumber: number, retryable: boolean, maxAttempts = 3) {
  if (!retryable) return { retry: false, terminalCode: "provider_error" as const };
  if (attemptNumber >= maxAttempts) return { retry: false, terminalCode: "attempt_limit" as const };
  return { retry: true, terminalCode: null };
}
