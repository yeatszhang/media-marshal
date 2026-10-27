import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, lstat, statfs, realpath, rm, writeFile, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { SyncSourceRule } from "@media-marshal/contracts";
import { CoreDatabase } from "../infrastructure/database.js";
import { CloudRoots } from "../cloud/roots.js";
import { CloudDownloads } from "../cloud/downloads.js";
import { RemoteCatalog } from "../cloud/catalog.js";
import { unavailableHost } from "../cloud/host-gateway.js";
import { ConfigurationDirectories } from "./configuration-directories.js";
import { LocalSync } from "./local-sync.js";
import { SyncRules } from "./sync-rules.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-local-sync-"))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const db = await CoreDatabase.open(join(directory, "core.sqlite3")); cleanup.push(() => db.close());
  const roots = new CloudRoots(db); cleanup.push(() => roots.close()); const directories = new ConfigurationDirectories(db, roots); cleanup.push(() => directories.close());
  let clock = 0; const now = () => Date.UTC(2026, 9, 28) + clock, volumeId = randomUUID();
  async function grant(name: string) { const path = join(directory, name); await mkdir(path, { recursive: true }); const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true }); return { id: randomUUID(), path, volume: { volumeId, rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "isolated-test", caseSensitive: true, unicodeEquivalent: true, pathMaxBytes: 4096 } } satisfies ManagedRootGrant; }
  const input = await grant("原输入 中文"), target = await grant("下载目标 A"), secondTarget = await grant("下载目标 B");
  await directories.authorize(input, "ordinary"); await directories.authorize(target, "managed"); await directories.authorize(secondTarget, "managed"); directories.setDefault({ directoryId: target.id, expectedVersion: 0, requestKey: randomUUID() });
  const catalog = new RemoteCatalog(db, unavailableHost), downloads = new CloudDownloads(db, unavailableHost, catalog, roots, now); cleanup.push(() => downloads.close());
  const local = new LocalSync(db, directories, roots, now, () => clock), rules = new SyncRules(db, directories, downloads, local, now); cleanup.push(() => rules.close());
  const content = "真实隔离同步文件，保留原输入。".repeat(100); await writeFile(join(input.path, "原片.mp4"), content);
  const version = (row: SyncSourceRule) => ({ id: row.id, expectedVersion: row.version, expectedDraftRevision: row.draftRevision, expectedLifecycleRevision: row.lifecycleRevision });
  const save = (row?: SyncSourceRule, directoryId?: string) => rules.save({ ...(row ? version(row) : { id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, expectedLifecycleRevision: 0 }), requestKey: randomUUID(), configuration: { type: "local", name: row?.draft.name ?? "本地单向同步", inputDirectoryId: input.id, target: directoryId ? { kind: "directory", directoryId } : { kind: "default" } } });
  const preview = (row: SyncSourceRule, mode: "configuration" | "execution" = "configuration", force = false) => rules.preview({ ...version(row), requestKey: randomUUID(), mode, force });
  const enable = async () => { const row = save(), p = await preview(row); return (await rules.confirm({ previewId: p.id, requestKey: randomUUID() })).rule; };
  const advance = async (seconds = 130) => { for (let elapsed = 0; elapsed < seconds; elapsed += 10) { clock += 10000; await rules.tick(); } };
  return { directory, db, roots, directories, input, target, secondTarget, downloads, local, rules, content, now, version, save, preview, enable, advance };
}
describe("独立本地单向同步、成功历史和阶段控制", () => {
  it("默认目录改变后普通编辑保留已绑定目录，只有明确改绑才使用新默认值", async () => {
    const f = await fixture(), source = await f.enable();
    f.directories.setDefault({ expectedVersion: 1, directoryId: f.secondTarget.id, requestKey: randomUUID() });
    const changed = f.save(source), ordinary = await f.preview(changed);
    expect(ordinary.snapshot.targetDirectory.id).toBe(f.target.id);
    const rebound = await f.rules.preview({ ...f.version(changed), requestKey: randomUUID(), useCurrentDefault: true });
    expect(rebound.snapshot.targetDirectory.id).toBe(f.secondTarget.id);
    await f.rules.confirm({ previewId: rebound.id, requestKey: randomUUID() }); expect(f.rules.get(source.id).snapshot?.targetDirectory.id).toBe(f.secondTarget.id);
  });
  it("正式文件已提交而记账失败后，输入离线仍只恢复原作业并保留文件身份", async () => {
    const f = await fixture(), source = await f.enable(); await f.advance(); const preview = await f.preview(source, "execution");
    const accepted = await f.rules.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true });
    f.db.connection.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON sync_receipt BEGIN SELECT RAISE(ABORT,'模拟提交后记账中断'); END;"); await f.rules.tick();
    const path = join(f.target.path, "completed/原片.mp4"), inode = (await lstat(path)).ino;
    expect(f.rules.getJob(accepted.jobId!).state).toBe("NEEDS_ATTENTION"); expect(f.rules.jobFiles({ id: accepted.jobId! }).items[0]?.reason).toContain("记账");
    f.db.connection.exec("DROP TRIGGER fail_receipt"); await rename(f.input.path, f.input.path + "-暂时离线"); f.local.resetObservations();
    f.rules.retry({ id: accepted.jobId!, requestKey: randomUUID() }); await f.rules.tick();
    expect(f.rules.getJob(accepted.jobId!).state).toBe("DONE"); expect((await lstat(path)).ino).toBe(inode); expect(await readFile(path, "utf8")).toBe(f.content);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM sync_receipt").get()).toEqual({ n: 1 });
  });
  it("无账号和 Go 组件仍可预览、明确确认及 COPY，重复确认只产生一个操作和成功收据", async () => {
    const f = await fixture(), source = await f.enable();
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM local_sync_operation").get()).toEqual({ n: 0 });
    const early = await f.preview(source, "execution"); expect(early).toMatchObject({ state: "BLOCKED", observing: 1 });
    await f.advance(); const p = f.rules.getPreview(early.id); expect(p).toMatchObject({ state: "READY", observing: 0 });
    await expect(f.rules.confirm({ previewId: p.id, requestKey: randomUUID() })).rejects.toThrow(/确认本地文件完整/);
    const command = { previewId: p.id, requestKey: randomUUID(), filesComplete: true as const }, result = await f.rules.confirm(command); expect(await f.rules.confirm(command)).toEqual(result); await f.rules.tick();
    expect(await readFile(join(f.target.path, "completed/原片.mp4"), "utf8")).toBe(f.content); expect(await readFile(join(f.input.path, "原片.mp4"), "utf8")).toBe(f.content);
    expect(f.rules.jobs({}).items[0]).toMatchObject({ id: result.jobId, state: "DONE", files: 1, done: 1 });
    for (const table of ["local_sync_operation", "sync_receipt"]) expect(f.db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
    for (const table of ["download_job", "download_attempt", "media_task", "ingestion_operation"]) expect(f.db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });
  it("删除成果后普通执行不补回，等价来源共享收据；显式重新同步使用新范围且保留旧历史", async () => {
    const f = await fixture(), source = await f.enable(); await f.advance();
    const p = await f.preview(source, "execution"); await f.rules.confirm({ previewId: p.id, requestKey: randomUUID(), filesComplete: true }); await f.rules.tick(); await rm(join(f.target.path, "completed/原片.mp4"));
    const draft = f.save(), second = (await f.rules.confirm({ previewId: (await f.preview(draft)).id, requestKey: randomUUID() })).rule;
    const removed = await f.preview(second, "execution"); expect(removed).toMatchObject({ state: "READY", removed: 1 });
    const reused = await f.rules.confirm({ previewId: removed.id, requestKey: randomUUID(), filesComplete: true }); await f.rules.tick();
    expect(f.rules.jobs({}).items.find((job) => job.id === reused.jobId)).toMatchObject({ state: "DONE", removed: 1 }); await expect(readFile(join(f.target.path, "completed/原片.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    const forced = await f.preview(second, "execution", true), files = f.rules.previewFiles({ id: forced.id }); expect(files.items[0]?.targetPath).toContain("resync-");
    await f.rules.confirm({ previewId: forced.id, requestKey: randomUUID(), filesComplete: true }); await f.rules.tick();
    expect(await readFile(files.items[0]!.targetPath, "utf8")).toBe(f.content); expect(f.db.connection.prepare("SELECT count(*) AS n FROM sync_receipt").get()).toEqual({ n: 2 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM local_sync_operation").get()).toEqual({ n: 2 });
  });
  it("默认值变更和草稿编辑使配置预览失效，既有来源与已受理计划继续使用原目标", async () => {
    const f = await fixture(), draft = f.save(), old = await f.preview(draft);
    f.directories.setDefault({ directoryId: f.secondTarget.id, expectedVersion: 1, requestKey: randomUUID() }); await expect(f.rules.confirm({ previewId: old.id, requestKey: randomUUID() })).rejects.toThrow(/过期|变化/);
    f.directories.setDefault({ directoryId: f.target.id, expectedVersion: 2, requestKey: randomUUID() }); const source = (await f.rules.confirm({ previewId: (await f.preview(draft)).id, requestKey: randomUUID() })).rule;
    await f.advance(); f.downloads.setPaused({ paused: true, requestKey: randomUUID() }); f.local.pauseChanged(); await f.rules.tick();
    f.downloads.setPaused({ paused: false, requestKey: randomUUID() }); await f.advance();
    const p = await f.preview(source, "execution"), accepted = await f.rules.confirm({ previewId: p.id, requestKey: randomUUID(), filesComplete: true });
    const before = (f.db.connection.prepare("SELECT plan_json FROM local_sync_operation").get() as { plan_json: string }).plan_json;
    const changed = f.save(f.rules.get(source.id), f.secondTarget.id); await f.rules.confirm({ previewId: (await f.preview(changed)).id, requestKey: randomUUID() });
    await f.rules.tick();
    expect((f.db.connection.prepare("SELECT plan_json FROM local_sync_operation").get() as { plan_json: string }).plan_json).toBe(before);
    expect(f.rules.get(source.id).snapshot?.targetDirectory.id).toBe(f.secondTarget.id); expect(f.rules.jobs({}).items.find((row) => row.id === accepted.jobId)?.state).toBe("DONE");
    expect(await readFile(join(f.target.path, "completed/原片.mp4"), "utf8")).toBe(f.content); await expect(readFile(join(f.secondTarget.path, "completed/原片.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("共享作业只复制一次；暂停一个来源不停止其他需求，恢复不解除全局暂停", async () => {
    const f = await fixture(), a = await f.enable(), b = await f.enable(); await f.advance();
    const pa = await f.preview(a, "execution"), pb = await f.preview(b, "execution");
    await f.rules.confirm({ previewId: pa.id, requestKey: randomUUID(), filesComplete: true }); await f.rules.confirm({ previewId: pb.id, requestKey: randomUUID(), filesComplete: true }); f.downloads.setPaused({ paused: true, requestKey: randomUUID() }); await f.rules.tick();
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM local_sync_operation").get()).toEqual({ n: 1 });
    const paused = await f.rules.control({ ...f.version(a), requestKey: randomUUID(), operation: "pause" });
    await f.rules.control({ ...f.version(paused), requestKey: randomUUID(), operation: "resume" }); expect(f.downloads.pauseStatus().paused).toBe(true);
    const pausedAgain = await f.rules.control({ ...f.version(f.rules.get(a.id)), requestKey: randomUUID(), operation: "pause" }); expect(pausedAgain.paused).toBe(true);
    f.downloads.setPaused({ paused: false, requestKey: randomUUID() }); await f.advance();
    expect(f.rules.get(a.id).paused).toBe(true); expect(f.rules.get(b.id).paused).toBe(false); expect(f.db.connection.prepare("SELECT count(*) AS n FROM sync_receipt").get()).toEqual({ n: 1 });
    expect(f.rules.jobs({}).items.every((job) => job.state === "DONE")).toBe(true);
  });
  it("输入与 target 重叠被阻断，非法过滤不保存；文件变化和目标抢占保留双方", async () => {
    const f = await fixture();
    expect(() => f.rules.save({ id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, expectedLifecycleRevision: 0, requestKey: randomUUID(), configuration: { type: "local", name: "非法过滤", inputDirectoryId: f.input.id, filters: [{ action: "include", pattern: "{{.*}}" }] } })).toThrow();
    const overlap = f.rules.save({ id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, expectedLifecycleRevision: 0, requestKey: randomUUID(), configuration: { type: "local", name: "循环", inputDirectoryId: f.target.id, target: { kind: "directory", directoryId: f.target.id } } }); await expect(f.preview(overlap)).rejects.toThrow(/相互包含/);
    const source = await f.enable(); await f.advance(); const p = await f.preview(source, "execution"); await writeFile(join(f.input.path, "原片.mp4"), "文件已变化");
    await expect(f.rules.confirm({ previewId: p.id, requestKey: randomUUID(), filesComplete: true })).rejects.toThrow(/已变化/);
    await writeFile(join(f.target.path, "completed/原片.mp4"), "第三方目标"); const conflict = await f.preview(source, "execution"); expect(conflict).toMatchObject({ state: "BLOCKED", conflicts: 1 });
    expect(f.rules.previewFiles({ id: conflict.id }).items[0]?.reason).toContain("不覆盖"); expect(await readFile(join(f.target.path, "completed/原片.mp4"), "utf8")).toBe("第三方目标");
  });
});
