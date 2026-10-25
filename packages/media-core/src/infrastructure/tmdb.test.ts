import { afterEach, describe, expect, it } from "vitest";
import http, { type Server } from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreDatabase } from "./database";
import { TmdbClient } from "./tmdb";
import { requestJson } from "./json-http";

const servers: Server[] = [], databases: CoreDatabase[] = [], clients: TmdbClient[] = [], directories: string[] = [], sockets = new Set<net.Socket>();
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close()); for (const socket of sockets) socket.destroy(); sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  databases.splice(0).forEach((database) => database.close()); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler); servers.push(server); server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); return { server, url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/` };
}
const rawMovie = { id: 1, title: "测试电影", original_title: "Test Movie", release_date: "2026-01-01", unknown_private_field: "fixture-secret-not-for-cache" };
async function client(url: string, now = Date.now, path = ":memory:") {
  const db = await CoreDatabase.open(path); databases.push(db); const api = new TmdbClient(db, { apiKey: "fixture-api-token", baseUrl: url, now }); clients.push(api); return { api, db };
}
describe("集中元数据网络、持久缓存与取消", () => {
  it("同一请求只访问一次，缓存脱敏且不同消费者不能修改共享元数据", async () => {
    let calls = 0, authorization: string | undefined;
    const { url } = await serve((req, res) => { calls++; authorization = req.headers.authorization; setTimeout(() => res.end(JSON.stringify({ results: [rawMovie] })), 20); });
    const { api, db } = await client(url), [a, b] = await Promise.all([api.search("测试", "MOVIE", 2026), api.search("测试", "MOVIE", 2026)]);
    expect(calls).toBe(1); expect(authorization).toBe("Bearer fixture-api-token"); a[0]!.title = "不能污染缓存";
    expect(b[0]!.title).toBe("测试电影"); expect((await api.search("测试", "MOVIE", 2026))[0]?.title).toBe("测试电影");
    const cached = JSON.stringify(db.connection.prepare("SELECT * FROM tmdb_cache").all()); expect(cached).not.toMatch(/fixture-api-token|unknown_private_field|fixture-secret|Authorization|api_key/);
  });
  it("一个调用者取消不终止共享请求，所有调用者取消时中止且不写缓存", async () => {
    let calls = 0; const { url } = await serve((_req, res) => { calls++; setTimeout(() => res.end(JSON.stringify({ results: [rawMovie] })), 80); });
    const { api, db } = await client(url), first = new AbortController();
    const stopped = expect(api.search("shared", "MOVIE", null, first.signal)).rejects.toMatchObject({ code: "INTERRUPTED" }), other = api.search("shared", "MOVIE", null);
    await expect.poll(() => calls).toBe(1); first.abort(); await stopped; expect(await other).toHaveLength(1); expect(calls).toBe(1);
    const all = new AbortController(), canceled = expect(api.search("all-canceled", "MOVIE", null, all.signal)).rejects.toMatchObject({ code: "INTERRUPTED" });
    await expect.poll(() => calls).toBe(2); all.abort(); await canceled;
    expect(db.connection.prepare("SELECT count(*) AS n FROM tmdb_cache").get()).toEqual({ n: 1 });
    expect(await api.search("all-canceled", "MOVIE", null)).toHaveLength(1); expect(calls).toBe(3);
  });
  it("SQLite 缓存跨连接恢复，TTL 过期后重取，不借旧缓存绕过凭据配置", async () => {
    let clock = Date.now(), calls = 0; const { url } = await serve((_req, res) => { calls++; res.end(JSON.stringify({ results: [rawMovie] })); });
    const path = await mkdtemp(join(tmpdir(), "marshal-tmdb-cache-")); directories.push(path);
    const first = await client(url, () => clock, join(path, "core.sqlite3")); await first.api.search("Movie", "MOVIE", null); first.api.close(); first.db.close();
    const restored = await client(url, () => clock, join(path, "core.sqlite3")); expect(await restored.api.search("Movie", "MOVIE", null)).toHaveLength(1); expect(calls).toBe(1);
    const missing = new TmdbClient(restored.db, { apiKey: null, baseUrl: url }); clients.push(missing); await expect(missing.search("Movie", "MOVIE", null)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    clock += 600001; await restored.api.search("Movie", "MOVIE", null); expect(calls).toBe(2);
  });
  it("网络错误、错误身份详情、缺少实际季列表和重复集号都不缓存为成功", async () => {
    let mode = "network", calls = 0;
    const { url } = await serve((req, res) => {
      calls++; if (mode === "network") { res.writeHead(503).end("fixture-api-token /private/fixture"); return; }
      if (mode === "id") { res.end(JSON.stringify({ ...rawMovie, id: 2 })); return; }
      if (mode === "season") { res.end(JSON.stringify({ id: 1, name: "测试剧集" })); return; }
      res.end(JSON.stringify({ episodes: [{ season_number: 1, episode_number: 1, name: "" }, { season_number: 1, episode_number: 1, name: "" }] }));
    });
    const { api, db } = await client(url);
    const error = await api.search("Movie", "MOVIE", null).catch((error: unknown) => error); expect(error).toMatchObject({ code: "NETWORK_UNAVAILABLE" }); expect(JSON.stringify(error)).not.toMatch(/fixture-api-token|private/);
    mode = "id"; await expect(api.detail(1, "MOVIE")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    mode = "season"; await expect(api.detail(1, "TV_SHOW")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    mode = "duplicate"; await expect(api.episodes(1, 1)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(calls).toBe(4); expect(db.connection.prepare("SELECT count(*) AS n FROM tmdb_cache").get()).toEqual({ n: 0 });
  });
  it("正文、Content-Length、超时、取消和重定向分别有界，不转发原始错误", async () => {
    const { url } = await serve((req, res) => {
      if (req.url === "/length") { res.writeHead(200, { "Content-Length": 9000000 }).end(); return; }
      if (req.url === "/chunk") { res.writeHead(200); res.end("x".repeat(129)); return; }
      if (req.url === "/redirect") { res.writeHead(302, { Location: "https://example.invalid/credential-leak" }).end(); return; }
      if (req.url === "/unauthorized") { res.writeHead(401).end("fixture-private-key"); return; }
      if (req.url === "/limited") { res.writeHead(429, { "Retry-After": "20" }).end("fixture-private-key"); return; }
    });
    await expect(requestJson(new URL("length", url))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(requestJson(new URL("chunk", url), { maxBytes: 128 })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(requestJson(new URL("redirect", url))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(requestJson(new URL("unauthorized", url))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(requestJson(new URL("limited", url))).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 20 });
    await expect(requestJson(new URL("hang", url), { timeoutMs: 30 })).rejects.toMatchObject({ code: "TIMEOUT" });
    const controller = new AbortController(), canceled = expect(requestJson(new URL("hang", url), { signal: controller.signal })).rejects.toMatchObject({ code: "INTERRUPTED" }); controller.abort(); await canceled;
  });
  it("TMDB 只用显式代理，其他服务请求不随环境代理走；不允许带凭据的代理 URL", async () => {
    let tunnels = 0, requests = 0;
    const target = await serve((_req, res) => { requests++; res.end(JSON.stringify({ results: [rawMovie] })); }), proxy = await serve((_req, res) => res.writeHead(405).end());
    proxy.server.on("connect", (request, socket, head) => {
      tunnels++; const destination = new URL("http://" + request.url), peer = net.connect(Number(destination.port), destination.hostname, () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) peer.write(head); peer.pipe(socket); socket.pipe(peer); });
      sockets.add(peer); peer.on("error", () => socket.destroy()); socket.on("error", () => peer.destroy()); peer.once("close", () => sockets.delete(peer)); socket.once("close", () => peer.destroy());
    });
    const db = await CoreDatabase.open(":memory:"); databases.push(db); const api = new TmdbClient(db, { apiKey: "fixture-token", baseUrl: target.url, proxy: proxy.url }); clients.push(api);
    expect(await api.search("Movie", "MOVIE", null)).toHaveLength(1); expect(tunnels).toBe(1);
    const before = process.env.HTTP_PROXY; process.env.HTTP_PROXY = proxy.url;
    try { await requestJson(new URL(target.url)); } finally { if (before === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = before; }
    expect(tunnels).toBe(1); expect(requests).toBe(2);
    expect(() => new TmdbClient(db, { apiKey: "fixture", proxy: "http://user:secret@127.0.0.1:9999" })).toThrow();
  });
});
