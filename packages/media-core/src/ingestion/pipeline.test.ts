import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, realpath, lstat, statfs, readdir, rename, chmod, open, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import { CoreDatabase } from "../infrastructure/database";
import { MediaConnections } from "../application/media-connections";
import { normalizeParse } from "../domain/media";
import { IngestionPipeline } from "./pipeline";
import { CloudRoots } from "../cloud/roots";
import { RemoteCatalog } from "../cloud/catalog";
import { unavailableHost } from "../cloud/host-gateway";
import { CloudDownloads } from "../cloud/downloads";
import { CloudSubscriptions } from "../cloud/subscriptions";
import { SourceRules } from "../sources/rules";
import { SourceRoot } from "../files/source-root";
import { MediaNetworkError } from "../infrastructure/json-http";
import { DesktopError } from "@media-marshal/contracts";
import type { BigIntStats } from "node:fs";
import type { SourceSnapshot } from "../files/source-root";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
async function grant(path: string, id = randomUUID()): Promise<ManagedRootGrant> {
  const info = await lstat(path, { bigint: true }), volume = await statfs(path, { bigint: true });
  return { id, path, volume: { volumeId: randomUUID(), rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(volume.type), fsType: "test-real-local", caseSensitive: process.platform !== "win32", unicodeEquivalent: true, pathMaxBytes: 4096 } };
}
async function fixture(options: { ignoredFilePatterns?: string[] | null; watchFiles?: typeof watch } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-整理 test-"))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "来源"), target = join(directory, "媒体库"); await mkdir(source); await mkdir(target);
  const db = await CoreDatabase.open(join(directory, "core.sqlite3")); cleanup.push(() => db.close());
  let clock = Date.now(), monotonic = 0, calls = 0;
  const server = http.createServer((req, res) => { calls++; const url = new URL(req.url!, "http://localhost"); res.setHeader("Content-Type", "application/json");
    const movie = { id: 1, title: "测试电影", original_title: "Test Movie", release_date: "2026-01-01" };
    if (url.pathname.startsWith("/search/")) res.end(JSON.stringify({ results: [movie] })); else if (url.pathname === "/movie/1") res.end(JSON.stringify(movie)); else res.writeHead(404).end("{}");
  }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const connections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" }), { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }); cleanup.push(() => connections.close()); connections.install({ tmdb: "fixture-tmdb-secret", emby: null });
  const parser = { ready: true, start: async () => {}, close: async () => {}, parse: async (name: string, _signal?: AbortSignal) => normalizeParse({ title: "测试电影", year: 2026, type: "movie" }, name) };
  const pipeline = new IngestionPipeline(db, () => parser, connections, () => clock, () => monotonic, options.watchFiles); cleanup.push(() => pipeline.close());
  const sourceId = randomUUID(), sourceGrant = await grant(source), targetGrant = await grant(target);
  db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'测试来源','custom',?,?,'AUTO','COPY',?)").run(sourceId, source, target, new Date(clock).toISOString());
  await pipeline.authorize({ sourceId, sourceVersion: 1, mode: "local", downloadRootId: null, source: sourceGrant, target: targetGrant });
  if ("ignoredFilePatterns" in options) {
    const configuration = { type: "local", name: "测试来源", client: "custom", sourcePath: source, organization: { targetPath: target }, ignoredFilePatterns: options.ignoredFilePatterns }, stamp = new Date(clock).toISOString();
    db.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,paused,local_source_id,created_at,updated_at) VALUES(?,'local',1,1,?,0,?,?,?)").run(sourceId, JSON.stringify(configuration), sourceId, stamp, stamp);
    db.connection.prepare("INSERT INTO source_rule_version(source_id,version,configuration_json,local_source_id,target_root_id,created_at) VALUES(?,1,?,?,?,?)").run(sourceId, JSON.stringify(configuration), sourceId, targetGrant.id, stamp);
  }
  const advance = async (ms = 120000) => { for (let elapsed = 0; elapsed < ms; elapsed += 10000) { monotonic += 10000; clock += 10000; await pipeline.scan(sourceId); } };
  const file = join(source, "测试电影.2026.mp4"), bytes = Buffer.from("真实文件内容，来源必须保留".repeat(1000)); await writeFile(file, bytes);
  const ready = async () => { await pipeline.scan(sourceId); await advance(); return pipeline.list({ sourceId }).items.find((entry) => entry.relativePath === "测试电影.2026.mp4")!; };
  const preview = async () => { const candidate = await ready(); const task = await pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await pipeline.tick(); return pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" } }); };
  return { directory, source, target, db, pipeline, sourceId, sourceGrant, targetGrant, connections, parser, file, bytes, advance, ready, preview, calls: () => calls, jump(ms: number) { monotonic += ms; clock += ms; }, wallJump(ms: number) { clock += ms; } };
}
describe("识别字段编辑与实际文件边界", () => {
  it("保存字段保留原匹配候选但标记过期，不创建文件操作；旧整理预览失效", async () => {
    const f = await fixture(), p = await f.preview(), before = f.pipeline.task(p.taskId), request = { items: [{ taskId: p.taskId, expectedRevision: 0 }], patch: { title: "人工修订作品" } }, checked = f.pipeline.recognitionEdits.preview(request);
    const result = f.pipeline.recognitionEdits.save({ ...request, fingerprint: checked.fingerprint, requestKey: randomUUID(), rematch: false }); expect(result.updated).toBe(1);
    const saved = f.pipeline.task(p.taskId); expect(saved).toMatchObject({ revision: 1, matchesStale: true, parsed: { title: "人工修订作品" }, matches: before.matches, state: "AWAITING_CONFIRMATION" });
    await expect(f.pipeline.confirm({ previewId: p.id, requestKey: randomUUID() })).rejects.toThrow("识别信息已变化"); await f.pipeline.tick(); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 }); expect(await readFile(f.file)).toEqual(f.bytes); await expect(lstat(p.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("保存并重新匹配使用人工标题且不再解析原文件名，网络失败保留编辑和逐项错误，原任务重试可恢复", async () => {
    const f = await fixture(), p = await f.preview(), request = { items: [{ taskId: p.taskId, expectedRevision: 0 }], patch: { title: "人工修订作品" } }, checked = f.pipeline.recognitionEdits.preview(request);
    f.pipeline.recognitionEdits.save({ ...request, fingerprint: checked.fingerprint, requestKey: randomUUID(), rematch: true });
    const parser = vi.spyOn(f.parser, "parse"), search = vi.spyOn(f.connections.tmdb, "search").mockRejectedValueOnce(new MediaNetworkError("AUTH_REQUIRED"));
    await f.pipeline.tick(); expect(f.pipeline.task(p.taskId)).toMatchObject({ parsed: { title: "人工修订作品" }, revision: 1, state: "AWAITING_CONFIRMATION", failure: expect.stringContaining("密钥") }); expect(parser).not.toHaveBeenCalled();
    await f.pipeline.retry(p.taskId); await f.pipeline.tick(); expect(f.pipeline.task(p.taskId)).toMatchObject({ parsed: { title: "人工修订作品" }, revision: 1, matchesStale: false, state: "AWAITING_CONFIRMATION", failure: null });
    expect(search.mock.calls.every((call) => call[0] === "人工修订作品")).toBe(true); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 1 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 }); expect(await readFile(f.file)).toEqual(f.bytes);
  });
  it("目标检查等待期间保存识别字段，迟到的整理确认被版本栅栏阻止", async () => {
    const f = await fixture(), p = await f.preview(), target = f.pipeline.targets.get(f.targetGrant.id), check = target.check.bind(target); let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; }); cleanup.push(() => release());
    vi.spyOn(target, "check").mockImplementationOnce(async () => { const result = await check(); entered(); await gate; return result; });
    const confirmation = f.pipeline.confirm({ previewId: p.id, requestKey: randomUUID() }), rejected = expect(confirmation).rejects.toThrow("识别信息已变化"); await ready;
    const request = { items: [{ taskId: p.taskId, expectedRevision: 0 }], patch: { title: "检查期间编辑" } }, preview = f.pipeline.recognitionEdits.preview(request); f.pipeline.recognitionEdits.save({ ...request, fingerprint: preview.fingerprint, requestKey: randomUUID(), rematch: false }); release(); await rejected;
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 }); expect(await readFile(f.file)).toEqual(f.bytes);
  });
});
describe("显式全量内容复核与资产版本", () => {
  function coarseAttributes(f: Awaited<ReturnType<typeof fixture>>) {
    const snapshot = JSON.parse((f.db.connection.prepare("SELECT snapshot_json FROM ingestion_candidate WHERE is_current=1").get() as { snapshot_json: string }).snapshot_json) as SourceSnapshot;
    const prototype = SourceRoot.prototype as unknown as { snapshot(info: BigIntStats): SourceSnapshot }, original = prototype.snapshot;
    // 故障注入：文件真实原地写入，但来源报告粗粒度时间属性；不宣称 APFS 实际 ctime 未变。
    vi.spyOn(prototype, "snapshot").mockImplementation(function (this: SourceRoot, info) { const actual = original.call(this, info); return actual.inode === snapshot.inode ? { ...actual, modifiedNs: snapshot.modifiedNs, changedNs: snapshot.changedNs } : actual; });
    return snapshot;
  }
  const current = (f: Awaited<ReturnType<typeof fixture>>) => f.db.connection.prepare("SELECT * FROM ingestion_candidate WHERE is_current=1").get() as { id: string; expected_sha256: string | null; state: string; snapshot_json: string };
  const review = async (f: Awaited<ReturnType<typeof fixture>>) => { const job = f.pipeline.reviewContent({ sourceId: f.sourceId, requestKey: randomUUID() }); await f.pipeline.contentReviews.idle(); return f.pipeline.contentReviews.list({}).items.find((row) => row.id === job.id)!; };
  it("首轮建立基线、再次核对不变，重复请求和并发点击复用同一持久作业", async () => {
    const f = await fixture(); await f.pipeline.scan(f.sourceId); const id = current(f).id, requestKey = randomUUID();
    const first = f.pipeline.reviewContent({ sourceId: f.sourceId, requestKey });
    expect(f.pipeline.reviewContent({ sourceId: f.sourceId, requestKey: randomUUID() }).id).toBe(first.id);
    await f.pipeline.contentReviews.idle();
    expect(f.pipeline.reviewContent({ sourceId: f.sourceId, requestKey })).toMatchObject({ id: first.id, state: "COMPLETED", total: 1, checked: 1, baselined: 1, changed: 0 });
    expect(current(f)).toMatchObject({ id, expected_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), state: "OBSERVING" });
    expect(await review(f)).toMatchObject({ state: "COMPLETED", total: 1, checked: 1, baselined: 0, changed: 0 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 }); expect(await readdir(f.target)).not.toContain("测试电影 (2026) [tmdb-1]");
  });
  it("已完成文件的同属性替换生成新候选，保留历史和目标，并发扫描与领取仍只有一项", async () => {
    const f = await fixture(), preview = await f.preview(); await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    const old = current(f), originalInode = (await lstat(preview.targetPath, { bigint: true })).ino; expect(old.expected_sha256).toMatch(/^[a-f0-9]{64}$/); coarseAttributes(f);
    await writeFile(f.file, Buffer.alloc(f.bytes.length, 65)); await Promise.all([f.pipeline.scan(f.sourceId), f.pipeline.scan(f.sourceId)]);
    expect(current(f).id).toBe(old.id); expect(current(f).state).toBe("PROCESSED");
    const result = await review(f); expect(result).toMatchObject({ state: "COMPLETED", changed: 1, checked: 1 });
    const next = current(f); expect(next).toMatchObject({ state: "OBSERVING" }); expect(next.id).not.toBe(old.id); expect(next.snapshot_json).toBe(old.snapshot_json);
    expect(f.pipeline.task(preview.taskId).state).toBe("DONE"); expect(await readFile(preview.targetPath)).toEqual(f.bytes); expect((await lstat(preview.targetPath, { bigint: true })).ino).toBe(originalInode);
    await Promise.all([f.pipeline.scan(f.sourceId), f.pipeline.scan(f.sourceId)]); expect(current(f).id).toBe(next.id);
    await expect(f.pipeline.recognize({ candidateId: next.id, requestKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    await f.advance(); const claims = await Promise.all([f.pipeline.recognize({ candidateId: next.id, requestKey: randomUUID() }), f.pipeline.recognize({ candidateId: next.id, requestKey: randomUUID() })]); expect(claims[0]).toEqual(claims[1]); await f.pipeline.tick();
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_candidate WHERE is_current=1").get()).toEqual({ n: 1 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
    expect(f.pipeline.contentReviews.items({ id: result.id }).items).toMatchObject([{ state: "CHANGED", candidateId: next.id, relativePath: "测试电影.2026.mp4" }]);
  });
  it("A→B→A 不复用已处理资产版本，唯一约束阻止两个当前候选", async () => {
    const f = await fixture(); await f.pipeline.scan(f.sourceId); await review(f); coarseAttributes(f); const a = current(f).id;
    await writeFile(f.file, Buffer.alloc(f.bytes.length, 66)); expect((await review(f)).changed).toBe(1); const b = current(f).id;
    await writeFile(f.file, f.bytes); expect((await review(f)).changed).toBe(1); const nextA = current(f).id;
    expect(new Set([a, b, nextA]).size).toBe(3); await f.pipeline.scan(f.sourceId); expect(current(f).id).toBe(nextA);
    expect(() => f.db.connection.prepare("UPDATE ingestion_candidate SET is_current=1 WHERE id=?").run(a)).toThrow();
  });
  it("复核进行中拒绝旧预览确认，取消不会把未读文件标为通过或写入基线", async () => {
    const f = await fixture(), preview = await f.preview(); let release!: () => void;
    const entered = new Promise<void>((resolve) => { release = resolve; }), original = SourceRoot.prototype.digest; let blocked = true, started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(SourceRoot.prototype, "digest").mockImplementation(async function (this: SourceRoot, ...args) { if (blocked) { blocked = false; started(); await entered; } return original.apply(this, args); });
    const job = f.pipeline.reviewContent({ sourceId: f.sourceId, requestKey: randomUUID() }); await ready;
    await expect(f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() })).rejects.toThrow("正在全量复核");
    expect(f.pipeline.contentReviews.cancel(job.id)).toMatchObject({ state: "CANCELLED", checked: 0 }); release(); await f.pipeline.contentReviews.idle();
    expect(current(f).expected_sha256).toBeNull(); expect(f.pipeline.contentReviews.items({ id: job.id }).items[0]?.state).toBe("PENDING");
    expect((await review(f)).baselined).toBe(1); await expect(f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() })).rejects.toThrow("证据已更新");
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
  });
  it("关闭中断的文件保持待复核，数据库重开后继续同一作业且不重复候选", async () => {
    const f = await fixture(); await f.pipeline.scan(f.sourceId); let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    const spy = vi.spyOn(SourceRoot.prototype, "digest").mockImplementationOnce(async (_handle, _size, signal) => { started(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DesktopError("INTERRUPTED", "测试关闭")), { once: true })); return ""; });
    const job = f.pipeline.reviewContent({ sourceId: f.sourceId, requestKey: randomUUID() }); await ready; await f.pipeline.close(); spy.mockRestore(); f.connections.close(); f.db.close();
    const db = await CoreDatabase.open(join(f.directory, "core.sqlite3")); cleanup.push(() => db.close()); const connections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" })); cleanup.push(() => connections.close());
    const pipeline = new IngestionPipeline(db, () => undefined, connections); cleanup.push(() => pipeline.close()); await pipeline.tick(); await pipeline.contentReviews.idle();
    expect(pipeline.contentReviews.list({}).items[0]).toMatchObject({ id: job.id, state: "WAITING_SOURCE", checked: 0 });
    await pipeline.authorize({ sourceId: f.sourceId, sourceVersion: 1, mode: "local", source: f.sourceGrant, target: f.targetGrant }); await pipeline.tick(); await pipeline.contentReviews.idle();
    expect(pipeline.contentReviews.list({}).items[0]).toMatchObject({ id: job.id, state: "COMPLETED", checked: 1, baselined: 1 }); expect(db.connection.prepare("SELECT count(*) AS n FROM ingestion_candidate").get()).toEqual({ n: 1 });
  });
  it("单文件失败持久显示对象，其他文件继续；规则变化不提交迟到摘要", async () => {
    const f = await fixture(); const denied = join(f.source, "不可读.mp4"); await writeFile(denied, "保留"); const original = SourceRoot.prototype.inspect;
    const spy = vi.spyOn(SourceRoot.prototype, "inspect").mockImplementation(function (this: SourceRoot, path) { if (path.at(-1) === "不可读.mp4") return Promise.reject(new DesktopError("LOCAL_UNAVAILABLE", "文件无法读取，请检查权限")); return original.call(this, path); });
    const result = await review(f); expect(result).toMatchObject({ state: "PARTIAL_FAILED", checked: 2, failed: 1, baselined: 1 }); expect(f.pipeline.contentReviews.items({ id: result.id }).items[0]).toMatchObject({ relativePath: "不可读.mp4", state: "FAILED", failure: expect.stringContaining("权限") }); spy.mockRestore();
    let release!: () => void, started!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { started = resolve; }), digest = SourceRoot.prototype.digest;
    vi.spyOn(SourceRoot.prototype, "digest").mockImplementationOnce(async function (this: SourceRoot, ...args) { started(); await gate; return digest.apply(this, args); });
    const job = f.pipeline.reviewContent({ sourceId: f.sourceId, requestKey: randomUUID() }); await ready; f.db.connection.prepare("UPDATE desktop_source SET version=2 WHERE id=?").run(f.sourceId); release(); await f.pipeline.contentReviews.idle();
    expect(f.pipeline.contentReviews.list({}).items.find((row) => row.id === job.id)).toMatchObject({ state: "FAILED", checked: 0, failure: expect.stringContaining("配置已变化") }); expect(await readFile(denied, "utf8")).toBe("保留");
  });
  it("候选版本与单项结果同事务，记账失败不留下未报告的新版本", async () => {
    const f = await fixture(); await f.pipeline.scan(f.sourceId); await review(f); const old = current(f); coarseAttributes(f); await writeFile(f.file, Buffer.alloc(f.bytes.length, 67));
    const original = f.db.connection.prepare.bind(f.db.connection); let injected = false;
    vi.spyOn(f.db.connection, "prepare").mockImplementation((sql) => { if (!injected && sql.startsWith("UPDATE ingestion_content_review_file SET state=?,")) { injected = true; throw new Error("受控记账中断"); } return original(sql); });
    const result = await review(f); expect(result).toMatchObject({ state: "PARTIAL_FAILED", failed: 1, changed: 0 }); expect(current(f)).toEqual(old); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_candidate").get()).toEqual({ n: 1 });
    expect((await review(f)).changed).toBe(1);
  });
  it("来源目录在读取期间失联保留待复核，原目录恢复后继续；已知缺失文件可逐项定位", async () => {
    const f = await fixture(); await f.pipeline.scan(f.sourceId); let release!: () => void, started!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { started = resolve; }), digest = SourceRoot.prototype.digest;
    vi.spyOn(SourceRoot.prototype, "digest").mockImplementationOnce(async function (this: SourceRoot, ...args) { started(); await gate; return digest.apply(this, args); });
    const job = f.pipeline.reviewContent({ sourceId: f.sourceId, requestKey: randomUUID() }); await ready; await rename(f.source, f.source + "-离线"); release(); await f.pipeline.contentReviews.idle();
    expect(f.pipeline.contentReviews.list({}).items[0]).toMatchObject({ id: job.id, state: "WAITING_SOURCE", checked: 0 }); expect(current(f).expected_sha256).toBeNull();
    await rename(f.source + "-离线", f.source); await f.pipeline.tick(); await f.pipeline.contentReviews.idle(); expect(f.pipeline.contentReviews.list({}).items[0]).toMatchObject({ id: job.id, state: "COMPLETED", checked: 1 });
    await rename(f.file, f.file + ".保留"); const missing = await review(f); expect(missing).toMatchObject({ state: "PARTIAL_FAILED", total: 1, failed: 1 }); expect(f.pipeline.contentReviews.items({ id: missing.id }).items[0]).toMatchObject({ relativePath: "测试电影.2026.mp4", state: "FAILED" });
  });
  it("活动 COPY 阻断复核启动，安全点后只读复核不重写媒体", async () => {
    const f = await fixture(), preview = await f.preview(), target = f.pipeline.targets.get(f.targetGrant.id), prepare = target.prepareStage.bind(target); let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(target, "prepareStage").mockImplementationOnce(async (...args) => { started(); await gate; return prepare(...args); });
    await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await ready;
    expect(() => f.pipeline.reviewContent({ sourceId: f.sourceId, requestKey: randomUUID() })).toThrow("活动整理"); release(); await f.pipeline.tick();
    const inode = (await lstat(preview.targetPath, { bigint: true })).ino; expect(await review(f)).toMatchObject({ state: "COMPLETED", baselined: 0, changed: 0 }); expect((await lstat(preview.targetPath, { bigint: true })).ino).toBe(inode);
  });
  it("确认等待目录核验时完成复核，事务提交仍拒绝不含新摘要的旧预览", async () => {
    const f = await fixture(), preview = await f.preview(), target = f.pipeline.targets.get(f.targetGrant.id), vacant = target.assertVacant.bind(target);
    vi.spyOn(target, "assertVacant").mockImplementationOnce(async (...args) => { await vacant(...args); await review(f); });
    await expect(f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() })).rejects.toThrow("证据已更新");
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
  });
  it("复制校验后尚未记阶段即暂停，恢复旧计划仍核对已保存摘要而不接受静默替换", async () => {
    const f = await fixture(), preview = await f.preview(), target = f.pipeline.targets.get(f.targetGrant.id), verify = target.verifyStage.bind(target); coarseAttributes(f);
    vi.spyOn(target, "verifyStage").mockImplementationOnce(async (...args) => { const evidence = await verify(...args); f.pipeline.setPaused({ paused: true, requestKey: randomUUID() }); return evidence; });
    await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick(); expect(current(f).expected_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.db.connection.prepare("SELECT phase,evidence_json FROM ingestion_operation").get()).toEqual({ phase: "COPYING", evidence_json: null });
    await writeFile(f.file, Buffer.alloc(f.bytes.length, 68)); f.pipeline.setPaused({ paused: false, requestKey: randomUUID() }); await f.pipeline.scan(f.sourceId); await f.advance(); await f.pipeline.tick();
    expect(f.pipeline.task(preview.taskId)).toMatchObject({ state: "FAILED" }); await expect(lstat(preview.targetPath)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(f.file)).toEqual(Buffer.alloc(f.bytes.length, 68));
  });
});

describe("持久候选、人工确认与真实 COPY", () => {
  it("暂停来源 A 不取消正在复制的来源 B，B 保留原计划并正常完成", async () => {
    const f = await fixture(), sourceId = randomUUID(), source = join(f.directory, "另一输入"), target = join(f.directory, "另一媒体库"); await mkdir(source); await mkdir(target);
    const sourceGrant = await grant(source), targetGrant = await grant(target), file = join(source, "另一电影.2026.mp4"); await writeFile(file, f.bytes);
    f.db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'来源 B','custom',?,?,'MOVIE','COPY',?)").run(sourceId, source, target, new Date().toISOString());
    await f.pipeline.authorize({ sourceId, sourceVersion: 1, mode: "local", source: sourceGrant, target: targetGrant }); await Promise.all([f.pipeline.scan(f.sourceId), f.pipeline.scan(sourceId)]);
    for (let index = 0; index < 12; index++) { f.jump(10000); await Promise.all([f.pipeline.scan(f.sourceId), f.pipeline.scan(sourceId)]); }
    const candidate = f.pipeline.list({ sourceId }).items.find((row) => row.state === "READY")!, task = await f.pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await f.pipeline.tick();
    const preview = await f.pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" } });
    let entered!: () => void, release!: () => void, held = false; const ready = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; }), digest = SourceRoot.prototype.digest;
    vi.spyOn(SourceRoot.prototype, "digest").mockImplementation(function (this: SourceRoot, handle, size, signal, consume) { return digest.call(this, handle, size, signal, consume && (async (bytes) => { await consume(bytes); if (this.grant.id === sourceGrant.id && !held) { held = true; entered(); await gate; } })); });
    await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await ready;
    f.db.connection.prepare("UPDATE desktop_source SET paused=1 WHERE id=?").run(f.sourceId); f.pipeline.sourceChanged(f.sourceId); release(); await f.pipeline.tick();
    expect(f.pipeline.task(task.taskId).state).toBe("DONE"); expect(await readFile(preview.targetPath)).toEqual(f.bytes); expect(await readFile(file)).toEqual(f.bytes); expect(await readFile(f.file)).toEqual(f.bytes);
  });
  it("暂停自身只中断未发布复制，恢复后重新观察并继续同一计划", async () => {
    const f = await fixture(), preview = await f.preview(), digest = SourceRoot.prototype.digest; let entered!: () => void, release!: () => void, signal!: AbortSignal, held = false;
    const ready = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    cleanup.push(() => release());
    vi.spyOn(SourceRoot.prototype, "digest").mockImplementation(function (this: SourceRoot, handle, size, active, consume) { return digest.call(this, handle, size, active, consume && (async (bytes) => { await consume(bytes); if (!held) { held = true; signal = active; entered(); await gate; } })); });
    const operation = await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await ready;
    f.db.connection.prepare("UPDATE desktop_source SET paused=1 WHERE id=?").run(f.sourceId); f.pipeline.sourceChanged(f.sourceId); expect(signal.aborted).toBe(true); release(); await f.pipeline.tick();
    expect(f.db.connection.prepare("SELECT id,phase,failure_code FROM ingestion_operation").get()).toEqual({ id: operation.operationId, phase: "COPYING", failure_code: null }); await expect(lstat(preview.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    f.db.connection.prepare("UPDATE desktop_source SET paused=0 WHERE id=?").run(f.sourceId); f.pipeline.sourceChanged(f.sourceId); await f.pipeline.tick(); await expect(lstat(preview.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await f.advance(); await f.pipeline.tick(); expect(f.pipeline.task(preview.taskId).state).toBe("DONE"); expect(f.db.connection.prepare("SELECT id FROM ingestion_operation").all()).toEqual([{ id: operation.operationId }]); expect(await readFile(f.file)).toEqual(f.bytes);
  });
  it("删除来源须等实际写入停止，恢复后沿用原 COPY 计划与领取，已完成文件和历史保留", async () => {
    const f = await fixture({ ignoredFilePatterns: null }), roots = new CloudRoots(f.db); cleanup.push(() => roots.close());
    const catalog = new RemoteCatalog(f.db, unavailableHost), downloads = new CloudDownloads(f.db, unavailableHost, catalog, roots); cleanup.push(() => downloads.close());
    const subscriptions = new CloudSubscriptions(f.db, downloads, catalog, roots); cleanup.push(() => subscriptions.close());
    const rules = new SourceRules(f.db, downloads, subscriptions, f.pipeline); cleanup.push(() => rules.close());
    const preview = await f.preview(), digest = SourceRoot.prototype.digest; let entered!: () => void, release!: () => void, held = false;
    const ready = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; }); cleanup.push(() => release());
    vi.spyOn(SourceRoot.prototype, "digest").mockImplementation(function (this: SourceRoot, handle, size, signal, consume) { return digest.call(this, handle, size, signal, consume && (async (bytes) => { await consume(bytes); if (!held) { held = true; entered(); await gate; } })); });
    const op = await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await ready;
    const command = { id: f.sourceId, expectedVersion: 1, expectedDraftRevision: 1, expectedLifecycleRevision: 0, requestKey: randomUUID() };
    expect(() => rules.lifecycle(command, "remove")).toThrow("活动整理任务"); expect(rules.get(f.sourceId)?.deletedAt).toBeNull();
    rules.control({ id: f.sourceId, expectedVersion: 1, requestKey: randomUUID(), operation: "pause" });
    expect(() => rules.lifecycle(command, "remove")).toThrow("活动整理任务"); release(); await f.pipeline.tick();
    const plan = f.db.connection.prepare("SELECT id,plan_json,phase FROM ingestion_operation").get(); expect(plan).toMatchObject({ id: op.operationId, phase: "COPYING" });
    rules.lifecycle(command, "remove"); await f.pipeline.tick(); expect(f.db.connection.prepare("SELECT id,plan_json,phase FROM ingestion_operation").get()).toEqual(plan);
    rules.lifecycle({ ...command, expectedLifecycleRevision: 1, requestKey: randomUUID() }, "restore"); await f.pipeline.tick(); await expect(lstat(preview.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    rules.control({ id: f.sourceId, expectedVersion: 1, expectedLifecycleRevision: 2, requestKey: randomUUID(), operation: "resume" }); await f.pipeline.scan(f.sourceId); await f.advance(); await f.pipeline.tick();
    expect(f.pipeline.task(preview.taskId).state, JSON.stringify(f.db.connection.prepare("SELECT * FROM ingestion_operation").get())).toBe("DONE"); expect(f.db.connection.prepare("SELECT id,phase,plan_json FROM ingestion_operation").get()).toMatchObject({ id: op.operationId, phase: "RECORDED", plan_json: (plan as { plan_json: string }).plan_json });
    const inode = (await lstat(preview.targetPath, { bigint: true })).ino; rules.lifecycle({ ...command, expectedLifecycleRevision: 2, requestKey: randomUUID() }, "remove");
    expect(f.pipeline.task(preview.taskId).state).toBe("DONE"); expect((await lstat(preview.targetPath, { bigint: true })).ino).toBe(inode); expect(await readFile(f.file)).toEqual(f.bytes);
  });
  it("整理确认等待目标检查时删除并恢复来源，旧确认与旧预览失效，重新预览后才可继续", async () => {
    const f = await fixture({ ignoredFilePatterns: null }), roots = new CloudRoots(f.db); cleanup.push(() => roots.close());
    const catalog = new RemoteCatalog(f.db, unavailableHost), downloads = new CloudDownloads(f.db, unavailableHost, catalog, roots); cleanup.push(() => downloads.close());
    const subscriptions = new CloudSubscriptions(f.db, downloads, catalog, roots); cleanup.push(() => subscriptions.close());
    const rules = new SourceRules(f.db, downloads, subscriptions, f.pipeline); cleanup.push(() => rules.close());
    const preview = await f.preview(), target = f.pipeline.targets.get(f.targetGrant.id), check = target.check.bind(target); let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; }); cleanup.push(() => release());
    const spy = vi.spyOn(target, "check").mockImplementationOnce(async () => { const result = await check(); entered(); await gate; return result; });
    const confirmation = f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }), rejected = expect(confirmation).rejects.toMatchObject({ code: "CONFLICT" }); await ready;
    const command = { id: f.sourceId, expectedVersion: 1, expectedDraftRevision: 1, expectedLifecycleRevision: 0, requestKey: randomUUID() };
    rules.lifecycle(command, "remove"); rules.lifecycle({ ...command, expectedLifecycleRevision: 1, requestKey: randomUUID() }, "restore"); rules.control({ id: f.sourceId, expectedVersion: 1, expectedLifecycleRevision: 2, operation: "resume", requestKey: randomUUID() }); release(); await rejected; spy.mockRestore();
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
    await f.pipeline.scan(f.sourceId); await f.advance(); await expect(f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() })).rejects.toThrow("重新预览整理范围");
    const fresh = await f.pipeline.preview({ taskId: preview.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" } }); await f.pipeline.confirm({ previewId: fresh.id, requestKey: randomUUID() }); await f.pipeline.tick(); expect(f.pipeline.task(preview.taskId).state).toBe("DONE"); expect(await readFile(f.file)).toEqual(f.bytes);
  });
  it("正式文件已发布时暂停来源仍完成原操作记账，不回滚媒体文件", async () => {
    const f = await fixture(), preview = await f.preview(), target = f.pipeline.targets.get(f.targetGrant.id), commit = target.commit.bind(target);
    vi.spyOn(target, "commit").mockImplementationOnce(async (...args) => { const evidence = await commit(...args); f.db.connection.prepare("UPDATE desktop_source SET paused=1 WHERE id=?").run(f.sourceId); f.pipeline.sourceChanged(f.sourceId); return evidence; });
    await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick(); expect(f.pipeline.task(preview.taskId).state).toBe("DONE"); expect(await readFile(preview.targetPath)).toEqual(f.bytes); expect(f.db.connection.prepare("SELECT phase FROM ingestion_operation").get()).toEqual({ phase: "RECORDED" });
  });
  it("识别中的所属来源暂停后回到待识别，恢复观察后复用原任务而非报识别失败", async () => {
    const f = await fixture(), candidate = await f.ready(), parse = f.parser.parse; let entered!: () => void, release!: () => void, active!: AbortSignal;
    const ready = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    cleanup.push(() => release());
    vi.spyOn(f.parser, "parse").mockImplementationOnce(async (name, signal) => { active = signal!; entered(); await gate; if (signal?.aborted) throw new DesktopError("INTERRUPTED", "测试来源取消"); return parse(name, signal); });
    const task = await f.pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await ready;
    f.db.connection.prepare("UPDATE desktop_source SET paused=1 WHERE id=?").run(f.sourceId); f.pipeline.sourceChanged(f.sourceId); expect(active.aborted).toBe(true); release(); await f.pipeline.tick();
    expect(f.pipeline.task(task.taskId)).toMatchObject({ state: "PENDING", failure: expect.stringContaining("等待恢复") });
    f.db.connection.prepare("UPDATE desktop_source SET paused=0 WHERE id=?").run(f.sourceId); f.pipeline.sourceChanged(f.sourceId); await f.pipeline.scan(f.sourceId); await f.advance(); await f.pipeline.tick();
    expect(f.pipeline.task(task.taskId)).toMatchObject({ state: "AWAITING_CONFIRMATION", parsed: { title: "测试电影" } }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 1 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
  });
  it("恢复核对幂等且不重放 COPY，主文件与字幕通过后重新等待 Emby 核对", async () => {
    const f = await fixture(); await writeFile(join(f.source, "测试电影.2026.zh.srt"), "字幕内容");
    const preview = await f.preview(); await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    const paths = [preview.targetPath, f.pipeline.task(preview.taskId).accessories![0]!.targetPath], identities = await Promise.all(paths.map((path) => lstat(path, { bigint: true }).then((entry) => entry.ino)));
    f.db.connection.prepare("UPDATE emby_delivery SET state='COLLECTED',emby_item_id='旧收录证据'").run();
    const stage = vi.spyOn(f.pipeline.targets.get(f.targetGrant.id), "prepareStage"), readSource = vi.spyOn(SourceRoot.prototype, "read");
    f.pipeline.reconcileRestored(); f.pipeline.reconcileRestored();
    expect(f.pipeline.task(preview.taskId)).toMatchObject({ state: "PROCESSING", failure: expect.stringContaining("不会重新复制") });
    expect(() => f.pipeline.retry(preview.taskId)).toThrow("尚待核对"); await f.pipeline.tick();
    expect(f.pipeline.task(preview.taskId).state).toBe("DONE"); expect(f.db.connection.prepare("SELECT state,emby_item_id FROM emby_delivery").get()).toEqual({ state: "REFRESH_PENDING", emby_item_id: null });
    expect(await Promise.all(paths.map((path) => lstat(path, { bigint: true }).then((entry) => entry.ino)))).toEqual(identities);
    expect(stage).not.toHaveBeenCalled(); expect(readSource).not.toHaveBeenCalled(); expect((await readFile(f.file)).equals(f.bytes)).toBe(true);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM app_setting WHERE key LIKE 'ingestion.restore.audit.%'").get()).toEqual({ n: 0 });
  });
  it.each(["原文件被改写", "同内容被另一文件替换", "文件已删除"])("恢复核对发现%s时保留现状，不从来源重建目标", async (variant) => {
    const f = await fixture(), preview = await f.preview(); await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    if (variant === "原文件被改写") await writeFile(preview.targetPath, Buffer.alloc(f.bytes.length, 65));
    else if (variant === "同内容被另一文件替换") { const foreign = join(f.directory, "替换文件"); await writeFile(foreign, f.bytes); await rename(foreign, preview.targetPath); }
    else await rm(preview.targetPath);
    const preserved = variant === "文件已删除" ? null : await readFile(preview.targetPath), identity = preserved ? (await lstat(preview.targetPath, { bigint: true })).ino : null;
    const stage = vi.spyOn(f.pipeline.targets.get(f.targetGrant.id), "prepareStage"); f.pipeline.reconcileRestored(); await f.pipeline.tick();
    expect(f.pipeline.task(preview.taskId)).toMatchObject({ state: "FAILED", failure: expect.stringContaining("目标证据不符") });
    expect(f.db.connection.prepare("SELECT phase,failure_code FROM ingestion_operation").get()).toEqual({ phase: "NEEDS_ATTENTION", failure_code: "CONFLICT" });
    expect(f.db.connection.prepare("SELECT state FROM emby_delivery").get()).toEqual({ state: "NEEDS_ATTENTION" }); expect(stage).not.toHaveBeenCalled();
    if (preserved) { expect((await readFile(preview.targetPath)).equals(preserved)).toBe(true); expect((await lstat(preview.targetPath, { bigint: true })).ino).toBe(identity); }
    else await expect(lstat(preview.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(f.file)).equals(f.bytes)).toBe(true);
  });
  it("恢复核对中字幕冲突独立标记，主视频保持完成且不被重新复制", async () => {
    const f = await fixture(); await writeFile(join(f.source, "测试电影.2026.zh.srt"), "原字幕");
    const preview = await f.preview(); await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    const asset = f.pipeline.task(preview.taskId).accessories![0]!, inode = (await lstat(preview.targetPath, { bigint: true })).ino; await writeFile(asset.targetPath, "用户修改的字幕");
    f.pipeline.reconcileRestored(); await f.pipeline.tick();
    expect(f.pipeline.task(preview.taskId)).toMatchObject({ state: "DONE", accessories: [{ state: "NEEDS_ATTENTION", failure: "CONFLICT" }] });
    expect(f.db.connection.prepare("SELECT state FROM desktop_job").get()).toEqual({ state: "PARTIAL_FAILED" });
    expect((await lstat(preview.targetPath, { bigint: true })).ino).toBe(inode); expect(await readFile(asset.targetPath, "utf8")).toBe("用户修改的字幕");
  });
  it("恢复核对队列跨数据库重开保留，目标缺盘不丢证据，原目标授权后只读核对", async () => {
    const f = await fixture(), preview = await f.preview(); await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    const inode = (await lstat(preview.targetPath, { bigint: true })).ino;
    f.pipeline.setPaused({ paused: true, requestKey: randomUUID() }); f.pipeline.reconcileRestored(); await f.pipeline.close(); f.connections.close(); f.db.close();
    const db = await CoreDatabase.open(join(f.directory, "core.sqlite3")); cleanup.push(() => db.close());
    const connections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" })); cleanup.push(() => connections.close());
    const restored = new IngestionPipeline(db, () => undefined, connections); cleanup.push(() => restored.close());
    await restored.tick(); expect(restored.task(preview.taskId)).toMatchObject({ state: "PROCESSING", failure: expect.stringContaining("暂不可访问") });
    expect(db.connection.prepare("SELECT count(*) AS n FROM app_setting WHERE key LIKE 'ingestion.restore.audit.%'").get()).toEqual({ n: 1 });
    await restored.authorizeTarget(f.targetGrant); await restored.tick(); expect(restored.task(preview.taskId).state).toBe("DONE");
    expect(restored.pauseStatus().paused).toBe(true); expect((await lstat(preview.targetPath, { bigint: true })).ino).toBe(inode); expect((await readFile(f.file)).equals(f.bytes)).toBe(true);
  });
  it("来源整目录短暂失联也保留候选并重置窗口，原目录恢复后重新观察 120 秒", async () => {
    const f = await fixture(), candidate = await f.ready(), detached = f.source + "-暂时离线"; await rename(f.source, detached);
    try {
      await expect(f.pipeline.scan(f.sourceId)).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
      expect(f.pipeline.list({ sourceId: f.sourceId }).items).toMatchObject([{ id: candidate.id, state: "UNAVAILABLE", reason: expect.stringContaining("来源目录不可访问") }]);
      expect(f.db.connection.prepare("SELECT health FROM desktop_source WHERE id=?").get(f.sourceId)).toEqual({ health: "unavailable" });
      await expect(lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" }); f.jump(10000);
    } finally { await rename(detached, f.source); }
    await f.pipeline.scan(f.sourceId); await f.advance(110000);
    expect(f.pipeline.list({ sourceId: f.sourceId }).items).toMatchObject([{ id: candidate.id, state: "OBSERVING" }]);
    await f.advance(10000); expect(f.pipeline.list({ sourceId: f.sourceId }).items).toMatchObject([{ id: candidate.id, state: "READY", requiresConfirmation: true }]);
    expect(f.calls()).toBe(0); expect(await readFile(f.file)).toEqual(f.bytes); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
  });
  it("失联后同名替代目录不能被认领，不扫描替代文件或删除原候选", async () => {
    const f = await fixture(), candidate = await f.ready(), detached = f.source + "-原目录"; await rename(f.source, detached); await mkdir(f.source); await writeFile(join(f.source, "替代文件.mp4"), "foreign-file");
    try {
      await expect(f.pipeline.scan(f.sourceId)).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
      expect(f.pipeline.list({ sourceId: f.sourceId }).items).toMatchObject([{ id: candidate.id, state: "UNAVAILABLE" }]);
      expect(await readdir(f.source)).toEqual(["替代文件.mp4"]); expect(f.calls()).toBe(0); expect(await readdir(f.target)).toEqual([".media-marshal"]);
    } finally { await rm(f.source, { recursive: true }); await rename(detached, f.source); }
    expect(await readFile(f.file)).toEqual(f.bytes);
  });
  it.runIf(process.platform === "darwin")("来源目录权限撤销保留已知文件，恢复权限也须重新建立观察窗口", async () => {
    const f = await fixture(), candidate = await f.ready(); await chmod(f.source, 0);
    try { await expect(f.pipeline.scan(f.sourceId)).rejects.toMatchObject({ code: "EACCES" }); expect(f.pipeline.list({ sourceId: f.sourceId }).items).toMatchObject([{ id: candidate.id, state: "UNAVAILABLE" }]); }
    finally { await chmod(f.source, 0o700); }
    await f.pipeline.scan(f.sourceId); expect(f.pipeline.list({ sourceId: f.sourceId }).items).toMatchObject([{ id: candidate.id, state: "OBSERVING" }]);
    expect(await readFile(f.file)).toEqual(f.bytes); expect(f.calls()).toBe(0);
  });
  it("来源子目录与文件符号链接不会逃逸，直接复核也拒绝链接路径", async () => {
    const f = await fixture(), outside = join(f.directory, "未授权目录"); await mkdir(outside); await writeFile(join(outside, "外部视频.mp4"), "outside-content");
    await symlink(outside, join(f.source, "逃逸目录")); await symlink(join(outside, "外部视频.mp4"), join(f.source, "链接视频.mp4")); await f.pipeline.scan(f.sourceId);
    expect(f.pipeline.list({ sourceId: f.sourceId }).items).toMatchObject([{ relativePath: "测试电影.2026.mp4" }]);
    const root = await SourceRoot.open(f.sourceGrant);
    try { for (const parts of [["逃逸目录", "外部视频.mp4"], ["链接视频.mp4"]]) await expect(root.inspect(parts)).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" }); }
    finally { await root.close(); }
    expect(await readFile(join(outside, "外部视频.mp4"), "utf8")).toBe("outside-content"); expect(f.calls()).toBe(0);
  });
  it("启动与周期补扫在监听不可用时继续发现，所有文件仍从观察状态开始", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await fixture({ watchFiles: () => { throw new Error("本环境不提供目录事件"); } });
    f.pipeline.start(); await f.pipeline.tick();
    expect(f.pipeline.list({ sourceId: f.sourceId }).items).toMatchObject([{ state: "OBSERVING", requiresConfirmation: true }]);
    await writeFile(join(f.source, "漏事件.mp4"), "由定时补扫发现");
    f.jump(10000); await vi.advanceTimersByTimeAsync(10000); await f.pipeline.tick();
    expect(f.pipeline.list({ sourceId: f.sourceId }).items.find((row) => row.relativePath === "漏事件.mp4")).toMatchObject({ state: "OBSERVING", requiresConfirmation: true });
    expect(f.calls()).toBe(0); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
  });
  it("重复事件仅合并为一次扫描，实际文件和手动补扫共用同一候选", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let notify!: (event: string, name: string) => void;
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as FSWatcher;
    const watchFiles = ((_path: string, _options: unknown, listener: typeof notify) => { notify = listener; return watcher; }) as typeof watch;
    const f = await fixture({ watchFiles }), scan = vi.spyOn(f.pipeline, "scan");
    for (let i = 0; i < 100; i++) notify("change", "测试电影.2026.mp4");
    await vi.advanceTimersByTimeAsync(500); expect(scan).toHaveBeenCalledOnce(); await scan.mock.results[0]!.value;
    const first = f.pipeline.list({ sourceId: f.sourceId }).items[0]!; expect(first).toMatchObject({ state: "OBSERVING" });
    const a = f.pipeline.scan(f.sourceId), b = f.pipeline.scan(f.sourceId); expect(a).toBe(b); await Promise.all([a, b]);
    expect(f.pipeline.list({ sourceId: f.sourceId }).items).toMatchObject([{ id: first.id, state: "OBSERVING" }]);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
  });
  it.runIf(process.platform === "darwin")("真实 macOS 目录事件可以发现新文件，监听不会直接识别或写入媒体库", async () => {
    const f = await fixture();
    await vi.waitFor(() => expect(f.pipeline.list({ sourceId: f.sourceId }).items).toHaveLength(1), { timeout: 4000, interval: 25 });
    expect(f.pipeline.list({ sourceId: f.sourceId }).items[0]).toMatchObject({ state: "OBSERVING", requiresConfirmation: true });
    expect(f.calls()).toBe(0); expect(await readdir(f.target)).toEqual([".media-marshal"]);
  });
  it("零字节和持续增长不会就绪，最后一次变化后重新连续观察 120 秒", async () => {
    const f = await fixture(); await writeFile(f.file, ""); await f.pipeline.scan(f.sourceId); await f.advance();
    const zero = f.pipeline.list({ sourceId: f.sourceId }).items[0]!; expect(zero).toMatchObject({ state: "OBSERVING", reason: expect.stringContaining("零字节") });
    await expect(f.pipeline.recognize({ candidateId: zero.id, requestKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    await writeFile(f.file, "增长开始"); await f.pipeline.scan(f.sourceId); await f.advance(60000); await appendFile(f.file, "继续写入"); await f.pipeline.scan(f.sourceId); await f.advance(110000);
    expect(f.pipeline.list({ sourceId: f.sourceId }).items.filter((row) => row.state !== "SUPERSEDED")).toMatchObject([{ state: "OBSERVING" }]);
    await f.advance(10000); expect(f.pipeline.list({ sourceId: f.sourceId }).items.filter((row) => row.state !== "SUPERSEDED")).toMatchObject([{ state: "READY", requiresConfirmation: true }]);
    expect(f.calls()).toBe(0); expect(await readdir(f.target)).toEqual([".media-marshal"]);
  });
  it("实测夸克临时名称始终等待，改为正式名后重新观察且仅创建一个有效 COPY", async () => {
    const f = await fixture(), temporaryPath = join(f.source, "测试电影.2026-000000000000.mp4.qkdownloading"); await rename(f.file, temporaryPath);
    await f.pipeline.scan(f.sourceId); await f.advance(); const temporary = f.pipeline.list({ sourceId: f.sourceId }).items[0]!;
    expect(temporary).toMatchObject({ state: "OBSERVING", reason: expect.stringContaining("临时名称") });
    await expect(f.pipeline.recognize({ candidateId: temporary.id, requestKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    await rename(temporaryPath, f.file); await f.pipeline.scan(f.sourceId); await f.advance(110000);
    expect(f.pipeline.list({ sourceId: f.sourceId }).items.find((row) => row.relativePath === "测试电影.2026.mp4")).toMatchObject({ state: "OBSERVING" });
    expect(f.pipeline.list({ sourceId: f.sourceId }).items.find((row) => row.id === temporary.id)).toMatchObject({ state: "UNAVAILABLE" });
    await f.advance(10000); const final = f.pipeline.list({ sourceId: f.sourceId }).items.find((row) => row.relativePath === "测试电影.2026.mp4")!;
    const task = await f.pipeline.recognize({ candidateId: final.id, requestKey: randomUUID() }); await f.pipeline.tick();
    const preview = await f.pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" } });
    await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
    expect(await readFile(f.file)).toEqual(f.bytes); expect(await readFile(preview.targetPath)).toEqual(f.bytes);
  });
  it.each([null, [], ["cache/"]])("本地忽略设置 %j 在真实目录剪枝，私有暂存始终排除，精确样片保留跳过原因", async (ignoredFilePatterns) => {
    const f = await fixture({ ignoredFilePatterns });
    for (const directory of ["Sample", "cache", ".media-marshal/staging"]) { await mkdir(join(f.source, directory), { recursive: true }); await writeFile(join(f.source, directory, "视频.mp4"), "独立样本"); }
    await writeFile(join(f.source, ".隐藏.mp4"), "隐藏媒体"); await writeFile(join(f.source, "测试电影.2026.sample.mkv"), "精确样片");
    await f.pipeline.scan(f.sourceId); const items = f.pipeline.list({ sourceId: f.sourceId }).items, names = items.map((row) => row.relativePath);
    expect(names.some((name) => name.includes(".media-marshal"))).toBe(false);
    expect(names.includes("Sample/视频.mp4")).toBe(ignoredFilePatterns !== null);
    expect(names.includes(".隐藏.mp4")).toBe(ignoredFilePatterns !== null);
    expect(names.includes("cache/视频.mp4")).toBe(!ignoredFilePatterns?.length);
    expect(items.find((row) => row.relativePath.endsWith("sample.mkv"))).toMatchObject({ state: "SKIPPED", reason: expect.stringContaining("精确同基名主视频") });
    expect(f.calls()).toBe(0); expect(await readdir(f.target)).toEqual([".media-marshal"]);
  });
  it.runIf(process.platform === "darwin")("就绪文件随后不可读或消失会转不可用，保留原候选而不冒充删除", async () => {
    const f = await fixture(), candidate = await f.ready();
    await chmod(f.file, 0);
    try { await f.pipeline.scan(f.sourceId); expect(f.pipeline.list({ sourceId: f.sourceId }).items.find((row) => row.id === candidate.id)).toMatchObject({ state: "UNAVAILABLE", reason: expect.stringContaining("不可访问") }); }
    finally { await chmod(f.file, 0o600); }
    await f.pipeline.scan(f.sourceId); const relocated = join(f.directory, "临时移开.mp4"); await rename(f.file, relocated); await f.pipeline.scan(f.sourceId);
    expect(f.pipeline.list({ sourceId: f.sourceId }).items.filter((row) => row.state !== "SUPERSEDED")).toMatchObject([{ state: "UNAVAILABLE" }]);
    await rename(relocated, f.file); await f.pipeline.scan(f.sourceId);
    expect(f.pipeline.list({ sourceId: f.sourceId }).items.filter((row) => row.state !== "SUPERSEDED")).toMatchObject([{ state: "OBSERVING" }]);
    expect(await readFile(f.file)).toEqual(f.bytes); expect(f.calls()).toBe(0);
  });
  it("音乐、ISO 与蓝光结构明确跳过，不能进入普通视频识别", async () => {
    const f = await fixture(); await mkdir(join(f.source, "原盘", "BDMV", "STREAM"), { recursive: true });
    const unsupported = [join(f.source, "音乐.flac"), join(f.source, "原盘.iso"), join(f.source, "原盘", "BDMV", "STREAM", "00001.m2ts")];
    for (const file of unsupported) await writeFile(file, "首版不处理此资产");
    await f.ready(); const skipped = f.pipeline.list({ sourceId: f.sourceId }).items.filter((value) => value.state === "SKIPPED");
    expect(skipped).toHaveLength(3);
    for (const candidate of skipped) await expect(f.pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
    expect(await readdir(f.target)).toEqual([".media-marshal"]);
  });
  it("并发识别和重复确认共用任务与操作，不重复启动 COPY", async () => {
    const f = await fixture(), candidate = await f.ready(), key = randomUUID();
    const tasks = await Promise.all([f.pipeline.recognize({ candidateId: candidate.id, requestKey: key }), f.pipeline.recognize({ candidateId: candidate.id, requestKey: key })]);
    expect(tasks[0]).toEqual(tasks[1]); await f.pipeline.tick();
    const preview = await f.pipeline.preview({ taskId: tasks[0]!.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" } });
    const request = { previewId: preview.id, requestKey: randomUUID() }, operations = await Promise.all([f.pipeline.confirm(request), f.pipeline.confirm(request)]); await f.pipeline.tick();
    expect(operations[0]).toEqual(operations[1]); expect(await f.pipeline.confirm(request)).toEqual(operations[0]);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 1 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
    expect(await readFile(preview.targetPath)).toEqual(f.bytes); expect(await readFile(f.file)).toEqual(f.bytes);
  });
  it("复制暂停在未发布边界停止，恢复重新观察后继续原意图而不回滚来源", async () => {
    const f = await fixture(), preview = await f.preview(), digest = SourceRoot.prototype.digest;
    let release!: () => void, reached!: () => void, held = false;
    const copying = new Promise<void>((resolve) => { reached = resolve; });
    vi.spyOn(SourceRoot.prototype, "digest").mockImplementation(function (handle, size, signal, consume) {
      return digest.call(this, handle, size, signal, consume && (async (chunk) => { await consume(chunk); if (!held) { held = true; reached(); await new Promise<void>((resolve) => { release = resolve; }); } }));
    });
    const request = { previewId: preview.id, requestKey: randomUUID() }, operation = await f.pipeline.confirm(request); await copying;
    const running = f.pipeline.tick(); f.pipeline.setPaused({ paused: true, requestKey: randomUUID() }); release(); await running;
    await expect(lstat(preview.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.file)).toEqual(f.bytes); expect(await f.pipeline.confirm(request)).toEqual(operation);
    f.pipeline.setPaused({ paused: false, requestKey: randomUUID() }); await f.pipeline.tick(); await f.advance(); await f.pipeline.tick();
    expect(f.pipeline.task(preview.taskId).state).toBe("DONE"); expect(await readFile(preview.targetPath)).toEqual(f.bytes);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
  });
  it("同名多语字幕、NFO、封面与校验文件随视频重命名，通用 JPG 保留名称，逐项记账且来源保留", async () => {
    const f = await fixture(), base = "测试电影.2026";
    const suffixes = ["zh-Hans.srt", "en.forced.ass", "ssa", "sub", "idx", "nfo", "poster.png", "jpeg", "webp", "md5", "vtt"];
    const covers = ["poster.jpg", "folder.jpg", "cover.jpg"], names = [...suffixes.map((suffix) => `${base}.${suffix}`), ...covers];
    for (const name of [...names, "其他电影.zh.srt", "poster.png", "note.txt"]) await writeFile(join(f.source, name), `原内容：${name}`);
    const preview = await f.preview(), targetBase = basename(preview.targetPath).replace(/\.[^.]+$/, "");
    const expected = [...suffixes.map((suffix) => `${targetBase}.${suffix}`), ...covers].sort();
    expect(preview.accessories?.map((asset) => basename(asset.targetPath)).sort()).toEqual(expected);
    expect(await readdir(f.target)).toEqual([".media-marshal"]);
    await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    expect(f.pipeline.task(preview.taskId)).toMatchObject({ state: "DONE", accessories: names.map(() => expect.objectContaining({ state: "RECORDED", failure: null })) });
    for (const asset of preview.accessories ?? []) expect(await readFile(asset.targetPath)).toEqual(await readFile(asset.sourcePath));
    expect(await readFile(f.file)).toEqual(f.bytes); expect(await readFile(join(f.source, "poster.png"), "utf8")).toBe("原内容：poster.png");
    expect(f.db.connection.prepare("SELECT state FROM desktop_job").get()).toEqual({ state: "DONE" });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_accessory WHERE phase='RECORDED'").get()).toEqual({ n: names.length });
  });
  it("取消附属文件复制可绕过尚未稳定的字幕，只预览和提交主视频", async () => {
    const f = await fixture(), candidate = await f.ready(), subtitle = join(f.source, "测试电影.2026.zh.srt"); await writeFile(subtitle, "仍在下载的字幕");
    const task = await f.pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await f.pipeline.tick();
    await expect(f.pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: true })).rejects.toMatchObject({ code: "CONFLICT" });
    const preview = await f.pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false });
    expect(preview.accessories).toEqual([]); await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    expect(f.pipeline.task(task.taskId).state).toBe("DONE"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_accessory").get()).toEqual({ n: 0 });
    expect(await readFile(subtitle, "utf8")).toBe("仍在下载的字幕"); expect(await readdir(dirname(preview.targetPath))).toEqual([basename(preview.targetPath)]);
  });
  it("确认后可用空间不足不产生正式文件，容量恢复后继续同一个操作", async () => {
    const f = await fixture(), preview = await f.preview(), root = f.pipeline.targets.get(f.targetGrant.id), check = root.check.bind(root);
    let blocked = true;
    vi.spyOn(root, "check").mockImplementation(async () => { const available = await check(); return blocked && f.db.connection.prepare("SELECT 1 FROM ingestion_operation").get() ? 0 : available; });
    await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    await expect(lstat(preview.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.db.connection.prepare("SELECT phase FROM ingestion_operation").get()).toEqual({ phase: "PLANNED" });
    expect(await readFile(f.file)).toEqual(f.bytes); expect(f.db.connection.prepare("SELECT count(*) AS n FROM emby_delivery").get()).toEqual({ n: 0 });
    blocked = false; await f.pipeline.tick();
    expect(f.pipeline.task(preview.taskId).state).toBe("DONE"); expect(await readFile(preview.targetPath)).toEqual(f.bytes);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
  });
  it.skipIf(process.platform !== "darwin")("复制开始时撤销来源文件读取权限，失败不发布正式文件且来源保留", async () => {
    const f = await fixture(), preview = await f.preview(), root = f.pipeline.targets.get(f.targetGrant.id), prepare = root.prepareStage.bind(root);
    vi.spyOn(root, "prepareStage").mockImplementation(async (...args) => { const stage = await prepare(...args); await chmod(f.file, 0); return stage; });
    try {
      await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
      await expect(lstat(preview.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(f.pipeline.task(preview.taskId).state).toBe("FAILED");
      expect(f.db.connection.prepare("SELECT count(*) AS n FROM emby_delivery").get()).toEqual({ n: 0 });
    } finally { await chmod(f.file, 0o600); }
    expect(await readFile(f.file)).toEqual(f.bytes);
  });
  it("暂存内容被同尺寸改写时摘要不符，不能发布文件或写交付成功", async () => {
    const f = await fixture(), preview = await f.preview(), root = f.pipeline.targets.get(f.targetGrant.id), verify = root.verifyStage.bind(root);
    vi.spyOn(root, "verifyStage").mockImplementation(async (...args) => {
      const file = await open(await root.stageFilePath(args[0], args[1]), "r+");
      try { await file.write(Buffer.from([0x7f]), 0, 1, 0); await file.sync(); } finally { await file.close(); }
      return verify(...args);
    });
    await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    await expect(lstat(preview.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.pipeline.task(preview.taskId).state).toBe("FAILED"); expect(await readFile(f.file)).toEqual(f.bytes);
    expect(f.db.connection.prepare("SELECT phase FROM ingestion_operation").get()).toEqual({ phase: "NEEDS_ATTENTION" });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM emby_delivery").get()).toEqual({ n: 0 });
  });
  it("多块真实文件按一 MiB 上限流式复制，同卷暂存再核对摘要提交", async () => {
    const f = await fixture(), bytes = Buffer.alloc(3 * 1024 * 1024 + 37, 0x5a); await writeFile(f.file, bytes);
    const preview = await f.preview(), digest = SourceRoot.prototype.digest, chunks: number[] = [];
    vi.spyOn(SourceRoot.prototype, "digest").mockImplementation(function (handle, size, signal, consume) {
      return digest.call(this, handle, size, signal, consume && (async (chunk) => { chunks.push(chunk.length); await consume(chunk); }));
    });
    const root = f.pipeline.targets.get(f.targetGrant.id), verify = root.verifyStage.bind(root); let stageDevice = "";
    vi.spyOn(root, "verifyStage").mockImplementation(async (...args) => { stageDevice = String((await lstat(await root.stageFilePath(args[0], args[1]), { bigint: true })).dev); return verify(...args); });
    await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    expect(chunks).toEqual([1024 * 1024, 1024 * 1024, 1024 * 1024, 37]); expect(stageDevice).toBe(f.targetGrant.volume.observedDevice);
    // 原生逐字节比较避免通用深比较枚举数百万个 Buffer 属性。
    expect((await readFile(preview.targetPath)).equals(bytes)).toBe(true); expect((await readFile(f.file)).equals(bytes)).toBe(true);
    expect(f.pipeline.task(preview.taskId).state).toBe("DONE");
  });
  it("单调时钟未计入休眠时也重置就绪观察，主文件与字幕都需重新稳定", async () => {
    const f = await fixture(), subtitle = join(f.source, "测试电影.2026.zh-Hans.srt"); await writeFile(subtitle, "subtitle");
    const candidate = await f.ready(); expect(candidate.state).toBe("READY");
    f.wallJump(3600000); await f.pipeline.scan(f.sourceId);
    expect(f.pipeline.list({ sourceId: f.sourceId }).items[0]?.state).toBe("OBSERVING");
    await expect(f.pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    await f.advance(); const task = await f.pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await f.pipeline.tick();
    const preview = await f.pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" } });
    expect(preview.accessories).toHaveLength(1); expect(await readFile(f.file)).toEqual(f.bytes); expect(await readdir(f.target)).toEqual([".media-marshal"]);
  });
  it.each([
    ["AUTH_REQUIRED", "TMDB 密钥无效"], ["NETWORK_UNAVAILABLE", "无法连接 TMDB"],
    ["TIMEOUT", "TMDB 请求超时"], ["RATE_LIMITED", "TMDB 请求受到限制"],
    ["INVALID_RESPONSE", "TMDB 响应不完整"],
  ] as const)("识别失败保留 %s 的可操作分类，修复后重试同一任务且不产生 COPY", async (code, message) => {
    const f = await fixture(), candidate = await f.ready();
    const search = vi.spyOn(f.connections.tmdb, "search").mockRejectedValue(new MediaNetworkError(code));
    const task = await f.pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await f.pipeline.tick();
    expect(f.pipeline.task(task.taskId)).toMatchObject({ state: "AWAITING_CONFIRMATION", failure: expect.stringContaining(message) });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
    search.mockRestore(); f.pipeline.retry(task.taskId); await f.pipeline.tick();
    expect(f.pipeline.task(task.taskId)).toMatchObject({ taskId: task.taskId, state: "AWAITING_CONFIRMATION", failure: null, matches: [{ tmdbId: 1 }] });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 1 });
    expect(await readdir(f.target)).toEqual([".media-marshal"]);
  });

  it("未知识别异常不回显原始消息、URL 或凭据", async () => {
    const f = await fixture(), candidate = await f.ready();
    vi.spyOn(f.connections.tmdb, "search").mockRejectedValue(new Error("https://private.example/?api_key=fixture-secret"));
    const task = await f.pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await f.pipeline.tick();
    expect(f.pipeline.task(task.taskId).failure).toBe("识别未完成，请检查解析器、TMDB 配置或网络后重试");
    expect(JSON.stringify(f.pipeline.task(task.taskId))).not.toMatch(/private\.example|fixture-secret/);
  });

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
