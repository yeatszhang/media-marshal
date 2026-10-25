import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, lstat, statfs, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import { CoreDatabase } from "../infrastructure/database";
import { MediaConnections } from "../application/media-connections";
import { normalizeParse } from "../domain/media";
import { IngestionPipeline } from "./pipeline";
import { SourceRoot } from "../files/source-root";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function grant(path: string, id = randomUUID()): Promise<ManagedRootGrant> {
  const info = await lstat(path, { bigint: true }), volume = await statfs(path, { bigint: true });
  return { id, path, volume: { volumeId: randomUUID(), rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(volume.type), fsType: "test-real-local", caseSensitive: process.platform !== "win32", unicodeEquivalent: true, pathMaxBytes: 4096 } };
}
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-整理 test-"))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "来源"), target = join(directory, "媒体库"); await mkdir(source); await mkdir(target);
  const db = await CoreDatabase.open(join(directory, "core.sqlite3")); cleanup.push(() => db.close());
  let clock = Date.now(), monotonic = 0, calls = 0;
  const server = http.createServer((req, res) => { calls++; const url = new URL(req.url!, "http://localhost"); res.setHeader("Content-Type", "application/json");
    const movie = { id: 1, title: "测试电影", original_title: "Test Movie", release_date: "2026-01-01" };
    if (url.pathname.startsWith("/search/")) res.end(JSON.stringify({ results: [movie] })); else if (url.pathname === "/movie/1") res.end(JSON.stringify(movie)); else res.writeHead(404).end("{}");
  }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const connections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" }), { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }); cleanup.push(() => connections.close()); connections.install({ tmdb: "fixture-tmdb-secret", emby: null });
  const parser = { ready: true, start: async () => {}, close: async () => {}, parse: async (name: string) => normalizeParse({ title: "测试电影", year: 2026, type: "movie" }, name) };
  const pipeline = new IngestionPipeline(db, () => parser, connections, () => clock, () => monotonic); cleanup.push(() => pipeline.close());
  const sourceId = randomUUID(), sourceGrant = await grant(source), targetGrant = await grant(target);
  db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'测试来源','custom',?,?,'AUTO','COPY',?)").run(sourceId, source, target, new Date(clock).toISOString());
  await pipeline.authorize({ sourceId, sourceVersion: 1, mode: "local", downloadRootId: null, source: sourceGrant, target: targetGrant });
  const advance = async (ms = 120000) => { for (let elapsed = 0; elapsed < ms; elapsed += 10000) { monotonic += 10000; clock += 10000; await pipeline.scan(sourceId); } };
  const file = join(source, "测试电影.2026.mp4"), bytes = Buffer.from("真实文件内容，来源必须保留".repeat(1000)); await writeFile(file, bytes);
  const ready = async () => { await pipeline.scan(sourceId); await advance(); return pipeline.list({ sourceId }).items.find((entry) => entry.relativePath === "测试电影.2026.mp4")!; };
  const preview = async () => { const candidate = await ready(); const task = await pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await pipeline.tick(); return pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" } }); };
  return { directory, source, target, db, pipeline, sourceId, sourceGrant, targetGrant, connections, file, bytes, advance, ready, preview, calls: () => calls, jump(ms: number) { monotonic += ms; clock += ms; } };
}
describe("持久候选、人工确认与真实 COPY", () => {
  it("主视频成功但字幕提交失败时独立记账，重试只提交字幕且来源文件全部保留", async () => {
    const f = await fixture(), subtitle = join(f.source, "测试电影.2026.zh-Hans.srt"); await writeFile(subtitle, "fixture-subtitle");
    const preview = await f.preview(); expect(preview.accessories).toHaveLength(1);
    const target = f.pipeline.targets.get(f.targetGrant.id), original = target.commit.bind(target), subtitleTarget = preview.accessories![0]!.targetPath; let blocked = true;
    vi.spyOn(target, "commit").mockImplementation(async (...args) => { if (blocked && args[1].at(-1)!.endsWith(".srt")) await writeFile(subtitleTarget, "foreign-subtitle", { flag: "wx" }); return original(...args); });
    await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    expect(f.pipeline.task(preview.taskId)).toMatchObject({ state: "DONE", accessories: [{ state: "NEEDS_ATTENTION" }] });
    expect(await readFile(preview.targetPath)).toEqual(f.bytes); expect(await readFile(subtitleTarget, "utf8")).toBe("foreign-subtitle");
    expect(f.db.connection.prepare("SELECT state FROM desktop_job").get()).toEqual({ state: "PARTIAL_FAILED" });
    await rm(subtitleTarget); blocked = false; const read = vi.spyOn(SourceRoot.prototype, "digest");
    f.pipeline.retry(preview.taskId); await f.pipeline.tick(); expect(read).not.toHaveBeenCalled();
    expect(await readFile(subtitleTarget, "utf8")).toBe("fixture-subtitle"); expect(await readFile(f.file)).toEqual(f.bytes); expect(await readFile(subtitle, "utf8")).toBe("fixture-subtitle");
    expect(f.pipeline.task(preview.taskId)).toMatchObject({ state: "DONE", accessories: [{ state: "RECORDED" }] });
    expect(f.db.connection.prepare("SELECT state FROM desktop_job").get()).toEqual({ state: "DONE" });
  });
  it("所有扫描入口共享 120 秒稳定观察，零文件和临时文件永远不能就绪；唤醒重新计时", async () => {
    const f = await fixture(); await writeFile(join(f.source, "zero.mp4"), ""); await writeFile(join(f.source, "growing.mp4.part"), "partial");
    await f.pipeline.scan(f.sourceId); f.jump(120000); await f.pipeline.scan(f.sourceId);
    expect(f.pipeline.list({}).items.every((row) => row.state === "OBSERVING")).toBe(true);
    await f.advance(); expect(f.pipeline.list({}).items.filter((row) => row.state === "READY")).toHaveLength(1);
    f.pipeline.resetObservations(); expect(f.pipeline.list({}).items.every((row) => row.state === "OBSERVING")).toBe(true);
    await expect(f.pipeline.recognize({ candidateId: f.pipeline.list({}).items[0]!.id, requestKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(f.file)).toEqual(f.bytes); expect(await readdir(f.target)).toEqual([".media-marshal"]);
  });
  it("人工字段和预览不复制，重复确认只产生一个操作，完成后保留来源并持久化交付意图", async () => {
    const f = await fixture(), preview = await f.preview();
    expect(f.pipeline.task(preview.taskId)).toMatchObject({ state: "AWAITING_CONFIRMATION", matches: [{ tmdbId: 1 }] });
    expect(await readdir(f.target)).toEqual([".media-marshal"]);
    const request = { previewId: preview.id, requestKey: randomUUID() }, result = await f.pipeline.confirm(request); expect(await f.pipeline.confirm(request)).toEqual(result); await f.pipeline.tick();
    expect(await readFile(preview.targetPath)).toEqual(f.bytes); expect(await readFile(f.file)).toEqual(f.bytes);
    expect(f.db.connection.prepare("SELECT phase FROM ingestion_operation").all()).toEqual([{ phase: "RECORDED" }]);
    expect(f.db.connection.prepare("SELECT status,delivery_status FROM media_task").get()).toEqual({ status: "DONE", delivery_status: "REFRESH_PENDING" });
    expect(f.db.connection.prepare("SELECT state FROM emby_delivery").get()).toEqual({ state: "REFRESH_PENDING" });
    expect(await readdir(join(f.target, ".media-marshal/staging"))).toEqual([]);
    expect(JSON.stringify(f.db.connection.prepare("SELECT * FROM app_setting").all())).not.toContain("fixture-tmdb-secret");
    expect(() => f.pipeline.retry(preview.taskId)).toThrow();
  });
  it("预览后原文件被替换或连接轮换，旧确认不能发布文件", async () => {
    const f = await fixture(), preview = await f.preview(); await rename(f.file, f.file + ".old"); await writeFile(f.file, f.bytes);
    await expect(f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
    const next = await f.preview(); f.connections.install({ tmdb: "rotated-fixture-key", emby: null });
    await expect(f.pipeline.confirm({ previewId: next.id, requestKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readdir(f.target)).toEqual([".media-marshal"]);
  });
  it("复制过程中来源变化，正式目标保持不存在，残留只属于本操作", async () => {
    const f = await fixture(), preview = await f.preview(), original = SourceRoot.prototype.digest; let changed = false;
    vi.spyOn(SourceRoot.prototype, "digest").mockImplementation(async function (...args) { const result = await original.apply(this, args); if (!changed && args[3]) { changed = true; await writeFile(f.file, Buffer.alloc(f.bytes.length, 7)); } return result; });
    await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    await expect(lstat(preview.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.db.connection.prepare("SELECT phase FROM ingestion_operation").get()).toEqual({ phase: "NEEDS_ATTENTION" });
    expect(f.pipeline.task(preview.taskId).state).toBe("FAILED"); expect(await readFile(f.file)).toEqual(Buffer.alloc(f.bytes.length, 7));
  });
  it("另一写入者抢先占用正式目标，提交绝不覆盖；已验证暂存可在解除占用后独立重试", async () => {
    const f = await fixture(), preview = await f.preview(), target = f.pipeline.targets.get(f.targetGrant.id), commit = target.commit.bind(target); let block = true;
    vi.spyOn(target, "commit").mockImplementation(async (...args) => { if (block) { await mkdir(dirname(preview.targetPath), { recursive: true }); await writeFile(preview.targetPath, "foreign", { flag: "wx" }); } return commit(...args); });
    await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    expect(await readFile(preview.targetPath, "utf8")).toBe("foreign"); expect(f.pipeline.task(preview.taskId).state).toBe("FAILED");
    await rm(preview.targetPath); block = false;
    const read = vi.spyOn(SourceRoot.prototype, "digest"); f.pipeline.retry(preview.taskId); await f.pipeline.tick();
    expect(read).not.toHaveBeenCalled(); expect(await readFile(preview.targetPath)).toEqual(f.bytes); expect(f.pipeline.task(preview.taskId).state).toBe("DONE");
  });
  it("同一路径的新磁盘身份不能恢复原授权，普通来源与历史目标互相重叠被阻止", async () => {
    const f = await fixture();
    await expect(f.pipeline.authorize({ sourceId: f.sourceId, sourceVersion: 1, mode: "local", downloadRootId: null, source: { ...f.sourceGrant, volume: { ...f.sourceGrant.volume, volumeId: randomUUID() } }, target: f.targetGrant })).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
    await expect(f.pipeline.authorize({ sourceId: f.sourceId, sourceVersion: 1, mode: "local", downloadRootId: null, source: f.sourceGrant, target: { ...f.targetGrant, path: f.source } })).rejects.toThrow();
  });
});
