const redactedKeys =
  /authorization|api[-_]?key|credential|secret|token|prompt|messages|instructions|content|input/i;

export function redact(value: unknown, key = ""): unknown {
  if (redactedKeys.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, childKey),
      ]),
    );
  }
  return value;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(minimum: LogLevel = "info") {
  function write(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
    if (order[level] < order[minimum]) return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...(redact(fields) as Record<string, unknown>),
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
  return {
    debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
    info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
    error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
  };
}

export type Logger = ReturnType<typeof createLogger>;
