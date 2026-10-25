import http from "node:http";
import https from "node:https";

export class MediaNetworkError extends Error {
  constructor(readonly code: "AUTH_REQUIRED" | "RATE_LIMITED" | "NETWORK_UNAVAILABLE" | "INVALID_RESPONSE" | "INTERRUPTED" | "TIMEOUT", readonly retryAfterSeconds?: number) {
    super({ AUTH_REQUIRED: "服务凭据需要重新配置", RATE_LIMITED: "服务请求受到限制，请稍后重试", NETWORK_UNAVAILABLE: "服务暂时不可用", INVALID_RESPONSE: "服务响应无效", INTERRUPTED: "请求已停止等待", TIMEOUT: "服务请求超时" }[code]); this.name = "MediaNetworkError";
  }
}
export interface JsonRequest { method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; agent?: http.Agent; timeoutMs?: number; maxBytes?: number; emptyResponse?: boolean }
/** 不读取环境代理、不跟随重定向、不记录 URL/请求头；代理只能由特定适配器显式注入。 */
export function requestJson(url: URL, options: JsonRequest = {}): Promise<unknown> {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return Promise.reject(new MediaNetworkError("INVALID_RESPONSE"));
  if (options.signal?.aborted) return Promise.reject(new MediaNetworkError("INTERRUPTED"));
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024, timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) return Promise.reject(new MediaNetworkError("INVALID_RESPONSE"));
  let body: Buffer | undefined; try { if (options.body !== undefined) body = Buffer.from(JSON.stringify(options.body)); } catch { return Promise.reject(new MediaNetworkError("INVALID_RESPONSE")); }
  if (body && body.length > 65536) return Promise.reject(new MediaNetworkError("INVALID_RESPONSE"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: MediaNetworkError | null, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); if (error) reject(error); else resolve(value); };
    const connection = (url.protocol === "https:" ? https : http).request(url, { method: options.method ?? "GET", agent: options.agent ?? false, headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {}), ...options.headers } }, (response) => {
      let length = 0; const chunks: Buffer[] = [];
      response.on("error", () => finish(new MediaNetworkError("NETWORK_UNAVAILABLE")));
      response.on("aborted", () => finish(new MediaNetworkError("NETWORK_UNAVAILABLE")));
      response.on("data", (chunk: Buffer) => { length += chunk.length; if (length > maxBytes) { finish(new MediaNetworkError("INVALID_RESPONSE")); response.destroy(); connection.destroy(); } else chunks.push(chunk); });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status === 401 || status === 403) { finish(new MediaNetworkError("AUTH_REQUIRED")); return; }
        if (status === 429) { const seconds = Number(response.headers["retry-after"]); finish(new MediaNetworkError("RATE_LIMITED", Number.isInteger(seconds) && seconds > 0 && seconds <= 3600 ? seconds : 30)); return; }
        if (status < 200 || status >= 300) { finish(new MediaNetworkError(status >= 500 ? "NETWORK_UNAVAILABLE" : "INVALID_RESPONSE")); return; }
        if ((status === 204 || options.emptyResponse) && length === 0) { finish(null, null); return; }
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { finish(new MediaNetworkError("INVALID_RESPONSE")); }
      });
      if (Number(response.headers["content-length"]) > maxBytes) { finish(new MediaNetworkError("INVALID_RESPONSE")); response.destroy(); connection.destroy(); }
    });
    const abort = () => { finish(new MediaNetworkError("INTERRUPTED")); connection.destroy(); }, timer = setTimeout(() => { finish(new MediaNetworkError("TIMEOUT")); connection.destroy(); }, timeoutMs);
    connection.on("error", () => finish(new MediaNetworkError("NETWORK_UNAVAILABLE")));
    options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) { abort(); return; }
    connection.end(body);
  });
}
