import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { OpenListClient } from "./client";

const servers: Server[] = [];
async function serve(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); })); });
describe("受管网关实例与 HTTP 边界", () => {
  it("授权失效后只重新授权一次，业务错误不重放", async () => {
    let logins = 0, calls = 0, writes = 0;
    const signed = () => {
      const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ username: "admin", nbf: 0, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
      return `${header}.${payload}.${createHmac("sha256", "fixture").update(`${header}.${payload}`).digest("base64url")}`;
    };
    const port = await serve((req, res) => {
      req.resume();
      let code = 200, data: unknown;
      if (req.url === "/api/auth/login") { logins++; data = { token: signed() }; }
      else if (req.url === "/api/me") data = { username: "admin", role: 2 };
      else if (req.url === "/api/fixture") { calls++; code = calls === 1 ? 401 : 200; data = "ok"; }
      else { writes++; code = 500; }
      res.end(JSON.stringify({ code, data }));
    });
    const client = new OpenListClient(port, "fixture", "password", () => true);
    expect(await client.api("GET", "/api/fixture")).toBe("ok");
    expect(logins).toBe(2); expect(calls).toBe(2);
    await expect(client.api("POST", "/api/write", {})).rejects.toMatchObject({ code: 500 });
    expect(writes).toBe(1); expect(logins).toBe(2);
  });
  it("HTTP 成功和伪造管理员信息不能代替本次实例的 JWT 签名", async () => {
    const paths: string[] = [];
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ username: "admin", nbf: 0, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    const signature = createHmac("sha256", "wrong-instance").update(`${header}.${payload}`).digest("base64url");
    const port = await serve((req, response) => { paths.push(req.url!); response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ code: 200, data: { token: `${header}.${payload}.${signature}`, username: "admin", role: 2 } })); });
    await expect(new OpenListClient(port, "owned-instance", "fixture-local-password", () => true).authenticate()).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
    expect(paths).toEqual(["/api/auth/login"]);
  });
  it("有界读取和超时不会回传原始错误或连接任意目标", async () => {
    const port = await serve((_req, _response) => {});
    const client = new OpenListClient(port, "secret", "password", () => true);
    await expect(client.raw("GET", "/hang", undefined, undefined, 50)).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    await expect(client.raw("GET", "//example.com/private")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
