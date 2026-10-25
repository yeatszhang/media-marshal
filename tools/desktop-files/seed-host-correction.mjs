// 仅供隔离 Electron 验收：Main 退出后，以其原生授权准备真实 COPY 收据和离线元数据。
import { readFile, lstat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { CoreDatabase } from "../../packages/media-core/dist/infrastructure/database.js";
import { MediaConnections } from "../../packages/media-core/dist/application/media-connections.js";
import { IngestionPipeline } from "../../packages/media-core/dist/ingestion/pipeline.js";
import { normalizeParse } from "../../packages/media-core/dist/domain/media.js";
const config = JSON.parse(await readFile(process.argv[2], "utf8")), database = await CoreDatabase.open(config.database, undefined, { exclusiveOwner: true });
const movie = (id) => ({ id, title: id === 1 ? "宿主旧作品" : "宿主修正作品", original_title: "Native Host Fixture", release_date: "2026-01-01", genres: [] });
const server = createServer((request, response) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(request.url.startsWith("/search/") ? { results: [movie(1)] } : movie(Number(new URL(request.url, "http://localhost").pathname.split("/").at(-1))))); });
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const connections = new MediaConnections(database, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" }), { baseUrl: `http://127.0.0.1:${server.address().port}/` }); connections.install({ tmdb: "isolated-native-host-fixture", emby: null });
let clock = Date.now(), monotonic = 0;
const parser = { ready: true, parse: async (name) => normalizeParse({ title: "宿主旧作品", year: 2026, type: "movie" }, name) }, pipeline = new IngestionPipeline(database, () => parser, connections, () => clock, () => monotonic, () => Object.assign(new EventEmitter(), { close() {} }));
try {
  const source = pipeline.bootstrap().find((value) => value.sourceId === config.sourceId); assert(source && source.mode === "local"); assert.equal(source.source.path, config.sourcePath); assert.equal(source.target.path, config.targetPath);
  await pipeline.authorize(source); await pipeline.scan(source.sourceId);
  // 这里只准备已完成夹具，不作为真实下载客户端／120 秒物理稳定窗口的验收。
  for (let index = 0; index < 12; index++) { clock += 10000; monotonic += 10000; await pipeline.scan(source.sourceId); }
  const candidate = pipeline.list({}).items.find((value) => value.relativePath === config.fileName); assert.equal(candidate?.state, "READY");
  const task = await pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await pipeline.tick();
  const preview = await pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" } }); await pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await pipeline.tick(); assert.equal(pipeline.task(task.taskId).state, "DONE");
  // 后续真实 Main/Core 仍使用生产 TMDB URL；只准备合法响应缓存，不添加生产测试端点。
  const key = createHash("sha256").update("tmdb-v1|https://api.themoviedb.org/3/movie/2?language=zh-CN").digest("hex"); database.connection.prepare("INSERT OR REPLACE INTO tmdb_cache VALUES(?,?,?)").run(key, JSON.stringify(movie(2)), Date.now() + 3600000);
  console.log(JSON.stringify({ taskId: task.taskId, targetPath: preview.targetPath, inode: String((await lstat(preview.targetPath, { bigint: true })).ino) }));
} finally { await pipeline.close(); connections.close(); database.close(); await new Promise((done) => { server.closeAllConnections(); server.close(done); }); }
