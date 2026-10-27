import { request } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CloudError } from "@media-marshal/contracts";

const envelope = z.object({ code: z.number().int(), data: z.unknown().optional(), message: z.string().optional() });
export type OpenListFailureReason = "authentication" | "rate-limit" | "not-found" | "network" | "unknown";
function failureReason(code: number, status: number, message = ""): OpenListFailureReason {
  const hint = message.slice(0, 4096);
  if (code === 429 || status === 429 || /too many requests|rate.?limit|请求(?:过于|太)?频繁|访问(?:过于|太)?频繁/i.test(hint)) return "rate-limit";
  if (/proxyconnect|unexpected EOF|i\/o timeout|context deadline|connection (?:reset|refused)|network is unreachable|dial tcp|no such host/i.test(hint)) return "network";
  if (/not.?login|not logged in|(?:need|require|please)\s+login|login\s+(?:required|expired)|请(?:先|重新)(?:登录|登陆)|(?:登录|登陆)(?:已过期|过期|失效)/i.test(hint)) return "authentication";
  if (/object not found|path not found|file not found|文件不存在|目录不存在/i.test(hint)) return "not-found";
  return "unknown";
}
export class OpenListApiError extends Error {
  constructor(readonly code: number, readonly httpStatus: number, readonly reason: OpenListFailureReason = "unknown", readonly resourceId?: number) { super("受管网关请求失败"); this.name = "OpenListApiError"; }
}
export class OpenListClient {
  private token?: string;
  private expiresAt = 0;
  private authenticating?: Promise<void>;
  readonly origin: string;
  constructor(readonly port: number, private readonly jwtSecret: string, private readonly password: string, private readonly alive: () => boolean, private readonly authorizationTimeout = 5000) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CloudError("COMPONENT_UNAVAILABLE");
    this.origin = `http://127.0.0.1:${port}`;
  }
  raw(method: string, path: string, body?: unknown, authorization?: string, timeout = 5000): Promise<{ status: number; bytes: Buffer }> {
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n\0]/.test(path)) return Promise.reject(new CloudError("INVALID_REQUEST"));
    let data: Buffer | undefined;
    try { data = body === undefined ? undefined : Buffer.from(JSON.stringify(body)); } catch { return Promise.reject(new CloudError("INVALID_REQUEST")); }
    if (data && data.length > 2 * 1024 * 1024) return Promise.reject(new CloudError("INVALID_REQUEST"));
    return new Promise((resolve, reject) => {
      const connection = request({ hostname: "127.0.0.1", port: this.port, method, path, agent: false, headers: {
        Connection: "close", ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}), ...(authorization ? { Authorization: authorization } : {}),
      } }, (response) => {
        let length = 0; const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 2 * 1024 * 1024) connection.destroy(); else chunks.push(chunk); });
        response.on("end", () => { if (length > 2 * 1024 * 1024) reject(new CloudError("COMPONENT_UNAVAILABLE")); else resolve({ status: response.statusCode ?? 0, bytes: Buffer.concat(chunks) }); });
        response.on("error", () => reject(new CloudError("NETWORK_UNAVAILABLE")));
      });
      connection.setTimeout(timeout, () => connection.destroy());
      connection.on("error", () => reject(new CloudError("NETWORK_UNAVAILABLE")));
      connection.end(data);
    });
  }
  async ping(): Promise<boolean> { const result = await this.raw("GET", "/ping", undefined, undefined, 500); return result.status === 200 && result.bytes.toString() === "pong"; }
  authenticate(): Promise<void> {
    if (this.authenticating) return this.authenticating;
    this.authenticating = this.login().finally(() => { this.authenticating = undefined; }); return this.authenticating;
  }
  private async login() {
    if (!this.alive()) throw new CloudError("COMPONENT_UNAVAILABLE");
    const response = await this.raw("POST", "/api/auth/login", { username: "admin", password: this.password }, undefined, this.authorizationTimeout);
    let token: string;
    try {
      const value = envelope.parse(JSON.parse(response.bytes.toString("utf8")));
      if (response.status !== 200 || value.code !== 200) throw new Error();
      token = z.object({ token: z.string().max(8192) }).parse(value.data).token;
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error();
      z.object({ alg: z.literal("HS256") }).parse(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")));
      const expected = createHmac("sha256", this.jwtSecret).update(`${parts[0]}.${parts[1]}`).digest();
      const actual = Buffer.from(parts[2]!, "base64url");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
      const claims = z.object({ username: z.literal("admin"), exp: z.number().int(), nbf: z.number().int() }).parse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
      const now = Math.floor(Date.now() / 1000);
      if (claims.exp <= now || claims.nbf > now + 5 || !this.alive()) throw new Error();
      this.expiresAt = claims.exp * 1000;
      this.token = token;
      const me = await this.api("GET", "/api/me", undefined, token);
      z.object({ username: z.literal("admin"), role: z.literal(2) }).parse(me);
    } catch { this.token = undefined; this.expiresAt = 0; throw new CloudError("COMPONENT_UNAVAILABLE"); }
  }
  async api(method: string, path: string, body?: unknown, privateToken?: string): Promise<unknown> {
    if (!this.alive()) throw new CloudError("COMPONENT_UNAVAILABLE");
    if (!privateToken && (!this.token || this.expiresAt - Date.now() < 30000)) await this.authenticate();
    try { return await this.authorized(method, path, body, privateToken ?? this.token); }
    catch (error) {
      // 只有授权层明确拒绝才重新登录；业务失败或网络超时不能重放写请求。
      if (privateToken || !(error instanceof OpenListApiError) || (error.httpStatus !== 401 && error.code !== 401)) throw error;
      this.token = undefined; this.expiresAt = 0;
      await this.authenticate();
      return this.authorized(method, path, body, this.token);
    }
  }
  private async authorized(method: string, path: string, body: unknown, token?: string): Promise<unknown> {
    const response = await this.raw(method, path, body, token, path === "/api/me" ? this.authorizationTimeout : 5000);
    const parsed = envelope.safeParse((() => { try { return JSON.parse(response.bytes.toString("utf8")); } catch { return null; } })());
    // 非 JSON 的 HTTP 限流仍触发账号退避；有效信封继续保留失败挂载的清理 ID。
    if (!parsed.success && response.status === 429) throw new OpenListApiError(429, 429, "rate-limit");
    if (!parsed.success) throw new CloudError("COMPONENT_UNAVAILABLE");
    if (response.status !== 200 || parsed.data.code !== 200) {
      const resource = path === "/api/admin/storage/create" ? z.object({ id: z.number().int().positive() }).safeParse(parsed.data.data) : undefined;
      throw new OpenListApiError(parsed.data.code, response.status, failureReason(parsed.data.code, response.status, parsed.data.message), resource?.success ? resource.data.id : undefined);
    }
    return parsed.data.data;
  }
}
