import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, lstat, statfs, realpath, rm, rename } from "node:fs/promises";
import { watch } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { CoreOutput } from "@media-marshal/contracts";
import { createMediaApplication } from "../modules/application";
import { CoreDatabase } from "../infrastructure/database";
import { MediaConnections } from "../application/media-connections";
import { normalizeParse } from "../domain/media";
import { IngestionPipeline } from "./pipeline";
import { Corrections } from "./corrections";
import { EmbyDelivery } from "./emby-delivery";
import { loadNativeRename, type NativeRenameApi } from "../files/native-rename";
import { ManagedRoot } from "../files/index";

const run = promisify(execFile), cleanup: (() => unknown | Promise<unknown>)[] = [];
let work: string, native: NativeRenameApi, nativeLaunch: { manifestPath: string; manifestSha256: string };
describe.skipIf(process.platform !== "darwin")("单条修正的预览、文件执行与历史事务", () => {
  beforeAll(async () => { work = await realpath(await mkdtemp(join(tmpdir(), "marshal-correction-"))); await run(process.execPath, [resolve("tools/desktop-files/build.mjs"), "--out", join(work, "native")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000 }); const manifestPath = join(work, "native/manifest.json"); nativeLaunch = { manifestPath, manifestSha256: createHash("sha256").update(await readFile(manifestPath)).digest("hex") }; native = await loadNativeRename(nativeLaunch); await run(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "packages/media-core/tsconfig.json"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000 }); }, 40000);
  afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
  afterAll(async () => { if (work) await rm(work, { recursive: true, force: true }); });
  async function fixture(copy = false, tv = false) {
    const path = await mkdtemp(join(work, "case-")), source = join(path, "下载来源"), old = join(path, "原媒体库"), target = join(path, "新媒体库"); for (const value of [source, old, target]) await mkdir(value);
    const db = await CoreDatabase.open(join(path, "core.sqlite3")); cleanup.push(() => db.close()); let clock = Date.now(), monotonic = 0;
    const server = createServer((req, res) => { const url = new URL(req.url!, "http://localhost"); res.setHeader("Content-Type", "application/json"); const id = Number(url.pathname.split("/").at(-1));
      if (url.pathname.startsWith("/search/")) res.end(JSON.stringify({ results: [{ id: 1, title: "原作品", name: "原作品", release_date: "2026-01-01", first_air_date: "2026-01-01" }] }));
      else if (/^\/movie\/\d+$/.test(url.pathname)) res.end(JSON.stringify({ id, title: id === 1 ? "原作品" : id === 2 ? "新作品" : "再次修正", original_title: "Fixture Movie", release_date: "2026-01-01", genres: ["剧情", "冒险", "奇幻", "家庭"].map((name, index) => ({ id: index + 1, name })) }));
      else if (/^\/tv\/\d+$/.test(url.pathname)) res.end(JSON.stringify({ id, name: "修正剧集", original_name: "Fixture Show", first_air_date: "2026-01-01", seasons: id === 3 ? [{ season_number: 1 }] : id === 1 ? [{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }] : [{ season_number: 0 }, { season_number: 1 }] }));
      else if (/^\/tv\/\d+\/season\/\d+$/.test(url.pathname)) res.end(JSON.stringify({ episodes: [1, 2, 4, ...Array.from({ length: 30 }, (_, index) => index + 5)].map((episode_number) => ({ episode_number, season_number: Number(url.pathname.split("/").at(-1)), name: "真实分集" + episode_number })) }));
      else res.writeHead(404).end("{}");
    }); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); cleanup.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
    const connections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" }), { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }); cleanup.push(() => connections.close()); connections.install({ tmdb: "fixture-tmdb", emby: null });
    const parser = { ready: true, parse: async (name: string) => normalizeParse({ title: "原作品", year: 2026, type: tv ? "episode" : "movie", ...(tv ? { season: Number(/S(\d+)/.exec(name)?.[1] ?? 1), episode: Number(/E(\d+)/.exec(name)?.[1] ?? 1) } : {}) }, name) }, controlledWatch = (() => Object.assign(new EventEmitter(), { close() {} })) as unknown as typeof watch;
    const pipeline = new IngestionPipeline(db, () => parser, connections, () => clock, () => monotonic, controlledWatch); cleanup.push(() => pipeline.close());
    async function grant(path: string, volumeId: string): Promise<ManagedRootGrant> { const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true }); return { id: randomUUID(), path, volume: { volumeId, rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "isolated-test", caseSensitive: false, unicodeEquivalent: true, pathMaxBytes: 4096 } }; }
    const volume = randomUUID(), sourceGrant = await grant(source, volume), oldGrant = await grant(old, volume), targetGrant = await grant(target, copy ? randomUUID() : volume), sourceId = randomUUID(), time = new Date(clock).toISOString();
    db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'原下载来源','custom',?,?,'AUTO','COPY',?)").run(sourceId, source, old, time);
    await pipeline.authorize({ sourceId, sourceVersion: 1, source: sourceGrant, target: oldGrant, mode: "local", downloadRootId: null });
    // 夹具预登记另一个已授权目标，再走原卷恢复入口；不把恢复入口改成任意目录授权。
    db.connection.prepare("INSERT INTO media_target_root(id,grant_json) VALUES(?,?)").run(targetGrant.id, JSON.stringify(targetGrant)); await pipeline.authorizeTarget(targetGrant);
    const original = join(source, "下载原片.mkv"), bytes = Buffer.from("下载原件与已整理目标需要分别保留".repeat(200)); await writeFile(original, bytes); await writeFile(join(source, "下载原片.zh.srt"), "已整理字幕"); await writeFile(join(source, "poster.jpg"), "通用封面");
    await pipeline.scan(sourceId); for (let index = 0; index < 12; index++) { clock += 10000; monotonic += 10000; await pipeline.scan(sourceId); }
    const candidate = pipeline.list({}).items.find((entry) => entry.relativePath === "下载原片.mkv")!, task = await pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await pipeline.tick(); const preview = await pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: tv ? { tmdbId: 1, mediaType: "TV_SHOW", season: 1, episode: 1 } : { tmdbId: 1, mediaType: "MOVIE" } }); await pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await pipeline.tick();
    const corrections = new Corrections(db, pipeline, connections, native, () => clock); cleanup.push(() => corrections.close());
    async function addEpisodes(values: { season: number; episode: number }[]) {
      const paths = values.map(({ season, episode }) => join(source, `下载原片-S${season}E${episode}.mkv`)); for (const file of paths) await writeFile(file, bytes);
      for (let index = 0; index < 13; index++) { clock += 10000; monotonic += 10000; await pipeline.scan(sourceId); }
      const result: { taskId: string; original: string; oldPath: string }[] = [];
      for (const [index, value] of values.entries()) {
        const file = paths[index]!, candidate = db.connection.prepare("SELECT id FROM ingestion_candidate WHERE source_id=? AND relative_json=? AND is_current=1").get(sourceId, JSON.stringify([basename(file)])) as { id: string };
        const task = await pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await pipeline.tick();
        const preview = await pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "TV_SHOW", ...value } }); await pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await pipeline.tick(); result.push({ taskId: task.taskId, original: file, oldPath: preview.targetPath });
      }
      return result;
    }
    return { path, source, old, target, db, pipeline, connections, corrections, addEpisodes, original, bytes, taskId: task.taskId, oldPath: preview.targetPath, oldGrant, targetGrant, sourceId, now: () => clock, preview: (extra = {}) => corrections.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 2, mediaType: "MOVIE" }, ...extra }), advance(ms: number) { clock += ms; monotonic += ms; } };
  }
  it("预览只核验媒体目标，确认后移动同名附属并保留封面、下载原件和前后历史", async () => {
    const f = await fixture(); await writeFile(join(dirname(f.oldPath), basename(f.oldPath, ".mkv") + ".nfo"), "同名 NFO"); f.db.connection.prepare("UPDATE desktop_source SET paused=1 WHERE id=?").run(f.sourceId); await rename(f.source, f.source + "-离线");
    const preview = await f.preview({ targetId: f.targetGrant.id }); expect(preview.files.map((file) => file.action)).toContain("KEEP"); expect(preview.template).toContain("{title}"); expect(preview.includeAccessories).toBe(true); expect(preview.warnings.join(" ")).toContain("通用封面"); expect(await readFile(f.oldPath)).toEqual(f.bytes); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get()).toEqual({ n: 0 });
    const job = await f.corrections.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true }); await f.corrections.tick(); expect(f.corrections.details({ id: job.id }).operation).toMatchObject({ state: "RECORDED", done: 3, total: 3 });
    expect(await readFile(preview.targetPath)).toEqual(f.bytes); expect(await readFile(join(dirname(preview.targetPath), basename(preview.targetPath, ".mkv") + ".zh.srt"), "utf8")).toBe("已整理字幕"); expect(await readFile(join(dirname(f.oldPath), "poster.jpg"), "utf8")).toBe("通用封面"); expect(await readFile(join(f.source + "-离线", "下载原片.mkv"))).toEqual(f.bytes);
    expect(f.db.connection.prepare("SELECT status,corrected_to_id FROM media_task WHERE id=?").get(f.taskId)).toEqual({ status: "CORRECTED", corrected_to_id: job.newTaskId }); expect(f.db.connection.prepare("SELECT status,corrected_from_id,target_path FROM media_task WHERE id=?").get(job.newTaskId)).toEqual({ status: "DONE", corrected_from_id: f.taskId, target_path: preview.targetPath });
    expect(f.db.connection.prepare("SELECT operation_id,correction_id,state FROM emby_delivery WHERE task_id=?").get(job.newTaskId)).toEqual({ operation_id: null, correction_id: job.id, state: "REFRESH_PENDING" }); expect(() => f.pipeline.retry(f.taskId)).toThrow("不能重放");
  });
  it("重复预览与确认复用原作业，请求键不能用于不同预览，过期和重启后的未确认预览失效", async () => {
    const f = await fixture(), input = { taskId: f.taskId, requestKey: randomUUID(), selection: { tmdbId: 2, mediaType: "MOVIE" as const } }, [a, b] = await Promise.all([f.corrections.preview(input), f.corrections.preview(input)]); expect(a.id).toBe(b.id);
    const other = await f.preview(), key = randomUUID(), job = await f.corrections.confirm({ previewId: a.id, requestKey: key, filesComplete: true }); expect((await f.corrections.confirm({ previewId: a.id, requestKey: randomUUID(), filesComplete: true })).id).toBe(job.id); await expect(f.corrections.confirm({ previewId: other.id, requestKey: key, filesComplete: true })).rejects.toThrow("另一个预览"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get()).toEqual({ n: 1 });
    const g = await fixture(), preview = await g.preview(); g.advance(600001); await expect(g.corrections.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true })).rejects.toThrow("过期"); const fresh = await g.preview(), restored = new Corrections(g.db, g.pipeline, g.connections, native); cleanup.push(() => restored.close()); expect(restored.getPreview(fresh.id).state).toBe("EXPIRED"); await expect(restored.confirm({ previewId: fresh.id, requestKey: randomUUID(), filesComplete: true })).rejects.toThrow("核心已变化");
  });
  it("大文件核验结束后才开始预览有效期，期限内接受的确认不会因自身核验耗时而失效", async () => {
    const f = await fixture(), inspect = ManagedRoot.prototype.inspectForRelocation;
    const spy = vi.spyOn(ManagedRoot.prototype, "inspectForRelocation").mockImplementation(async function (this: ManagedRoot, ...args) { const result = await inspect.apply(this, args); f.advance(700000); return result; });
    const preview = await f.preview(); expect(preview.state).toBe("READY"); expect(preview.expiresAt - f.now()).toBe(600000);
    const job = await f.corrections.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true }); spy.mockRestore(); await f.corrections.tick(); expect(f.corrections.details({ id: job.id }).operation.state).toBe("RECORDED"); expect(await readFile(f.original)).toEqual(f.bytes);
  });
  it("公开预览核验返回持久编号后可中断实际文件读取，不留下可确认预览或文件计划", async () => {
    const f = await fixture(), inspect = ManagedRoot.prototype.inspectForRelocation; let entered!: () => void; const ready = new Promise<void>((done) => { entered = done; });
    vi.spyOn(ManagedRoot.prototype, "inspectForRelocation").mockImplementation(async function (this: ManagedRoot, parts, signal, progress) {
      if (join(this.grant.path, ...parts) === f.oldPath) { progress?.(0, f.bytes.length); entered(); await new Promise<void>((_done, fail) => { if (signal!.aborted) fail(new Error("取消")); else signal!.addEventListener("abort", () => fail(new Error("取消")), { once: true }); }); }
      return inspect.call(this, parts, signal, progress);
    });
    const job = f.corrections.preparePreview({ taskId: f.taskId, requestKey: randomUUID(), selection: { tmdbId: 2, mediaType: "MOVIE" } }); expect(job.state).toBe("PENDING"); const flight = f.corrections.preparations.tick(); await ready;
    expect(f.corrections.preparations.get(job.id)).toMatchObject({ state: "RUNNING", currentPath: f.oldPath, readBytes: 0, totalBytes: f.bytes.length }); expect(f.corrections.preparations.cancel(job.id).state).toBe("CANCELING"); await flight;
    expect(f.corrections.preparations.get(job.id).state).toBe("CANCELED"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_preview").get()).toEqual({ n: 0 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_file_relocation").get()).toEqual({ n: 0 }); expect(await readFile(f.oldPath)).toEqual(f.bytes); expect(await readFile(f.original)).toEqual(f.bytes);
  });
  it("确认收据已提交但核验响应未记账，恢复原编号与任务关联而不重复确认", async () => {
    const f = await fixture(), p = await f.preview(), preparation = f.corrections.prepareConfirmation({ previewId: p.id, requestKey: randomUUID(), filesComplete: true }); await f.corrections.preparations.tick(); const ready = f.corrections.preparations.get(preparation.id); expect(ready.state).toBe("READY");
    f.db.connection.prepare("UPDATE media_correction_preparation SET state='RUNNING',operation_id=NULL WHERE id=?").run(preparation.id); const restored = new Corrections(f.db, f.pipeline, f.connections, native); cleanup.push(() => restored.close());
    expect(restored.preparations.get(preparation.id)).toMatchObject({ state: "READY", operationId: ready.operationId }); expect(restored.describe({ taskId: f.taskId }).preparation?.id).toBe(preparation.id); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get()).toEqual({ n: 1 }); expect(await readFile(f.oldPath)).toEqual(f.bytes);
  });
  it("旧版预览请求键被用于不同内容时，后台恢复不会错认成旧预览成功", async () => {
    const f = await fixture(), requestKey = randomUUID(); await f.preview({ requestKey }); const job = f.corrections.preparePreview({ taskId: f.taskId, requestKey, selection: { tmdbId: 3, mediaType: "MOVIE" } }); await f.corrections.preparations.tick();
    expect(f.corrections.preparations.get(job.id)).toMatchObject({ state: "FAILED", previewId: null, failure: { code: "CONFLICT" } }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_preview").get()).toEqual({ n: 1 }); expect(await readFile(f.oldPath)).toEqual(f.bytes);
  });
  it("附属成员或文件内容变化使预览失效，不创建修正意图", async () => {
    const f = await fixture(), preview = await f.preview(); await writeFile(join(dirname(f.oldPath), basename(f.oldPath, ".mkv") + ".ass"), "新出现字幕"); await expect(f.corrections.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true })).rejects.toThrow("范围、内容已经变化"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get()).toEqual({ n: 0 }); expect(await readFile(f.original)).toEqual(f.bytes);
  });
  it("只有媒体路径但缺少原收据的旧任务不能被自动认领", async () => {
    const f = await fixture(), id = randomUUID(), time = new Date().toISOString(); f.db.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,target_path,created_at,updated_at) VALUES(?,?,?,'DONE',?,?,?)").run(id, f.sourceId, f.original, f.oldPath, time, time); await expect(f.corrections.preview({ taskId: id, requestKey: randomUUID(), selection: { tmdbId: 2, mediaType: "MOVIE" } })).rejects.toThrow("可信收据");
  });
  it("修正模板保留完整类型变量，非法名称在确认前阻断", async () => {
    const f = await fixture(), p = await f.preview({ template: "{genre_1}/{genre_2}/{genre_3}/{genre_4}/{title}.{ext}" }); expect(p.targetPath).toBe(join(f.old, "剧情", "冒险", "奇幻", "家庭", "新作品.mkv")); await expect(f.preview({ template: "坏名称\ud800.mkv" })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get()).toEqual({ n: 0 }); expect(await readFile(f.oldPath)).toEqual(f.bytes);
  });
  it("主视频成功而字幕目标被抢占时保留部分进度，重试只移动未完成字幕", async () => {
    const f = await fixture(), preview = await f.preview({ targetId: f.targetGrant.id }), job = await f.corrections.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true }), subtitle = preview.files.find((file) => file.kind === "ACCESSORY" && file.action !== "KEEP")!; await mkdir(dirname(subtitle.toPath), { recursive: true }); await writeFile(subtitle.toPath, "外部字幕保留");
    const spy = vi.spyOn(native, "renameBeneath"); await f.corrections.tick(); expect(f.corrections.details({ id: job.id }).operation).toMatchObject({ state: "NEEDS_ATTENTION", done: 1, failed: 1 }); const inode = (await lstat(preview.targetPath)).ino, calls = spy.mock.calls.length; expect(f.db.connection.prepare("SELECT status,corrected_to_id FROM media_task WHERE id=?").get(f.taskId)).toEqual({ status: "DONE", corrected_to_id: null });
    await rename(subtitle.toPath, join(f.target, "外部字幕保留.srt")); f.corrections.retry({ id: job.id }); await f.corrections.tick(); expect(f.corrections.details({ id: job.id }).operation.state).toBe("RECORDED"); expect((await lstat(preview.targetPath)).ino).toBe(inode); expect(spy.mock.calls.length - calls).toBe(2); expect(await readFile(join(f.target, "外部字幕保留.srt"), "utf8")).toBe("外部字幕保留");
  });
  it("COPY 文件完成后历史事务失败整体回滚，重试只补历史与新交付意图", async () => {
    const f = await fixture(true), preview = await f.preview({ targetId: f.targetGrant.id }), job = await f.corrections.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true });
    f.db.connection.exec("CREATE TRIGGER fail_correction_delivery BEFORE INSERT ON emby_delivery WHEN NEW.correction_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'注入历史事务故障'); END;"); await f.corrections.tick(); expect(f.corrections.details({ id: job.id }).operation.state).toBe("NEEDS_ATTENTION"); expect(f.db.connection.prepare("SELECT status,corrected_to_id FROM media_task WHERE id=?").get(f.taskId)).toEqual({ status: "DONE", corrected_to_id: null }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM emby_delivery WHERE correction_id=?").get(job.id)).toEqual({ n: 0 });
    const inode = (await lstat(preview.targetPath)).ino, spy = vi.spyOn(native, "linkBeneath"); f.db.connection.exec("DROP TRIGGER fail_correction_delivery"); f.corrections.retry({ id: job.id }); await f.corrections.tick(); expect(f.corrections.details({ id: job.id }).operation.state).toBe("RECORDED"); expect((await lstat(preview.targetPath)).ino).toBe(inode); expect(spy).not.toHaveBeenCalled(); expect(f.db.connection.prepare("SELECT count(*) AS n FROM emby_delivery WHERE correction_id=?").get(job.id)).toEqual({ n: 1 });
  });
  it("原路径不变也生成历史链，后续修正读取最新收据并释放旧坐标与位置", async () => {
    const f = await fixture(), relative = f.oldPath.slice(f.old.length + 1), preview = await f.preview({ template: relative }); expect(preview.files[0]!.action).toBe("NONE"); const inode = (await lstat(f.oldPath)).ino, first = await f.corrections.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true }); await f.corrections.tick(); expect((await lstat(f.oldPath)).ino).toBe(inode);
    const next = await f.corrections.preview({ taskId: first.newTaskId, requestKey: randomUUID(), selection: { tmdbId: 3, mediaType: "MOVIE" }, template: relative }), second = await f.corrections.confirm({ previewId: next.id, requestKey: randomUUID(), filesComplete: true }); await f.corrections.tick(); expect(f.corrections.details({ id: second.id }).operation.state).toBe("RECORDED"); expect(f.corrections.describe({ taskId: first.newTaskId })).toMatchObject({ status: "CORRECTED", previousTaskId: f.taskId, nextTaskId: second.newTaskId }); expect((await lstat(f.oldPath)).ino).toBe(inode); expect(f.corrections.describe({ taskId: first.newTaskId }).latestOperation?.id).toBe(second.id); expect(f.corrections.describe({ taskId: second.newTaskId }).latestOperation?.id).toBe(second.id);
  });
  it("修正使用真实分集清单，缺失集或重复坐标不能进入文件执行", async () => {
    const f = await fixture(); await expect(f.preview({ selection: { tmdbId: 10, mediaType: "TV_SHOW", season: 1, episode: 2, episodeEnd: 4 } })).rejects.toThrow(); const p = await f.preview({ selection: { tmdbId: 10, mediaType: "TV_SHOW", season: 1, episode: 1 } }), job = await f.corrections.confirm({ previewId: p.id, requestKey: randomUUID(), filesComplete: true }); await f.corrections.tick(); expect(f.corrections.describe({ taskId: job.newTaskId }).selection).toMatchObject({ tmdbId: 10, mediaType: "TV_SHOW", season: 1, episode: 1 }); expect(await readFile(f.original)).toEqual(f.bytes);
  });
  it("恢复审计忽略已修正的旧目标，仅只读核对最新目标；陌生替换不重做文件操作", async () => {
    const f = await fixture(), p = await f.preview({ targetId: f.targetGrant.id }), job = await f.corrections.confirm({ previewId: p.id, requestKey: randomUUID(), filesComplete: true }); await f.corrections.tick();
    f.pipeline.reconcileRestored(); f.corrections.reconcileRestored(); expect(f.db.connection.prepare("SELECT status FROM media_task WHERE id=?").get(f.taskId)).toEqual({ status: "CORRECTED" }); const spy = vi.spyOn(native, "renameBeneath"); await f.pipeline.tick(); await f.corrections.tick(); expect(f.db.connection.prepare("SELECT status FROM media_task WHERE id=?").get(job.newTaskId)).toEqual({ status: "DONE" }); expect(spy).not.toHaveBeenCalled();
    const preserved = join(f.target, "真实成果保留.mkv"); await rename(p.targetPath, preserved); await writeFile(p.targetPath, f.bytes); f.corrections.reconcileRestored(); await f.corrections.tick(); expect(f.db.connection.prepare("SELECT status FROM media_task WHERE id=?").get(job.newTaskId)).toEqual({ status: "FAILED" }); expect(f.corrections.details({ id: job.id }).operation.failure).toContain("证据不符"); expect(await readFile(preserved)).toEqual(f.bytes); expect(spy).not.toHaveBeenCalled();
    await rename(p.targetPath, join(f.target, "外部文件保留.mkv")); await rename(preserved, p.targetPath); f.corrections.retry({ id: job.id }); await f.corrections.tick(); expect(f.db.connection.prepare("SELECT status FROM media_task WHERE id=?").get(job.newTaskId)).toEqual({ status: "DONE" }); expect(await readFile(f.original)).toEqual(f.bytes);
  });
  it("组件不可用时仍可查询逐文件进度并只读复核已记账目标，阻止新文件执行", async () => {
    const f = await fixture(), p = await f.preview(), job = await f.corrections.confirm({ previewId: p.id, requestKey: randomUUID(), filesComplete: true }), missing = new Corrections(f.db, f.pipeline, f.connections); cleanup.push(() => missing.close());
    expect(missing.details({ id: job.id }).files[0]!.phase).toBe("PENDING"); expect(missing.describe({ taskId: f.taskId })).toMatchObject({ available: false, active: { id: job.id } }); await expect(missing.preview({ taskId: f.taskId, requestKey: randomUUID(), selection: { tmdbId: 2, mediaType: "MOVIE" } })).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
    await f.corrections.tick(); missing.reconcileRestored(); await missing.tick(); expect(f.db.connection.prepare("SELECT status FROM media_task WHERE id=?").get(job.newTaskId)).toEqual({ status: "DONE" });
  });
  it("活动修正在备份核对时保留原任务状态，完成后不按旧收据重新审计已移动目标", async () => {
    const f = await fixture(), p = await f.preview(), job = await f.corrections.confirm({ previewId: p.id, requestKey: randomUUID(), filesComplete: true }); f.pipeline.reconcileRestored(); f.corrections.reconcileRestored(); expect(f.db.connection.prepare("SELECT status FROM media_task WHERE id=?").get(f.taskId)).toEqual({ status: "DONE" }); await f.corrections.tick(); await f.pipeline.tick(); expect(f.corrections.details({ id: job.id }).operation.state).toBe("RECORDED"); expect(f.db.connection.prepare("SELECT status FROM media_task WHERE id=?").get(f.taskId)).toEqual({ status: "CORRECTED" });
  });
  it("整理和修正共用当前季集占用，旧修正历史释放后不继续阻断旧集号", async () => {
    const f = await fixture(), p = await f.preview({ selection: { tmdbId: 10, mediaType: "TV_SHOW", season: 1, episode: 1 } }), first = await f.corrections.confirm({ previewId: p.id, requestKey: randomUUID(), filesComplete: true }); await f.corrections.tick();
    async function candidate(name: string) { await writeFile(join(f.source, name), "另一个普通视频"); await f.pipeline.scan(f.sourceId); for (let index = 0; index < 12; index++) { f.advance(10000); await f.pipeline.scan(f.sourceId); } const row = f.pipeline.list({}).items.find((entry) => entry.relativePath === name)!; const task = await f.pipeline.recognize({ candidateId: row.id, requestKey: randomUUID() }); await f.pipeline.tick(); return task.taskId; }
    const secondTask = await candidate("另一个原片.mkv"); await expect(f.pipeline.preview({ taskId: secondTask, requestKey: randomUUID(), selection: { tmdbId: 10, mediaType: "TV_SHOW", season: 1, episode: 1 }, includeAccessories: false })).rejects.toThrow("重复或重叠");
    const secondPreview = await f.pipeline.preview({ taskId: secondTask, requestKey: randomUUID(), selection: { tmdbId: 10, mediaType: "TV_SHOW", season: 1, episode: 2 }, includeAccessories: false }); await f.pipeline.confirm({ previewId: secondPreview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    await expect(f.corrections.preview({ taskId: first.newTaskId, requestKey: randomUUID(), selection: { tmdbId: 10, mediaType: "TV_SHOW", season: 1, episode: 2 } })).rejects.toThrow("重复或重叠");
    const next = await f.corrections.preview({ taskId: first.newTaskId, requestKey: randomUUID(), selection: { tmdbId: 10, mediaType: "TV_SHOW", season: 1, episode: 4 } }), last = await f.corrections.confirm({ previewId: next.id, requestKey: randomUUID(), filesComplete: true }); await f.corrections.tick(); expect(f.corrections.details({ id: last.id }).operation.state).toBe("RECORDED");
    const thirdTask = await candidate("新的第一集.mkv"), freed = await f.pipeline.preview({ taskId: thirdTask, requestKey: randomUUID(), selection: { tmdbId: 10, mediaType: "TV_SHOW", season: 1, episode: 1 }, includeAccessories: false }); expect(freed.episode).toBe(1);
  });
  it("修正生成独立 Emby 意图并实际核对新目标，重建缺失交付不重做文件操作", async () => {
    const f = await fixture(); let items: object[] = [];
    const server = createServer((req, res) => { const url = new URL(req.url!, "http://localhost"); if (req.headers["x-emby-token"] !== "fixture-correction-emby") { res.writeHead(401).end(); return; } res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/System/Info") res.end(JSON.stringify({ Id: "correction-server", Version: "4.9-fixture" }));
      else if (url.pathname === "/Library/VirtualFolders/Query") res.end(JSON.stringify({ Items: [{ ItemId: "old-lib", Name: "旧媒体库", Locations: [f.old], CollectionType: null }, { ItemId: "new-lib", Name: "新媒体库", Locations: [f.target], CollectionType: null }], TotalRecordCount: 2 }));
      else if (url.pathname === "/Library/Refresh") res.writeHead(204).end();
      else if (url.pathname === "/Items") { const result = url.searchParams.get("ParentId") === "new-lib" ? items : []; res.end(JSON.stringify({ Items: result, TotalRecordCount: result.length })); }
      else res.writeHead(404).end("{}");
    }); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); cleanup.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
    const settings = { language: "zh-CN" as const, embyUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tmdbProxy: "" }; f.connections.install({ tmdb: "fixture-tmdb", emby: "fixture-correction-emby" }); const delivery = new EmbyDelivery(f.db, f.connections, () => settings, f.pipeline, f.now); cleanup.push(() => delivery.close());
    await delivery.connect({ serverId: "correction-server", libraries: [{ targetId: f.oldGrant.id, libraryId: "old-lib", libraryPath: f.old }] });
    const p = await f.preview({ targetId: f.targetGrant.id }), job = await f.corrections.confirm({ previewId: p.id, requestKey: randomUUID(), filesComplete: true }); await f.corrections.tick(); const inode = (await lstat(p.targetPath)).ino, moves = vi.spyOn(native, "renameBeneath");
    await delivery.connect({ serverId: "correction-server", libraries: [{ targetId: f.oldGrant.id, libraryId: "old-lib", libraryPath: f.old }, { targetId: f.targetGrant.id, libraryId: "new-lib", libraryPath: f.target }] }); items = [{ Id: "corrected-movie", Type: "Movie", Path: p.targetPath, ProviderIds: { Tmdb: "2" } }];
    f.advance(30000); await delivery.tick(); f.advance(15000); await delivery.tick(); expect(f.db.connection.prepare("SELECT state FROM emby_delivery WHERE task_id=?").get(job.newTaskId)).toEqual({ state: "COLLECTED" }); expect(await delivery.openUrl(job.newTaskId)).toBe(settings.embyUrl + "/web/index.html#!/item?id=corrected-movie&serverId=correction-server"); await expect(delivery.openUrl(f.taskId)).rejects.toMatchObject({ code: "CONFLICT" }); expect(() => delivery.retry(f.taskId)).toThrow("已被修正");
    f.db.connection.prepare("DELETE FROM emby_delivery WHERE task_id=?").run(job.newTaskId); const restored = new EmbyDelivery(f.db, f.connections, () => settings, f.pipeline, f.now); cleanup.push(() => restored.close()); expect(f.db.connection.prepare("SELECT operation_id,correction_id FROM emby_delivery WHERE task_id=?").get(job.newTaskId)).toEqual({ operation_id: null, correction_id: job.id }); expect(moves).not.toHaveBeenCalled(); expect((await lstat(p.targetPath)).ino).toBe(inode); expect(await readFile(f.original)).toEqual(f.bytes);
  });
  it("受限 Core 命令接入真实原生组件并返回历史链接，Renderer 参数不能注入文件路径", async () => {
    const f = await fixture(); await f.preview();
    // 用本地固定服务器产生的合法原始响应准备离线缓存，测试不连接真实 TMDB，也不开放生产测试端点。
    const cached = f.db.connection.prepare("SELECT value FROM tmdb_cache WHERE json_extract(value,'$.id')=2 LIMIT 1").get() as { value: string }, key = createHash("sha256").update("tmdb-v1|https://api.themoviedb.org/3/movie/2?language=zh-CN").digest("hex"); f.db.connection.prepare("INSERT INTO tmdb_cache VALUES(?,?,?)").run(key, cached.value, Date.now() + 600000); await f.corrections.close(); await f.pipeline.close(); await f.connections.close(); f.db.close();
    const runtime = createMediaApplication(join(f.path, "core.sqlite3"), [], { nativeFiles: nativeLaunch }); cleanup.push(() => runtime.stop()); await runtime.app.start();
    const privateCall = (action: string, payload: unknown) => runtime.dispatchPrivate({ kind: "core.private.request", requestId: randomUUID(), action, payload }), call = (action: string, payload: unknown) => runtime.dispatch({ kind: "request", protocolVersion: 1, requestId: randomUUID(), action, payload });
    for (const grant of [f.oldGrant, f.targetGrant]) await privateCall("media.targets.authorize", grant); await privateCall("media.credentials.install", { tmdb: "fixture-offline-cache", emby: null });
    await expect(call("corrections.preview", { taskId: f.taskId, requestKey: randomUUID(), selection: { tmdbId: 2, mediaType: "MOVIE" }, targetPath: "/不得访问" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const preparation = (id: string) => call("corrections.preparation", { id }) as Promise<CoreOutput<"corrections.preparation">>;
    const prepared = await call("corrections.preview", { taskId: f.taskId, requestKey: randomUUID(), selection: { tmdbId: 2, mediaType: "MOVIE" }, targetId: f.targetGrant.id }) as CoreOutput<"corrections.preview">; expect(prepared.state).toBe("PENDING"); await expect.poll(async () => (await preparation(prepared.id)).state).toBe("READY");
    const p = await call("corrections.get-preview", { id: (await preparation(prepared.id)).previewId! }) as CoreOutput<"corrections.get-preview">; expect(await readFile(f.oldPath)).toEqual(f.bytes);
    const confirming = await call("corrections.confirm", { previewId: p.id, requestKey: randomUUID(), filesComplete: true }) as CoreOutput<"corrections.confirm">; await expect.poll(async () => (await preparation(confirming.id)).state).toBe("READY");
    const jobId = (await preparation(confirming.id)).operationId!; await expect.poll(async () => (await call("corrections.get", { id: jobId }) as CoreOutput<"corrections.get">).operation.state, { timeout: 10000 }).toBe("RECORDED"); const job = (await call("corrections.get", { id: jobId }) as CoreOutput<"corrections.get">).operation;
    const tasks = await call("tasks.list", {}) as CoreOutput<"tasks.list">; expect(tasks.items.find((task) => task.id === f.taskId)).toMatchObject({ status: "CORRECTED", correctedToId: job.newTaskId }); expect(tasks.items.find((task) => task.id === job.newTaskId)).toMatchObject({ status: "DONE", correctedFromId: f.taskId }); expect(await readFile(p.targetPath)).toEqual(f.bytes); expect(await readFile(f.original)).toEqual(f.bytes);
  });
  async function batchFixture() {
    const f = await fixture(false, true), [second] = await f.addEpisodes([{ season: 1, episode: 2 }]);
    const input = { taskId: f.taskId, requestKey: randomUUID(), scope: "SAME_SEASON" as const, tmdbId: 2, targetId: f.targetGrant.id };
    return { ...f, second: second!, input, async ready(extra = {}) { const batch = f.corrections.batches.create({ ...input, requestKey: randomUUID(), ...extra }); await f.corrections.batches.tick(); expect(f.corrections.batches.get(batch.id).state).toBe("READY"); return f.corrections.batches.get(batch.id); } };
  }
  it("批量范围跨分页完整计算，同季与同剧分开，显式排除仍保留在范围指纹中", async () => {
    const f = await fixture(false, true); await f.addEpisodes([{ season: 0, episode: 1 }, { season: 1, episode: 2 }, ...Array.from({ length: 25 }, (_, index) => ({ season: 1, episode: index + 5 }))]);
    const batch = f.corrections.batches.create({ taskId: f.taskId, requestKey: randomUUID(), scope: "SAME_SERIES", tmdbId: 2 });
    expect(batch).toMatchObject({ total: 28, selected: 28 }); expect(f.corrections.batches.details({ id: batch.id, page: 1 }).items).toHaveLength(25); expect(f.corrections.batches.details({ id: batch.id, page: 2 }).items).toHaveLength(3); f.corrections.batches.cancel(batch.id);
    const season = f.corrections.batches.create({ taskId: f.taskId, requestKey: randomUUID(), scope: "SAME_SEASON", tmdbId: 2, excludedTaskIds: [f.taskId] }); expect(season).toMatchObject({ total: 27, selected: 26 }); f.corrections.batches.cancel(season.id);
    expect(() => f.corrections.batches.create({ taskId: f.taskId, requestKey: randomUUID(), scope: "SAME_SEASON", tmdbId: 2, excludedTaskIds: [randomUUID()] })).toThrow("不属于");
    expect(await readFile(f.original)).toEqual(f.bytes); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_file_relocation").get()).toEqual({ n: 0 });
  }, 30000);
  it("只读范围不创建预览，范围变化拒绝旧选择，批次查询恢复完整参数", async () => {
    const f = await batchFixture(), scope = f.corrections.batches.scope({ taskId: f.taskId, scope: "SAME_SEASON" }); expect(scope).toMatchObject({ total: 2, page: 1 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_batch").get()).toEqual({ n: 0 });
    f.db.connection.prepare("UPDATE media_task SET updated_at=? WHERE id=?").run("2099-03-01T00:00:00.000Z", f.second.taskId);
    expect(() => f.corrections.batches.create({ ...f.input, expectedFingerprint: scope.fingerprint })).toThrow("所选范围在预览前已变化");
    const current = f.corrections.batches.scope({ taskId: f.taskId, scope: "SAME_SEASON" }), batch = await f.ready({ expectedFingerprint: current.fingerprint, includeAccessories: false, template: "{title}/S{season:02d}E{episode:02d}.{ext}", excludedTaskIds: [f.second.taskId] });
    expect(f.corrections.batches.details({ id: batch.id }).batch.configuration).toEqual({ tmdbId: 2, targetId: f.targetGrant.id, includeAccessories: false, template: "{title}/S{season:02d}E{episode:02d}.{ext}", excludedTaskIds: [f.second.taskId] }); expect(await readFile(f.original)).toEqual(f.bytes);
  });
  it("恢复备份后的批量目标尚待核验时不计完成，核验通过才恢复完成数量", async () => {
    const f = await batchFixture(), batch = await f.ready(); f.corrections.batches.confirm({ id: batch.id, requestKey: randomUUID(), fingerprint: batch.fingerprint, filesComplete: true }); await f.corrections.batches.tick(); await f.corrections.tick(); expect(f.corrections.batches.get(batch.id).done).toBe(2);
    f.corrections.reconcileRestored(); expect(f.corrections.batches.get(batch.id)).toMatchObject({ state: "SUBMITTED", done: 0, verificationPending: 2 }); expect(f.corrections.batches.details({ id: batch.id }).items.every((item) => item.operation?.verificationPending)).toBe(true);
    const moves = vi.spyOn(native, "renameBeneath"); await f.corrections.tick(); expect(f.corrections.batches.get(batch.id)).toMatchObject({ state: "DONE", done: 2, verificationPending: 0 }); expect(moves).not.toHaveBeenCalled(); expect(await readFile(f.original)).toEqual(f.bytes);
  });
  it("批次预览和确认请求幂等，完整文件复核后一次性领取所有成员，不能绕过批次单独确认", async () => {
    const f = await batchFixture(), batch = f.corrections.batches.create(f.input); expect(f.corrections.batches.create(f.input).id).toBe(batch.id); expect(() => f.corrections.batches.create({ ...f.input, tmdbId: 3 })).toThrow("不同内容");
    await f.corrections.batches.tick(); const ready = f.corrections.batches.get(batch.id), members = f.corrections.batches.details({ id: batch.id }).items; expect(ready).toMatchObject({ state: "READY", previewed: 2 });
    await expect(f.corrections.confirm({ previewId: members[0]!.previewId!, requestKey: randomUUID(), filesComplete: true })).rejects.toThrow("属于批量修正");
    const input = { id: batch.id, fingerprint: ready.fingerprint, filesComplete: true as const, requestKey: randomUUID() }; expect(f.corrections.batches.confirm(input).state).toBe("CONFIRMING"); expect(f.corrections.batches.confirm(input).id).toBe(batch.id);
    await f.corrections.batches.tick(); const submitted = f.corrections.batches.details({ id: batch.id }); expect(submitted.batch).toMatchObject({ state: "SUBMITTED", submitted: 2, done: 0 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get()).toEqual({ n: 2 });
    for (const item of submitted.items) expect(item.operation?.state).toBe("PLANNED"); expect(await readFile(f.oldPath)).toEqual(f.bytes);
    await f.corrections.tick(); expect(f.corrections.batches.get(batch.id)).toMatchObject({ state: "DONE", done: 2 });
    const nextId = submitted.items.find((item) => item.taskId === f.taskId)!.operation!.newTaskId;
    const next = f.corrections.batches.create({ taskId: nextId, requestKey: randomUUID(), scope: "SAME_SEASON", tmdbId: 3 });
    expect(next).toMatchObject({ total: 2, selected: 2 }); f.corrections.batches.cancel(next.id);
  });
  it("相同物理来源中的不同整理策略分别计算范围，修正预览不可改写", async () => {
    const f = await batchFixture(), candidate = f.db.connection.prepare("SELECT candidate_id FROM ingestion_operation WHERE task_id=?").get(f.second.taskId) as { candidate_id: string };
    f.db.connection.prepare("INSERT INTO ingestion_candidate_policy VALUES(?,?,?,?)").run(candidate.candidate_id, "b".repeat(64), "{}", f.oldGrant.id);
    const batch = await f.ready(); expect(batch.total).toBe(1); expect(f.corrections.batches.details({ id: batch.id }).items.map((item) => item.taskId)).toEqual([f.taskId]); const previewId = f.corrections.batches.details({ id: batch.id }).items[0]!.previewId!;
    expect(() => f.db.connection.prepare("UPDATE media_correction_preview SET plan_json='{}' WHERE id=?").run(previewId)).toThrow("不可变");
  });
  it("成员变化、被排除成员变化和附属文件变化均拒绝整批旧确认，不留下部分计划", async () => {
    const f = await batchFixture(), batch = await f.ready({ excludedTaskIds: [f.second.taskId] });
    f.db.connection.prepare("UPDATE media_task SET updated_at=? WHERE id=?").run("2099-01-01T00:00:00.000Z", f.second.taskId);
    expect(() => f.corrections.batches.confirm({ id: batch.id, requestKey: randomUUID(), fingerprint: batch.fingerprint, filesComplete: true })).toThrow("成员、版本");
    const fresh = await f.ready(); f.corrections.batches.confirm({ id: fresh.id, requestKey: randomUUID(), fingerprint: fresh.fingerprint, filesComplete: true });
    await writeFile(join(dirname(f.second.oldPath), basename(f.second.oldPath, ".mkv") + ".ass"), "预览后新增字幕"); await f.corrections.batches.tick();
    expect(f.corrections.batches.get(fresh.id)).toMatchObject({ state: "BLOCKED", submitted: 0 }); expect(f.corrections.batches.details({ id: fresh.id }).items.find((item) => item.taskId === f.second.taskId)?.failure).toContain("复核失败"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get()).toEqual({ n: 0 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_file_relocation").get()).toEqual({ n: 0 }); expect(await readFile(f.oldPath)).toEqual(f.bytes);
  });
  it("重复批次争领成员时只有一组获得活动占用；第二成员入库失败回滚整批执行意图", async () => {
    const f = await batchFixture(), a = await f.ready(), b = await f.ready();
    f.db.connection.exec(`CREATE TRIGGER reject_second_batch BEFORE INSERT ON correction_item WHEN NEW.task_id='${f.second.taskId}' BEGIN SELECT RAISE(ABORT,'受控事务故障'); END;`);
    f.corrections.batches.confirm({ id: a.id, requestKey: randomUUID(), fingerprint: a.fingerprint, filesComplete: true }); await f.corrections.batches.tick(); expect(f.corrections.batches.get(a.id).state).toBe("BLOCKED"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get()).toEqual({ n: 0 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_file_relocation").get()).toEqual({ n: 0 });
    f.db.connection.exec("DROP TRIGGER reject_second_batch"); f.corrections.batches.confirm({ id: b.id, requestKey: randomUUID(), fingerprint: b.fingerprint, filesComplete: true }); await f.corrections.batches.tick();
    const c = f.corrections.batches.create({ ...f.input, requestKey: randomUUID() }); await f.corrections.batches.tick(); expect(f.corrections.batches.get(c.id).state).toBe("BLOCKED"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get()).toEqual({ n: 2 }); expect(await readFile(f.oldPath)).toEqual(f.bytes);
  });
  it("不同旧季映射到新作品同一真实季集时，完整批量预览即阻断重复坐标", async () => {
    const f = await fixture(false, true); await f.addEpisodes([{ season: 2, episode: 1 }]);
    const batch = f.corrections.batches.create({ taskId: f.taskId, requestKey: randomUUID(), scope: "SAME_SERIES", tmdbId: 3 }); await f.corrections.batches.tick();
    expect(f.corrections.batches.get(batch.id)).toMatchObject({ state: "BLOCKED", failure: expect.stringContaining("重复或重叠季集") }); expect(f.corrections.batches.details({ id: batch.id }).items.every((item) => item.previewId)).toBe(true); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get()).toEqual({ n: 0 }); expect(await readFile(f.oldPath)).toEqual(f.bytes);
  });
  it("跨成员主视频或附属路径冲突在预览阶段阻断，并保留完整逐项结果", async () => {
    const f = await batchFixture(), batch = f.corrections.batches.create({ ...f.input, template: "公共目录/冲突.mkv" }); await f.corrections.batches.tick();
    expect(f.corrections.batches.get(batch.id)).toMatchObject({ state: "BLOCKED", failure: expect.stringContaining("目标路径重复") }); expect(f.corrections.batches.details({ id: batch.id }).items.every((item) => item.previewId)).toBe(true); expect(await readFile(f.original)).toEqual(f.bytes);
  });
  it("批量部分失败在核心重启后保留原作业与新任务，独立重试不重做已完成成员", async () => {
    const f = await batchFixture(), batch = await f.ready(); f.corrections.batches.confirm({ id: batch.id, requestKey: randomUUID(), fingerprint: batch.fingerprint, filesComplete: true }); await f.corrections.batches.tick();
    const before = f.corrections.batches.details({ id: batch.id }).items, subtitle = f.corrections.getPreview(before.find((item) => item.taskId === f.taskId)!.previewId!).files.find((file) => file.toPath.endsWith(".srt"))!;
    await mkdir(dirname(subtitle.toPath), { recursive: true }); await writeFile(subtitle.toPath, "外部文件，不可覆盖"); await f.corrections.tick(); expect(f.corrections.batches.get(batch.id)).toMatchObject({ state: "PARTIAL_FAILED", done: 1, failed: 1 });
    const finished = before.find((item) => item.taskId === f.second.taskId)!, completedPath = f.corrections.getPreview(finished.previewId!).targetPath, inode = (await lstat(completedPath)).ino;
    await f.corrections.close(); const restored = new Corrections(f.db, f.pipeline, f.connections, native, f.now); cleanup.push(() => restored.close()); expect(restored.batches.get(batch.id).state).toBe("PARTIAL_FAILED");
    await rename(subtitle.toPath, subtitle.toPath + ".保留"); const failed = before.find((item) => item.taskId === f.taskId)!; restored.retry({ id: failed.operation!.id }); await restored.tick();
    const after = restored.batches.details({ id: batch.id }); expect(after.batch).toMatchObject({ state: "DONE", done: 2, failed: 0 }); expect(after.items.map((item) => item.operation?.id)).toEqual(before.map((item) => item.operation?.id)); expect(after.items.map((item) => item.operation?.newTaskId)).toEqual(before.map((item) => item.operation?.newTaskId)); expect((await lstat(completedPath)).ino).toBe(inode); expect(await readFile(subtitle.toPath + ".保留", "utf8")).toBe("外部文件，不可覆盖"); expect(await readFile(f.original)).toEqual(f.bytes);
  });
  it("取消停止批量文件核验；重启使未确认预览过期或中断，未产生自动确认", async () => {
    const f = await batchFixture(), batch = await f.ready(); await f.corrections.close(); const restored = new Corrections(f.db, f.pipeline, f.connections, native, f.now); cleanup.push(() => restored.close());
    expect(restored.batches.get(batch.id).state).toBe("EXPIRED"); expect(() => restored.batches.confirm({ id: batch.id, requestKey: randomUUID(), fingerprint: batch.fingerprint, filesComplete: true })).toThrow("过期");
    const pending = restored.batches.create({ ...f.input, requestKey: randomUUID() }); restored.batches.cancel(pending.id); await restored.batches.tick(); expect(restored.batches.get(pending.id).state).toBe("CANCELED");
    const unfinished = restored.batches.create({ ...f.input, requestKey: randomUUID() }); await restored.close(); const again = new Corrections(f.db, f.pipeline, f.connections, native, f.now); cleanup.push(() => again.close()); expect(again.batches.get(unfinished.id).state).toBe("INTERRUPTED"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get()).toEqual({ n: 0 });
  });
  it("批量确认长核验期间成员变化会阻断所有意图，取消只中断读取，不产生文件移动", async () => {
    const f = await batchFixture(), batch = await f.ready(), inspect = ManagedRoot.prototype.inspectForRelocation;
    let entered!: () => void, release!: () => void; const ready = new Promise<void>((done) => { entered = done; }), wait = new Promise<void>((done) => { release = done; });
    const spy = vi.spyOn(ManagedRoot.prototype, "inspectForRelocation").mockImplementation(async function (this: ManagedRoot, ...args) { const value = await inspect.apply(this, args); if (join(this.grant.path, ...args[0]) === f.second.oldPath) { entered(); await wait; } return value; });
    f.corrections.batches.confirm({ id: batch.id, requestKey: randomUUID(), fingerprint: batch.fingerprint, filesComplete: true }); const flight = f.corrections.batches.tick(); await ready;
    f.db.connection.prepare("UPDATE media_task SET updated_at=? WHERE id=?").run("2099-02-01T00:00:00.000Z", f.taskId); release(); await flight; spy.mockRestore(); expect(f.corrections.batches.get(batch.id)).toMatchObject({ state: "BLOCKED", submitted: 0, failure: expect.stringContaining("成员、版本") });
    let canceledRead!: () => void; const reading = new Promise<void>((done) => { canceledRead = done; });
    vi.spyOn(ManagedRoot.prototype, "inspectForRelocation").mockImplementation(async function (this: ManagedRoot, parts, signal, progress) { progress?.(0, f.bytes.length); canceledRead(); await new Promise<void>((_done, fail) => { if (signal!.aborted) fail(new Error("取消")); else signal!.addEventListener("abort", () => fail(new Error("取消")), { once: true }); }); return inspect.call(this, parts, signal, progress); });
    const pending = f.corrections.batches.create({ ...f.input, requestKey: randomUUID() }), cancelFlight = f.corrections.batches.tick(); await reading; expect(f.corrections.batches.get(pending.id).currentPath).toBeTruthy(); f.corrections.batches.cancel(pending.id); await cancelFlight;
    expect(f.corrections.batches.get(pending.id).state).toBe("CANCELED"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_file_relocation").get()).toEqual({ n: 0 }); expect(await readFile(f.oldPath)).toEqual(f.bytes);
  });
  it("另一个批量预览的慢速读取不阻塞已确认成员的文件执行", async () => {
    const f = await batchFixture(), [third] = await f.addEpisodes([{ season: 1, episode: 4 }]), active = await f.ready({ excludedTaskIds: [third!.taskId] });
    f.corrections.batches.confirm({ id: active.id, requestKey: randomUUID(), fingerprint: active.fingerprint, filesComplete: true }); await f.corrections.batches.tick();
    const inspect = ManagedRoot.prototype.inspectForRelocation; let entered!: () => void; const reading = new Promise<void>((done) => { entered = done; });
    vi.spyOn(ManagedRoot.prototype, "inspectForRelocation").mockImplementation(async function (this: ManagedRoot, parts, signal, progress) {
      if (join(this.grant.path, ...parts) === third!.oldPath) { entered(); await new Promise<void>((_done, fail) => { if (signal!.aborted) fail(new Error("取消")); else signal!.addEventListener("abort", () => fail(new Error("取消")), { once: true }); }); }
      return inspect.call(this, parts, signal, progress);
    });
    const pending = f.corrections.batches.create({ ...f.input, requestKey: randomUUID(), excludedTaskIds: [f.taskId, f.second.taskId] }), readFlight = f.corrections.batches.tick(); await reading; const execute = f.corrections.tick();
    try { await expect.poll(() => f.corrections.batches.get(active.id).state, { timeout: 3000 }).toBe("DONE"); expect(f.corrections.batches.get(pending.id).state).toBe("PREVIEWING"); }
    finally { f.corrections.batches.cancel(pending.id); await readFlight; await execute; }
    expect(await readFile(third!.oldPath)).toEqual(f.bytes); expect(await readFile(f.original)).toEqual(f.bytes);
  });
  it("批次只在完整预览后计有效期，期限内受理的确认可完成慢速复核，范围与成员快照不可改写", async () => {
    const f = await batchFixture(), inspect = ManagedRoot.prototype.inspectForRelocation;
    const spy = vi.spyOn(ManagedRoot.prototype, "inspectForRelocation").mockImplementation(async function (this: ManagedRoot, ...args) { const value = await inspect.apply(this, args); f.advance(700000); return value; });
    const batch = await f.ready(); expect(batch.expiresAt! - f.now()).toBe(600000);
    expect(() => f.db.connection.prepare("UPDATE media_correction_batch SET fingerprint=? WHERE id=?").run("b".repeat(64), batch.id)).toThrow("不可变"); expect(() => f.db.connection.prepare("UPDATE media_correction_batch_member SET selected=0 WHERE batch_id=?").run(batch.id)).toThrow("不可变");
    f.corrections.batches.confirm({ id: batch.id, requestKey: randomUUID(), fingerprint: batch.fingerprint, filesComplete: true }); await f.corrections.batches.tick(); spy.mockRestore(); expect(f.corrections.batches.get(batch.id)).toMatchObject({ state: "SUBMITTED", submitted: 2 });
  });
  it("批量受限命令返回持久编号，启动恢复后经静态 Core 命令完成整批且无任意路径入口", async () => {
    const f = await batchFixture(); await f.ready();
    for (const [path, predicate] of [["tv/2", "json_extract(value,'$.id')=2"], ["tv/2/season/1", "json_type(value,'$.episodes')='array'"]] as const) {
      const cached = f.db.connection.prepare(`SELECT value FROM tmdb_cache WHERE ${predicate} LIMIT 1`).get() as { value: string }, key = createHash("sha256").update(`tmdb-v1|https://api.themoviedb.org/3/${path}?language=zh-CN`).digest("hex"); f.db.connection.prepare("INSERT OR REPLACE INTO tmdb_cache VALUES(?,?,?)").run(key, cached.value, Date.now() + 600000);
    }
    await f.corrections.close(); await f.pipeline.close(); await f.connections.close(); f.db.close();
    const runtime = createMediaApplication(join(f.path, "core.sqlite3"), [], { nativeFiles: nativeLaunch }); cleanup.push(() => runtime.stop()); await runtime.app.start();
    const privateCall = (action: string, payload: unknown) => runtime.dispatchPrivate({ kind: "core.private.request", requestId: randomUUID(), action, payload }), call = (action: string, payload: unknown) => runtime.dispatch({ kind: "request", protocolVersion: 1, requestId: randomUUID(), action, payload });
    for (const grant of [f.oldGrant, f.targetGrant]) await privateCall("media.targets.authorize", grant); await privateCall("media.credentials.install", { tmdb: "fixture-cached-batch", emby: null });
    await expect(call("corrections.preview-batch", { ...f.input, targetPath: "/不得访问" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const batch = await call("corrections.preview-batch", { ...f.input, requestKey: randomUUID() }) as CoreOutput<"corrections.preview-batch">; expect(batch.state).toBe("PREVIEWING");
    const details = () => call("corrections.batch", { id: batch.id }) as Promise<CoreOutput<"corrections.batch">>; await expect.poll(async () => (await details()).batch.state).toBe("READY");
    const confirmation = await call("corrections.confirm-batch", { id: batch.id, requestKey: randomUUID(), fingerprint: batch.fingerprint, filesComplete: true }) as CoreOutput<"corrections.confirm-batch">; expect(confirmation.state).toBe("CONFIRMING");
    // 不等待十秒调度器才核对受理结果；其余文件执行在生产 Core 定时器中完成。
    await expect.poll(async () => (await details()).batch.state, { timeout: 15000 }).toBe("DONE"); const result = await details(); expect(result.batch).toMatchObject({ total: 2, done: 2, submitted: 2 }); expect(await readFile(f.original)).toEqual(f.bytes);
  }, 20000);
  it.each(["after-first-history", "before-second-history"])("批次在 %s 真实 SIGKILL 后只续未完成成员，已完成历史与文件保持原编号", async (checkpoint) => {
    const f = await batchFixture(), batch = await f.ready(); f.corrections.batches.confirm({ id: batch.id, requestKey: randomUUID(), fingerprint: batch.fingerprint, filesComplete: true }); await f.corrections.batches.tick();
    const members = f.corrections.batches.details({ id: batch.id }).items, targets = members.map((item) => f.corrections.getPreview(item.previewId!).targetPath), databasePath = join(f.path, "core.sqlite3"), config = join(f.path, "batch-crash.json");
    await writeFile(config, JSON.stringify({ id: batch.id, database: databasePath, checkpoint, native: nativeLaunch })); await f.corrections.close(); await f.pipeline.close(); await f.connections.close(); f.db.close(); await rename(f.source, f.source + "-离线");
    const child = spawn(process.execPath, [resolve("tools/desktop-files/correction-batch-crash-child.mjs"), config], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] }); let output = "", errors = "", timeout: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<{ signal: string | null }>((done, fail) => { child.once("error", fail); child.once("exit", (_code, signal) => done({ signal })); }), reached = new Promise<void>((done) => { child.stdout.on("data", (bytes) => { output += bytes.toString(); if (output.includes("CHECKPOINT:" + checkpoint + "\n")) done(); }); }); child.stderr.on("data", (bytes) => { errors = (errors + bytes.toString()).slice(-8192); });
    try { await Promise.race([reached, exited.then(() => { throw new Error("批次检查点前退出：" + errors); }), new Promise((_, fail) => { timeout = setTimeout(() => fail(new Error("批次检查点超时：" + errors)), 15000); })]); expect(child.kill("SIGKILL")).toBe(true); expect((await exited).signal).toBe("SIGKILL"); } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
    const db = await CoreDatabase.open(databasePath, undefined, { exclusiveOwner: true }); cleanup.push(() => db.close()); const connections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" })); cleanup.push(() => connections.close()); const pipeline = new IngestionPipeline(db, () => undefined, connections); cleanup.push(() => pipeline.close()); for (const grant of [f.oldGrant, f.targetGrant]) await pipeline.authorizeTarget(grant); const corrections = new Corrections(db, pipeline, connections, native); cleanup.push(() => corrections.close());
    expect(corrections.batches.get(batch.id)).toMatchObject({ state: "SUBMITTED", done: 1, submitted: 2 }); const before = corrections.batches.details({ id: batch.id }).items, first = before.find((item) => item.operation!.state === "RECORDED")!, firstPath = corrections.getPreview(first.previewId!).targetPath, inode = (await lstat(firstPath)).ino;
    await corrections.tick(); const result = corrections.batches.details({ id: batch.id }); expect(result.batch).toMatchObject({ state: "DONE", done: 2, submitted: 2 }); expect(result.items.map((item) => item.operation?.id)).toEqual(members.map((item) => item.operation?.id)); expect(result.items.map((item) => item.operation?.newTaskId)).toEqual(members.map((item) => item.operation?.newTaskId)); expect((await lstat(firstPath)).ino).toBe(inode);
    for (const target of targets) expect(await readFile(target)).toEqual(f.bytes); for (const item of result.items) expect(db.connection.prepare("SELECT count(*) AS n FROM emby_delivery WHERE correction_id=?").get(item.operation!.id)).toEqual({ n: 1 }); expect(await readFile(join(f.source + "-离线", basename(f.original)))).toEqual(f.bytes);
  }, 25000);
  it.each(["before-history", "after-history"])("独立 Core 在 %s SIGKILL，恢复只补历史或清理，不重新移动已提交媒体", async (checkpoint) => {
    const f = await fixture(true), p = await f.preview({ targetId: f.targetGrant.id }), job = await f.corrections.confirm({ previewId: p.id, requestKey: randomUUID(), filesComplete: true }), config = join(f.path, "crash.json"), databasePath = join(f.path, "core.sqlite3");
    await writeFile(config, JSON.stringify({ id: job.id, database: databasePath, checkpoint, native: nativeLaunch })); await f.corrections.close(); await f.pipeline.close(); await f.connections.close(); f.db.close();
    const child = spawn(process.execPath, [resolve("tools/desktop-files/correction-crash-child.mjs"), config], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] }); let output = "", errors = "", timeout: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<{ signal: string | null }>((done, fail) => { child.once("error", fail); child.once("exit", (_code, signal) => done({ signal })); }), reached = new Promise<void>((done) => { child.stdout.on("data", (bytes) => { output += bytes.toString(); if (output.includes("CHECKPOINT:" + checkpoint + "\n")) done(); }); }); child.stderr.on("data", (bytes) => { errors = (errors + bytes.toString()).slice(-8192); });
    try { await Promise.race([reached, exited.then(() => { throw new Error("检查点前子进程退出：" + errors); }), new Promise((_, fail) => { timeout = setTimeout(() => fail(new Error("检查点等待超时：" + errors)), 15000); })]); expect(child.kill("SIGKILL")).toBe(true); expect((await exited).signal).toBe("SIGKILL"); } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
    const db = await CoreDatabase.open(databasePath, undefined, { exclusiveOwner: true }); cleanup.push(() => db.close()); const restoredConnections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" })); cleanup.push(() => restoredConnections.close()); const pipeline = new IngestionPipeline(db, () => undefined, restoredConnections); cleanup.push(() => pipeline.close()); for (const grant of [f.oldGrant, f.targetGrant]) await pipeline.authorizeTarget(grant); const corrections = new Corrections(db, pipeline, restoredConnections, native); cleanup.push(() => corrections.close());
    const inode = (await lstat(p.targetPath)).ino; expect(corrections.details({ id: job.id }).operation.state).toBe(checkpoint === "before-history" ? "RUNNING" : "RECORDED"); expect(db.connection.prepare("SELECT status,corrected_to_id FROM media_task WHERE id=?").get(f.taskId)).toEqual({ status: checkpoint === "before-history" ? "DONE" : "CORRECTED", corrected_to_id: checkpoint === "before-history" ? null : job.newTaskId });
    const moves = vi.spyOn(native, "renameBeneath"), publishes = vi.spyOn(native, "linkBeneath"); await corrections.tick(); expect(corrections.details({ id: job.id }).operation).toMatchObject({ state: "RECORDED", cleanupPending: false }); expect(moves).not.toHaveBeenCalled(); expect(publishes).not.toHaveBeenCalled(); expect((await lstat(p.targetPath)).ino).toBe(inode); expect(db.connection.prepare("SELECT status,corrected_to_id FROM media_task WHERE id=?").get(f.taskId)).toEqual({ status: "CORRECTED", corrected_to_id: job.newTaskId }); expect(db.connection.prepare("SELECT count(*) AS n FROM emby_delivery WHERE correction_id=?").get(job.id)).toEqual({ n: 1 }); expect(await readFile(f.original)).toEqual(f.bytes);
  }, 25000);
});
