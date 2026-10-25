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
const show = (id) => ({ id, name: id === 1 ? "宿主旧剧集" : "宿主修正剧集", original_name: "Native Batch Fixture", first_air_date: "2026-01-01", seasons: [{ season_number: 1 }] });
const episodes = { episodes: [1, 2].map((episode_number) => ({ episode_number, season_number: 1, name: "宿主分集" + episode_number })) }, tv = config.mediaType === "TV_SHOW";
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json"); const path = new URL(request.url, "http://localhost").pathname;
  response.end(JSON.stringify(path.startsWith("/search/") ? { results: [tv ? show(1) : movie(1)] } : /\/season\//.test(path) ? episodes : path.startsWith("/tv/") ? show(Number(path.split("/").at(-1))) : movie(Number(path.split("/").at(-1)))));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const connections = new MediaConnections(database, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" }), { baseUrl: `http://127.0.0.1:${server.address().port}/` }); connections.install({ tmdb: "isolated-native-host-fixture", emby: null });
let clock = Date.now(), monotonic = 0;
const parser = { ready: true, parse: async (name) => normalizeParse({ title: tv ? "宿主旧剧集" : "宿主旧作品", year: 2026, type: tv ? "episode" : "movie", ...(tv ? { season: 1, episode: Number(/E(\d+)/.exec(name)?.[1]) } : {}) }, name) }, pipeline = new IngestionPipeline(database, () => parser, connections, () => clock, () => monotonic, () => Object.assign(new EventEmitter(), { close() {} }));
try {
  const source = pipeline.bootstrap().find((value) => value.sourceId === config.sourceId); assert(source && source.mode === "local"); assert.equal(source.source.path, config.sourcePath); assert.equal(source.target.path, config.targetPath);
  await pipeline.authorize(source); await pipeline.scan(source.sourceId);
  // 这里只准备已完成夹具，不作为真实下载客户端／120 秒物理稳定窗口的验收。
  for (let index = 0; index < 12; index++) { clock += 10000; monotonic += 10000; await pipeline.scan(source.sourceId); }
  let first;
  for (const candidate of pipeline.list({}).items.filter((value) => value.relativePath.endsWith(".mkv"))) {
    assert.equal(candidate.state, "READY"); const task = await pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await pipeline.tick();
    const preview = await pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: tv ? { tmdbId: 1, mediaType: "TV_SHOW", season: 1, episode: Number(/E(\d+)/.exec(candidate.relativePath)?.[1]) } : { tmdbId: 1, mediaType: "MOVIE" } }); await pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await pipeline.tick(); assert.equal(pipeline.task(task.taskId).state, "DONE");
    if (candidate.relativePath === config.fileName) first = { taskId: task.taskId, targetPath: preview.targetPath, inode: String((await lstat(preview.targetPath, { bigint: true })).ino) };
  }
  assert(first);
  // 后续真实 Main/Core 仍使用生产 TMDB URL；只准备合法响应缓存，不添加生产测试端点。
  for (const [path, value] of [["movie/2", movie(2)], ["tv/2", show(2)], ["tv/2/season/1", episodes]]) {
    const key = createHash("sha256").update(`tmdb-v1|https://api.themoviedb.org/3/${path}?language=zh-CN`).digest("hex"); database.connection.prepare("INSERT OR REPLACE INTO tmdb_cache VALUES(?,?,?)").run(key, JSON.stringify(value), Date.now() + 3600000);
  }
  console.log(JSON.stringify(first));
} finally { await pipeline.close(); connections.close(); database.close(); await new Promise((done) => { server.closeAllConnections(); server.close(done); }); }
