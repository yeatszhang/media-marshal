/** 日志不接受凭据、完整请求或第三方响应；这里是误传字段的第二道防线。 */
const sensitiveKey = /cookie|authorization|password|passwd|secret|token|api[-_]?key|credential/i;
const levels = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
export type LogLevel = typeof levels[number];
export const RENDERER_LOG_PREFIX = "[media-marshal] ";

export function logLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  return levels.includes(value as LogLevel) ? value as LogLevel : fallback;
}

function safeText(value: string): string {
  return value.slice(0, 8192)
    .replace(/\b(?:cookie|set-cookie|authorization)\s*[:=][^\r\n]*/gi, "[已脱敏]")
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, "[已脱敏]")
    .replace(/\b(?:password|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi, "[已脱敏]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
      catch { return "[地址已脱敏]"; }
    });
}

export function sanitizeLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return safeText(value);
  if (typeof value === "bigint") return value.toString();
  if (!value || typeof value !== "object") return value;
  if (depth >= 8 || seen.has(value)) return "[已省略]";
  seen.add(value);
  if (value instanceof Error) {
    // 原始 message/cause 可能带数据库内容或远端响应，仅保留类型、错误码和调用位置。
    return {
      type: safeText(value.name),
      ...("code" in value && typeof value.code === "string" ? { code: safeText(value.code) } : {}),
      stack: value.stack?.split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 16).map(safeText).join("\n"),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeLogValue(item, depth + 1, seen));
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
    key, sensitiveKey.test(key) ? "[已脱敏]" : sanitizeLogValue(item, depth + 1, seen),
  ]));
}
