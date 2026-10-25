import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, lstat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DesktopError, type CoreInput } from "@media-marshal/contracts";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import { CoreDatabase } from "../infrastructure/database";
import { MediaConnections } from "../application/media-connections";
import { normalizeParse } from "../domain/media";
import { IngestionPipeline } from "./pipeline";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function grant(path: string): Promise<ManagedRootGrant> { const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true }); return { id: randomUUID(), path, volume: { volumeId: randomUUID(), rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "real-isolated-test", caseSensitive: true, unicodeEquivalent: true, pathMaxBytes: 4096 } }; }
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "marshal-organize-batch-"))); cleanup.push(() => rm(path, { recursive: true, force: true })); const source = join(path, "中文剧集"), target = join(path, "媒体库"); await mkdir(source); await mkdir(target);
  for (const number of [1, 2]) await writeFile(join(source, `作品.S01E0${number}.mkv`), `第 ${number} 集原内容保留`);
  const db = await CoreDatabase.open(join(path, "core.sqlite3")); cleanup.push(() => db.close()); let clock = Date.now(), monotonic = 0;
  const work = { id: 7, name: "测试剧集", original_name: "Test Series", first_air_date: "2026-01-01", seasons: [{ season_number: 1 }] };
  const server = createServer((req, res) => { res.setHeader("Content-Type", "application/json"); const url = new URL(req.url!, "http://localhost"); if (url.pathname.startsWith("/search/")) res.end(JSON.stringify({ results: [work] })); else if (url.pathname === "/tv/7") res.end(JSON.stringify(work)); else if (url.pathname === "/tv/7/season/1") res.end(JSON.stringify({ episodes: [1, 2, 3].map((episode_number) => ({ episode_number, season_number: 1, name: `第 ${episode_number} 集` })) })); else res.writeHead(404).end("{}"); }); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); cleanup.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
  const connections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" }), { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }); cleanup.push(() => connections.close()); connections.install({ tmdb: "fixture-private", emby: null });
  const parser = { ready: true, parse: async (name: string) => normalizeParse({ title: "测试剧集", type: "episode", season: 1, episode: Number(/E0?(\d+)/.exec(name)?.[1] ?? 1), year: 2026 }, name) };
  const pipeline = new IngestionPipeline(db, () => parser, connections, () => clock, () => monotonic); cleanup.push(() => pipeline.close()); const sourceId = randomUUID(), sourceGrant = await grant(source), targetGrant = await grant(target), stamp = new Date(clock).toISOString();
  db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'批量整理测试','custom',?,?,'AUTO','COPY',?)").run(sourceId, source, target, stamp); const authorization = { sourceId, sourceVersion: 1, mode: "local" as const, downloadRootId: null, source: sourceGrant, target: targetGrant }; await pipeline.authorize(authorization);
  const advance = async () => { for (let n = 0; n < 12; n++) { clock += 10000; monotonic += 10000; await pipeline.scan(sourceId); } };
  await pipeline.scan(sourceId); await advance(); const candidates = pipeline.list({}).items.sort((a, b) => a.relativePath.localeCompare(b.relativePath)); const tasks: string[] = [];
  for (const candidate of candidates) tasks.push((await pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() })).taskId); await pipeline.tick();
  const input = (): CoreInput<"ingestion.preview-organize-batch"> => ({ requestKey: randomUUID(), items: tasks.map((taskId, index) => ({ taskId, expectedRevision: 0, selection: { tmdbId: 7, mediaType: "TV_SHOW", season: 1, episode: index + 1, episodeEnd: null } })), includeAccessories: false });
  return { path, db, pipeline, parser, now: () => clock, monotonic: () => monotonic, connections, source, target, sourceId, sourceGrant, targetGrant, authorization, tasks, input, advance, jump(ms: number) { clock += ms; monotonic += ms; } };
}
describe("共同作品的逐文件预览与持久批量确认", () => {
  it("创建只保存意图，预览核对真实季集，明确确认后才逐项 COPY；重复确认复用原操作", async () => {
    const f = await fixture(), input = f.input(), job = f.pipeline.organizeBatches.create(input); expect(f.pipeline.organizeBatches.create(input).id).toBe(job.id); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
    await f.pipeline.organizeBatches.tick(); expect(f.pipeline.organizeBatches.get(job.id).state).toBe("READY"); const details = f.pipeline.organizeBatches.details({ id: job.id }); expect(details.items.map((row) => row.preview?.episode)).toEqual([1, 2]); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
    await expect(f.pipeline.confirm({ previewId: details.items[0]!.preview!.id, requestKey: randomUUID() })).rejects.toThrow("批次入口");
    const confirmation = { id: job.id, requestKey: randomUUID(), filesComplete: true as const }; f.pipeline.organizeBatches.confirm(confirmation); await f.pipeline.organizeBatches.tick(); await f.pipeline.tick(); f.pipeline.organizeBatches.confirm(confirmation); await f.pipeline.organizeBatches.tick();
    expect(f.pipeline.organizeBatches.get(job.id)).toMatchObject({ state: "DONE", submitted: 2, done: 2, failed: 0 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 2 });
    for (const row of f.pipeline.organizeBatches.details({ id: job.id }).items) expect(await readFile(row.preview!.targetPath)).toEqual(await readFile(row.sourcePath));
  });
  it("重复、重叠和真实季号映射后的重复逐项定位，整批不能确认", async () => {
    const f = await fixture(), input = f.input(); input.items[0]!.selection.episodeEnd = 2; input.items[1]!.selection.season = 2;
    const job = f.pipeline.organizeBatches.create(input); await f.pipeline.organizeBatches.tick(); const details = f.pipeline.organizeBatches.details({ id: job.id }); expect(details.batch.state).toBe("BLOCKED");
    expect(details.items.every((row) => row.errors.some((message) => message.includes("S1 E2") && message.includes("作品.S01E01") && message.includes("作品.S01E02")))).toBe(true); expect(() => f.pipeline.organizeBatches.confirm({ id: job.id, requestKey: randomUUID(), filesComplete: true })).toThrow(); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
  });
  it("不同集号仍可能同目标，模板碰撞阻断并显示双方文件", async () => {
    const f = await fixture(), job = f.pipeline.organizeBatches.create({ ...f.input(), template: "同名目标.mkv" }); await f.pipeline.organizeBatches.tick(); const details = f.pipeline.organizeBatches.details({ id: job.id }); expect(details.batch.blocked).toBe(2); expect(details.items.every((row) => row.errors.some((message) => message.includes("目标冲突") && message.includes("同名目标.mkv")))).toBe(true);
  });
  it("字段编辑和预览过期使整个确认失效，不提交有效子集", async () => {
    const f = await fixture(), job = f.pipeline.organizeBatches.create(f.input()); await f.pipeline.organizeBatches.tick(); const edit = { items: [{ taskId: f.tasks[0]!, expectedRevision: 0 }], patch: { title: "新识别标题" } }, p = f.pipeline.recognitionEdits.preview(edit); f.pipeline.recognitionEdits.save({ ...edit, fingerprint: p.fingerprint, requestKey: randomUUID(), rematch: false });
    expect(f.pipeline.organizeBatches.get(job.id).state).toBe("BLOCKED"); expect(f.pipeline.organizeBatches.confirm({ id: job.id, requestKey: randomUUID(), filesComplete: true }).state).toBe("BLOCKED"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
    const request = f.input(); request.items[0]!.expectedRevision = 1; const fresh = f.pipeline.organizeBatches.create(request); await f.pipeline.organizeBatches.tick(); f.jump(600001); expect(f.pipeline.organizeBatches.get(fresh.id).state).toBe("EXPIRED");
  });
  it("确认后外部文件抢占导致部分失败，其他项继续，第三方文件与来源保留", async () => {
    const f = await fixture(), job = f.pipeline.organizeBatches.create(f.input()); await f.pipeline.organizeBatches.tick(); const details = f.pipeline.organizeBatches.details({ id: job.id }), foreign = details.items[0]!.preview!.targetPath; await mkdir(dirname(foreign), { recursive: true }); await writeFile(foreign, "外部内容");
    f.pipeline.organizeBatches.confirm({ id: job.id, requestKey: randomUUID(), filesComplete: true }); await f.pipeline.organizeBatches.tick(); await f.pipeline.tick(); expect(f.pipeline.organizeBatches.get(job.id)).toMatchObject({ state: "PARTIAL_FAILED", failed: 1, done: 1 }); expect(await readFile(foreign, "utf8")).toBe("外部内容"); expect(await readFile(details.items[1]!.preview!.targetPath)).toEqual(await readFile(details.items[1]!.sourcePath));
  });
  it("COPY 已领取但批次补记故障后继续同一操作，重试不重复复制", async () => {
    const f = await fixture(), request = f.input(); request.items = request.items.slice(0, 1); const job = f.pipeline.organizeBatches.create(request); await f.pipeline.organizeBatches.tick(); f.pipeline.organizeBatches.confirm({ id: job.id, requestKey: randomUUID(), filesComplete: true });
    f.db.connection.exec("CREATE TRIGGER batch_receipt_fault BEFORE UPDATE OF state ON ingestion_organize_batch_item WHEN NEW.state='SUBMITTED' BEGIN SELECT RAISE(ABORT,'受控批次补记故障'); END"); await f.pipeline.organizeBatches.tick(); await f.pipeline.tick(); const row = f.pipeline.organizeBatches.details({ id: job.id }).items[0]!; expect(row.operationId).not.toBeNull(); expect(row.waitingReason).toContain("等待批次补记"); const inode = (await lstat(row.preview!.targetPath)).ino;
    f.db.connection.exec("DROP TRIGGER batch_receipt_fault"); f.jump(5001); await f.pipeline.organizeBatches.tick(); expect(f.pipeline.organizeBatches.get(job.id).state).toBe("DONE"); expect((await lstat(row.preview!.targetPath)).ino).toBe(inode); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
  });
  it("暂停时已确认意图等待，恢复重新观察后沿原计划提交；取消预览不写媒体", async () => {
    const f = await fixture(), job = f.pipeline.organizeBatches.create(f.input()); await f.pipeline.organizeBatches.tick(); f.pipeline.setPaused({ paused: true, requestKey: randomUUID() }); f.pipeline.organizeBatches.confirm({ id: job.id, requestKey: randomUUID(), filesComplete: true }); await f.pipeline.organizeBatches.tick(); expect(f.pipeline.organizeBatches.get(job.id).submitted).toBe(0);
    f.pipeline.setPaused({ paused: false, requestKey: randomUUID() }); await f.pipeline.scan(f.sourceId); await f.advance(); await f.pipeline.organizeBatches.tick(); await f.pipeline.tick(); expect(f.pipeline.organizeBatches.get(job.id).done).toBe(2);
    const cancelled = f.pipeline.organizeBatches.create(f.input()); f.pipeline.organizeBatches.cancel(cancelled.id); await f.pipeline.organizeBatches.tick(); expect(f.pipeline.organizeBatches.get(cancelled.id).state).toBe("CANCELLED"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 2 });
  });
  it("确认意图经数据库重开恢复，授权与连续观察恢复前不提交，之后保留原批次和操作", async () => {
    const f = await fixture(), job = f.pipeline.organizeBatches.create(f.input()); await f.pipeline.organizeBatches.tick(); f.pipeline.organizeBatches.confirm({ id: job.id, requestKey: randomUUID(), filesComplete: true });
    await f.pipeline.close(); f.connections.close(); f.db.close(); const db = await CoreDatabase.open(join(f.path, "core.sqlite3")); cleanup.push(() => db.close());
    const connections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" })); cleanup.push(() => connections.close());
    const pipeline = new IngestionPipeline(db, () => f.parser, connections, f.now, f.monotonic); cleanup.push(() => pipeline.close()); await pipeline.organizeBatches.tick(); expect(pipeline.organizeBatches.get(job.id).submitted).toBe(0); expect(pipeline.organizeBatches.details({ id: job.id }).items[0]?.waitingReason).toContain("等待核心恢复服务凭据"); connections.install({ tmdb: "fixture-private", emby: null }); f.jump(5001); await pipeline.organizeBatches.tick(); expect(pipeline.organizeBatches.details({ id: job.id }).items[0]?.waitingReason).toContain("等待原磁盘");
    await pipeline.authorize(f.authorization); f.jump(5001); await pipeline.organizeBatches.tick(); expect(pipeline.organizeBatches.get(job.id).submitted).toBe(0);
    for (let n = 0; n < 12; n++) { f.jump(10000); await pipeline.scan(f.sourceId); } await pipeline.organizeBatches.tick(); await pipeline.tick(); expect(pipeline.organizeBatches.get(job.id)).toMatchObject({ state: "DONE", done: 2 }); expect(db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 2 });
  });
  it("预览回执尚未归入成员时也不能从单文件入口绕过整批检查", async () => {
    const f = await fixture(), job = f.pipeline.organizeBatches.create(f.input());
    const original = f.pipeline.organizeBatches["ports"].preview;
    vi.spyOn(f.pipeline.organizeBatches["ports"], "preview").mockImplementationOnce(async (input) => { const preview = await original(input); await expect(f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() })).rejects.toThrow("批次入口"); return preview; });
    await f.pipeline.organizeBatches.tick(); expect(f.pipeline.organizeBatches.get(job.id).state).toBe("READY"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
  });
  it("预览和提交期间取消保留已经开始的项，后续文件不再提交", async () => {
    const f = await fixture(), job = f.pipeline.organizeBatches.create(f.input()), ports = f.pipeline.organizeBatches["ports"], original = ports.preview;
    vi.spyOn(ports, "preview").mockImplementationOnce(async (input) => { const result = await original(input); f.pipeline.organizeBatches.cancel(job.id); return result; });
    await f.pipeline.organizeBatches.tick(); expect(f.pipeline.organizeBatches.get(job.id)).toMatchObject({ state: "CANCELLED", previewed: 1, submitted: 0 });
    const next = f.pipeline.organizeBatches.create(f.input()); await f.pipeline.organizeBatches.tick(); f.pipeline.organizeBatches.confirm({ id: next.id, requestKey: randomUUID(), filesComplete: true }); const confirm = ports.confirm;
    vi.spyOn(ports, "confirm").mockImplementationOnce(async (...args) => { const result = await confirm(...args); f.pipeline.organizeBatches.cancel(next.id); return result; });
    await f.pipeline.organizeBatches.tick(); await f.pipeline.tick(); expect(f.pipeline.organizeBatches.get(next.id)).toMatchObject({ state: "CANCELLED", submitted: 1, done: 1 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
  });
  it("附属文件按需读取并参与跨文件目标占用检查", async () => {
    const f = await fixture(); await writeFile(join(f.source, "作品.S01E01.srt"), "中文对白"); await writeFile(join(f.source, "作品.S01E02.srt"), "第二集对白");
    const warm = f.pipeline.organizeBatches.create({ ...f.input(), includeAccessories: true }); await f.pipeline.organizeBatches.tick(); expect(f.pipeline.organizeBatches.get(warm.id).state).toBe("BLOCKED");
    await f.advance(); const job = f.pipeline.organizeBatches.create({ ...f.input(), includeAccessories: true }); await f.pipeline.organizeBatches.tick(); const detail = f.pipeline.organizeBatches.details({ id: job.id }); expect(detail.batch.state).toBe("READY"); expect(detail.items.every((row) => row.accessoryCount === 1 && !row.preview?.accessories?.length)).toBe(true); expect(f.pipeline.organizeBatches.assets({ id: job.id, taskId: f.tasks[0]! }).items[0]?.sourcePath).toContain("作品.S01E01.srt");
    const manifest = JSON.parse((f.db.connection.prepare("SELECT manifest_json FROM ingestion_organize_batch_item WHERE batch_id=? ORDER BY ordinal LIMIT 1").get(job.id) as { manifest_json: string }).manifest_json);
    const second = JSON.parse((f.db.connection.prepare("SELECT manifest_json FROM ingestion_organize_batch_item WHERE batch_id=? AND task_id=?").get(job.id, f.tasks[1]) as { manifest_json: string }).manifest_json); second.targets[1] = manifest.targets[1]; f.db.connection.prepare("UPDATE ingestion_organize_batch_item SET manifest_json=? WHERE batch_id=? AND task_id=?").run(JSON.stringify(second), job.id, f.tasks[1]);
    expect(f.pipeline.organizeBatches.get(job.id).blocked).toBe(2); expect(f.pipeline.organizeBatches.details({ id: job.id }).items[0]?.errors.join(" ")).toContain(".srt");
  });

  it("与已有计划重叠时定位双方文件和实际坐标，已删除来源不接受新预览", async () => {
    const f = await fixture(), first = f.input().items[0]!, preview = await f.pipeline.preview({ taskId: first.taskId, requestKey: randomUUID(), selection: first.selection, includeAccessories: false }); await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
    const input = f.input(); input.items = [{ ...input.items[1]!, selection: first.selection }]; input.template = "另一目录/{title}-S{season:02d}E{episode:02d}.{ext}"; const job = f.pipeline.organizeBatches.create(input); await f.pipeline.organizeBatches.tick(); expect(f.pipeline.organizeBatches.details({ id: job.id }).items[0]!.errors.join(" ")).toMatch(/作品.S01E02.*作品.S01E01.*S1 E1/);
    const configuration = JSON.stringify({ type: "local", name: "已删除来源", client: "custom", sourcePath: f.source, organization: { targetPath: f.target } }), stamp = new Date(f.now()).toISOString();
    f.db.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,local_source_id,deleted_at,created_at,updated_at) VALUES(?,'local',1,1,?,?,?,?,?)").run(randomUUID(), configuration, f.sourceId, stamp, stamp, stamp);
    const deleted = f.pipeline.organizeBatches.create({ ...f.input(), items: [f.input().items[1]!] }); await f.pipeline.organizeBatches.tick(); expect(f.pipeline.organizeBatches.details({ id: deleted.id }).items[0]?.errors.join(" ")).toContain("所属来源已删除"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
  });

  it("停止期间不领取等待之后的新预览，已发出的网络取消保留原意图供重启恢复", async () => {
    const f = await fixture(), first = f.pipeline.organizeBatches.create(f.input()), ports = f.pipeline.organizeBatches["ports"];
    let release!: (value: null) => void; vi.spyOn(ports, "available").mockImplementationOnce(() => new Promise((done) => { release = done; })); const preview = vi.spyOn(ports, "preview"), flight = f.pipeline.organizeBatches.tick(), closing = f.pipeline.organizeBatches.close(); release(null); await Promise.all([flight, closing]); expect(preview).not.toHaveBeenCalled(); expect(f.pipeline.organizeBatches.get(first.id).previewed).toBe(0);
    const next = await fixture(), job = next.pipeline.organizeBatches.create(next.input()); let reject!: (error: Error) => void, entered!: () => void; const started = new Promise<void>((done) => { entered = done; });
    vi.spyOn(next.pipeline.organizeBatches["ports"], "preview").mockImplementationOnce(() => { entered(); return new Promise((_done, fail) => { reject = fail; }); }); const running = next.pipeline.organizeBatches.tick(); await started; const stopped = next.pipeline.organizeBatches.close(); reject(new DesktopError("INTERRUPTED", "受控核心退出")); await Promise.all([running, stopped]);
    expect(next.pipeline.organizeBatches.get(job.id)).toMatchObject({ state: "PREVIEWING", blocked: 0, submitted: 0 }); expect(next.pipeline.organizeBatches.details({ id: job.id }).items[0]).toMatchObject({ state: "PENDING", waitingReason: expect.stringContaining("重启后继续") });
  });

  it("预览与确认等待期间发生暂停时保留原意图，恢复观察后继续原批次", async () => {
    const f = await fixture(), job = f.pipeline.organizeBatches.create(f.input()), ports = f.pipeline.organizeBatches["ports"], preview = ports.preview;
    vi.spyOn(ports, "preview").mockImplementationOnce(async (input) => { f.pipeline.setPaused({ paused: true, requestKey: randomUUID() }); return preview(input); });
    await f.pipeline.organizeBatches.tick(); expect(f.pipeline.organizeBatches.get(job.id)).toMatchObject({ state: "PREVIEWING", blocked: 0, submitted: 0 }); expect(f.pipeline.organizeBatches.details({ id: job.id }).items[0]?.waitingReason).toContain("暂停");
    f.pipeline.setPaused({ paused: false, requestKey: randomUUID() }); await f.pipeline.scan(f.sourceId); await f.advance(); await f.pipeline.organizeBatches.tick(); expect(f.pipeline.organizeBatches.get(job.id).state).toBe("READY");
    f.pipeline.organizeBatches.confirm({ id: job.id, requestKey: randomUUID(), filesComplete: true }); const confirm = ports.confirm; vi.spyOn(ports, "confirm").mockImplementationOnce(async (...args) => { f.pipeline.setPaused({ paused: true, requestKey: randomUUID() }); return confirm(...args); });
    await f.pipeline.organizeBatches.tick(); expect(f.pipeline.organizeBatches.get(job.id)).toMatchObject({ state: "CONFIRMING", failed: 0, submitted: 0 }); f.pipeline.setPaused({ paused: false, requestKey: randomUUID() }); await f.pipeline.scan(f.sourceId); await f.advance(); await f.pipeline.organizeBatches.tick(); await f.pipeline.tick(); expect(f.pipeline.organizeBatches.get(job.id)).toMatchObject({ state: "DONE", done: 2 });
  });

});
