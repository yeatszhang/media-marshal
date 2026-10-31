import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, lstat, statfs, realpath, rm, writeFile, readFile, rename, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import { sourceConfigurationSchema, syncSourceConfigurationSchema, type SyncSourceRule } from "@media-marshal/contracts";
import { legacyConfigurationFingerprint } from "../infrastructure/independent-sync-migration.js";
import { CoreDatabase } from "../infrastructure/database.js";
import { CloudRoots } from "../cloud/roots.js";
import { CloudDownloads } from "../cloud/downloads.js";
import { CloudAccounts } from "../cloud/accounts.js";
import { RemoteCatalog } from "../cloud/catalog.js";
import { unavailableHost } from "../cloud/host-gateway.js";
import { ConfigurationDirectories } from "./configuration-directories.js";
import { SourceRoot } from "../files/source-root.js";
import { libraryMediaIdentity } from "./library-media-identity.js";
import { SyncReceipts } from "./sync-receipts.js";
import { EmbyLibraryFiles } from "./emby-library-files.js";
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
  return { grant, catalog, directory, db, roots, directories, input, target, secondTarget, downloads, local, rules, content, now, version, save, preview, enable, advance };
}
async function libraryFixture(f: Awaited<ReturnType<typeof fixture>>, content = f.content) {
  const grant = await f.grant("媒体库"), connectionId = randomUUID(), logicalId = randomUUID();
  const binding = { id: randomUUID(), version: 1, targetId: logicalId, targetDirectory: { id: grant.id, version: 1, path: grant.path }, serverId: "server", connectionVersion: 1, libraryId: "movies", libraryRoot: "/media/movies", mediaType: "MOVIE", conversion: { id: randomUUID(), version: 1, localRoot: { id: randomUUID(), version: 1, path: grant.path }, serverRoot: "/media/movies", serverPathStyle: "posix" } };
  f.db.connection.prepare("INSERT INTO media_target_root VALUES(?,?,1)").run(grant.id, JSON.stringify(grant));
  f.db.connection.prepare("INSERT INTO emby_connection VALUES(?,1,'server','http://127.0.0.1',1,'测试')").run(connectionId);
  // 逻辑 target 与物理目录使用独立身份。
  f.db.connection.prepare("INSERT INTO media_target_root VALUES(?,?,1)").run(logicalId, JSON.stringify(grant));
  f.db.connection.prepare("INSERT INTO emby_library VALUES(?,'movies','/media/movies',?,?)").run(connectionId, logicalId, JSON.stringify(binding));
  await mkdir(join(grant.path, "影片")); const path = join(grant.path, "影片/原片.mp4"); await writeFile(path, content);
  return { grant, path, binding, connectionId };
}
async function cloudPreview(f: Awaited<ReturnType<typeof fixture>>, expectedState = "READY") {
    const accounts = new CloudAccounts(f.db), prepared = accounts.dispatch("cloud.authorization.begin", { name: "测试网盘", requestKey: randomUUID(), implementationId: "test.drive" });
    accounts.dispatch("cloud.authorization.finish", { jobId: prepared.job.id, failure: null, capabilities: { authorizationMethods: ["cookie"], accountIdentity: "unavailable", objectIdentity: "path", reliableRevision: false, hashAlgorithms: [], rangeRead: "unknown", sourceKinds: ["webdav"] }, identityKey: null });
    const account = f.catalog.accounts()[0]!, candidate = prepared.candidate.binding, binding = { accountId: candidate.accountId, bindingId: candidate.bindingId, generation: candidate.generation };
    const ref = randomUUID(), size = Buffer.byteLength(f.content), version = { kind: "weak" as const, size, modifiedAt: null };
    f.db.connection.prepare("INSERT INTO remote_entry(id,account_id,name,type,size,observed_at) VALUES(?,?,'原片.mp4','file',?,'测试')").run(ref, account.id, size);
    vi.spyOn(f.catalog, "source").mockReturnValue({ binding, remoteRef: ref, expectedVersion: version, locator: { kind: "path", segments: ["原片.mp4"] } });
    vi.spyOn(f.catalog, "stat").mockResolvedValue({ ref, parentRef: null, accountId: account.id, name: "原片.mp4", type: "file", size, modifiedAt: null, version });
    vi.spyOn(f.catalog, "relativePath").mockReturnValue(["原片.mp4"]);
    const source = f.rules.save({ id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, expectedLifecycleRevision: 0, requestKey: randomUUID(), configuration: { type: "cloud", name: "网盘同步", accountId: account.id, remoteRef: ref, target: { kind: "default" } } });
    let preview = await f.preview(source);
    for (let attempt = 0; preview.state === "BUILDING" && attempt < 100; attempt++) { await new Promise((resolve) => setTimeout(resolve, 5)); preview = f.rules.getPreview(preview.id); }
    expect(preview, preview.failure ?? undefined).toMatchObject({ state: expectedState }); return preview;
}
describe("同步优先检查 Emby 已有文件", () => {
  it("待执行网盘任务同时说明来源与全局暂停，逐项恢复后继续原任务", async () => {
    const f = await fixture(), preview = await cloudPreview(f);
    f.downloads.setPaused({ paused: true, requestKey: randomUUID() });
    const accepted = await f.rules.confirm({ previewId: preview.id, requestKey: randomUUID(), runOnce: true }), id = accepted.jobId!;
    await f.rules.tick();
    expect(f.rules.getJob(id)).toMatchObject({ state: "PENDING", downloadJobId: null, waitingReason: expect.stringContaining("恢复全部同步下载") });
    const paused = await f.rules.control({ ...f.version(accepted.rule), requestKey: randomUUID(), operation: "pause" });
    const waiting = f.rules.jobs({}).items.find((job) => job.id === id)!;
    expect(waiting.waitingReason).toContain("恢复来源同步"); expect(waiting.waitingReason).toContain("恢复全部同步下载");
    await f.rules.control({ ...f.version(paused), requestKey: randomUUID(), operation: "resume" });
    expect(f.rules.getJob(id).waitingReason).not.toContain("恢复来源同步");
    expect(f.rules.getJob(id).waitingReason).toContain("恢复全部同步下载");
    f.downloads.setPaused({ paused: false, requestKey: randomUUID() }); await f.rules.tick();
    expect(f.rules.getJob(id)).toMatchObject({ state: "RUNNING", waitingReason: null, downloadJobId: expect.any(String) });
    expect(f.rules.jobs({}).total).toBe(1);
    await f.rules.control({ ...f.version(f.rules.get(accepted.rule.id)), requestKey: randomUUID(), operation: "pause" });
    expect(f.rules.getJob(id).waitingReason).toContain("恢复来源同步");
  });
  it("网盘命中媒体文件时全跳过作业完成且不生成下载项；重新读取任务仍显示媒体库路径", async () => {
    const f = await fixture(), library = await libraryFixture(f), preview = await cloudPreview(f);
    expect(preview).toMatchObject({ files: 1, inLibrary: 1, download: { weakComparison: true } });
    expect(f.rules.previewFiles({ id: preview.id }).items[0]).toMatchObject({ state: "IN_LIBRARY", targetPath: library.path });
    const result = await f.rules.confirm({ previewId: preview.id, requestKey: randomUUID(), runOnce: true });
    expect(f.rules.getJob(result.jobId!)).toMatchObject({ files: 1, inLibrary: 1 });
    await f.rules.tick();
    expect(f.rules.getJob(result.jobId!)).toMatchObject({ state: "DONE", files: 1, done: 0, inLibrary: 1 });
    expect(f.rules.jobFiles({ id: result.jobId! }).items[0]).toMatchObject({ state: "IN_LIBRARY", targetPath: library.path });
    for (const table of ["download_item", "download_attempt", "sync_receipt"]) expect(f.db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(f.downloads.get(f.rules.getJob(result.jobId!).downloadJobId!)?.state).toBe("COMPLETED");
  });
  it("网盘预览后库内文件消失时持久报告失败，重新预览恢复普通下载候选", async () => {
    const f = await fixture(), library = await libraryFixture(f), preview = await cloudPreview(f);
    await rm(library.path); const result = await f.rules.confirm({ previewId: preview.id, requestKey: randomUUID(), runOnce: true }); await f.rules.tick();
    expect(f.rules.getJob(result.jobId!)).toMatchObject({ state: "NEEDS_ATTENTION", failure: expect.stringContaining("媒体库") });
    expect(f.rules.jobFiles({ id: result.jobId! }).items[0]).toMatchObject({ state: "NEEDS_ATTENTION", reason: expect.stringContaining("媒体库") });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_item").get()).toEqual({ n: 0 });
    const next = await f.preview(f.rules.get(preview.sourceId), "execution");
    let ready = f.rules.getPreview(next.id); for (let attempt = 0; ready.state === "BUILDING" && attempt < 100; attempt++) { await new Promise((resolve) => setTimeout(resolve, 5)); ready = f.rules.getPreview(next.id); }
    expect(ready).toMatchObject({ state: "READY", inLibrary: 0 }); expect(f.rules.previewFiles({ id: ready.id }).items[0]?.state).toBe("READY");
  });
  it("本地来源命中媒体库时不等待稳定、不创建复制或成功传输收据，任务保留实际媒体路径", async () => {
    const f = await fixture(), library = await libraryFixture(f), source = await f.enable();
    const preview = await f.preview(source, "execution"); expect(preview).toMatchObject({ state: "READY", inLibrary: 1, observing: 0 });
    expect(f.rules.previewFiles({ id: preview.id }).items[0]).toMatchObject({ state: "IN_LIBRARY", targetPath: library.path });
    const result = await f.rules.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true }); await f.rules.tick();
    expect(f.rules.getJob(result.jobId!)).toMatchObject({ files: 1, state: "DONE", inLibrary: 1, done: 0, reused: 0 });
    expect(f.rules.jobFiles({ id: result.jobId! }).items[0]).toMatchObject({ state: "IN_LIBRARY", targetPath: library.path, size: Buffer.byteLength(f.content) });
    for (const table of ["local_sync_operation", "sync_receipt", "download_item"]) expect(f.db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    await expect(readFile(join(f.target.path, "completed/原片.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(library.path, "utf8")).toBe(f.content);
  });
  it("命中与未命中混合时仅复制缺失文件，两个状态分别计数", async () => {
    const f = await fixture(); await libraryFixture(f); await writeFile(join(f.input.path, "新片.mp4"), "需要复制的新视频");
    const source = await f.enable(); await f.advance(); const preview = await f.preview(source, "execution");
    expect(preview).toMatchObject({ files: 2, inLibrary: 1, state: "READY" });
    const result = await f.rules.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true }); await f.rules.tick();
    expect(f.rules.getJob(result.jobId!)).toMatchObject({ files: 2, state: "DONE", inLibrary: 1, done: 1, reused: 0 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM local_sync_operation").get()).toEqual({ n: 1 });
    expect(await readFile(join(f.target.path, "completed/新片.mp4"), "utf8")).toBe("需要复制的新视频");
    await expect(readFile(join(f.target.path, "completed/原片.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("同名同大小但内容不同的本地文件继续同步；弱比较仅大小相同须核对", async () => {
    const f = await fixture(), library = await libraryFixture(f, "x".repeat(Buffer.byteLength(f.content)));
    const source = await f.enable(); expect(await f.preview(source, "execution")).toMatchObject({ inLibrary: 0, observing: 1 });
    const index = new EmbyLibraryFiles(f.db);
    await expect(index.find("其他片.mp4", Buffer.byteLength(f.content))).rejects.toThrow(/疑似重复/); expect(await index.find("原片.mp4", 1)).toBeUndefined();
    await rm(library.path); expect(await new EmbyLibraryFiles(f.db).find("原片.mp4", Buffer.byteLength(f.content))).toBeUndefined();
  });
  it.each(["删除", "替换", "关联变化", "卷离线"])("预览后%s不允许沿用已在媒体库的证据", async (action) => {
    const f = await fixture(), library = await libraryFixture(f), source = await f.enable(), preview = await f.preview(source, "execution");
    if (action === "删除") await rm(library.path);
    if (action === "替换") { await rm(library.path); await writeFile(library.path, f.content); }
    if (action === "关联变化") f.db.connection.prepare("UPDATE emby_connection SET version=version+1").run();
    if (action === "卷离线") await rename(library.grant.path, library.grant.path + "-离线");
    await expect(f.rules.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true })).rejects.toThrow(/媒体库|来源文件|原卷/);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM sync_job").get()).toEqual({ n: 0 });
  });
  it("远端提供摘要时必须一致；显式重同步仍执行", async () => {
    const f = await fixture(); await libraryFixture(f); const index = new EmbyLibraryFiles(f.db), size = Buffer.byteLength(f.content);
    expect(await index.find("原片.mp4", size, undefined, { kind: "hash", algorithm: "sha256", value: "0".repeat(64) })).toBeUndefined();
    const sha256 = createHash("sha256").update(f.content).digest("hex");
    expect(await index.find("原片.mp4", size, undefined, { kind: "hash", algorithm: "sha256", value: sha256 })).toMatchObject({ sha256 });
    const source = await f.enable(); await f.advance(); const forced = await f.preview(source, "execution", true);
    expect(forced).toMatchObject({ inLibrary: 0, force: true }); expect(f.rules.previewFiles({ id: forced.id }).items[0]?.state).toBe("READY");
  });
});
describe("独立本地单向同步、成功历史和阶段控制", () => {
  it.each(["planned", "copying", "verified", "published", "recorded"])("本地同步在 %s 真实 SIGKILL 后沿原操作恢复，不覆盖或重复成果", async (checkpoint) => {
    const f = await fixture(), source = await f.enable(); await f.advance(); const preview = await f.preview(source, "execution");
    const result = await f.rules.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true });
    const before = f.db.connection.prepare("SELECT id,plan_json FROM local_sync_operation").get() as { id: string; plan_json: string }, config = join(f.directory, "crash.json"), databasePath = join(f.directory, "core.sqlite3");
    await writeFile(config, JSON.stringify({ database: databasePath, checkpoint, input: f.input, target: f.target })); await f.rules.close(); await f.downloads.close(); await f.directories.close(); await f.roots.close(); f.db.close();
    const child = spawn(process.execPath, [resolve("tools/desktop-files/local-sync-crash-child.mjs"), config], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "", timeout: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<{ signal: string | null }>((done, fail) => { child.once("error", fail); child.once("exit", (_code, signal) => done({ signal })); }), reached = new Promise<void>((done) => child.stdout.on("data", (bytes) => { output += bytes.toString(); if (output.includes("CHECKPOINT:" + checkpoint + "\n")) done(); })); child.stderr.on("data", (bytes) => { errors = (errors + bytes.toString()).slice(-8192); });
    try { await Promise.race([reached, exited.then(() => { throw new Error("同步检查点前退出：" + errors); }), new Promise((_, fail) => { timeout = setTimeout(() => fail(new Error("同步检查点超时：" + errors)), 15000); })]); expect(child.kill("SIGKILL")).toBe(true); expect((await exited).signal).toBe("SIGKILL"); }
    finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
    const path = join(f.target.path, "completed/原片.mp4"), published = ["published", "recorded"].includes(checkpoint), inode = published ? (await lstat(path)).ino : null;
    if (["verified", "published", "recorded"].includes(checkpoint)) await rename(f.input.path, f.input.path + "-离线");
    const db = await CoreDatabase.open(databasePath, undefined, { exclusiveOwner: true }); cleanup.push(() => db.close()); const roots = new CloudRoots(db); cleanup.push(() => roots.close()); const directories = new ConfigurationDirectories(db, roots); cleanup.push(() => directories.close());
    await directories.authorize(f.target, "managed"); if (!["verified", "published", "recorded"].includes(checkpoint)) await directories.authorize(f.input, "ordinary");
    let clock = 0; const local = new LocalSync(db, directories, roots, () => Date.UTC(2026, 9, 28) + clock, () => clock); cleanup.push(() => local.close());
    for (let index = 0; index < 15; index++) { clock += 10000; await local.tick(); }
    expect(db.connection.prepare("SELECT id,plan_json,phase FROM local_sync_operation").get()).toEqual({ ...before, phase: "RECORDED" }); expect(db.connection.prepare("SELECT state FROM sync_job WHERE id=?").get(result.jobId!)).toEqual({ state: "DONE" });
    expect(db.connection.prepare("SELECT count(*) AS n FROM sync_receipt").get()).toEqual({ n: 1 }); expect(await readFile(path, "utf8")).toBe(f.content); if (inode) expect((await lstat(path)).ino).toBe(inode);
  }, 25000);
  it("识别已独立接管但旧网盘同步尚未确认时，仍可幂等暂停旧同步而不撤销识别所有权", async () => {
    const f = await fixture(), id = randomUUID(), stamp = new Date(f.now()).toISOString(), configuration = sourceConfigurationSchema.parse({ type: "cloud", name: "尚未接管的同步", accountId: randomUUID(), remoteRef: randomUUID(), downloadRootId: f.target.id }), projected = syncSourceConfigurationSchema.parse({ type: "cloud", name: configuration.name, accountId: configuration.type === "cloud" ? configuration.accountId : "", remoteRef: configuration.type === "cloud" ? configuration.remoteRef : "", target: { kind: "directory", directoryId: f.target.id } });
    const db = f.db.connection; db.prepare("INSERT INTO source_rule(id,type,version,draft_revision,lifecycle_revision,draft_json,paused,created_at,updated_at) VALUES(?,'cloud',1,1,0,?,0,?,?)").run(id, JSON.stringify(configuration), stamp, stamp); db.prepare("INSERT INTO source_rule_version(source_id,version,configuration_json,created_at) VALUES(?,1,?,?)").run(id, JSON.stringify(configuration), stamp); db.prepare("INSERT INTO legacy_configuration_owner VALUES(?,0,1)").run(id);
    db.prepare("INSERT INTO sync_source_rule(id,version,draft_revision,lifecycle_revision,draft_json,paused,review_json,created_at,updated_at) VALUES(?,1,1,0,?,0,'[\"LEGACY_SCOPE_REVIEW_REQUIRED\"]',?,?)").run(id, JSON.stringify(projected), stamp, stamp); db.prepare("INSERT INTO sync_source_version VALUES(?,1,?)").run(id, JSON.stringify({ sourceId: id, sourceVersion: 1, configuration: projected, inputDirectory: null, targetDirectory: f.directories.binding(f.target.id), defaultDirectoryVersion: null })); db.prepare("INSERT INTO sync_runtime(source_id,legacy_fingerprint) VALUES(?,?)").run(id, legacyConfigurationFingerprint(db, id));
    const input = { ...f.version(f.rules.get(id)), requestKey: randomUUID(), operation: "pause" as const }, paused = await f.rules.control(input); expect(await f.rules.control(input)).toEqual(paused); expect(paused.paused).toBe(true); expect(db.prepare("SELECT paused FROM source_rule WHERE id=?").get(id)).toEqual({ paused: 1 }); expect(db.prepare("SELECT sync_claimed,recognition_claimed FROM legacy_configuration_owner WHERE source_id=?").get(id)).toEqual({ sync_claimed: 0, recognition_claimed: 1 });
    await expect(f.rules.control({ ...f.version(paused), requestKey: randomUUID(), operation: "resume" })).rejects.toThrow(/预览确认接管/);
  });
  it("下载目录改变后编辑和新执行使用当前设置，旧预览失效", async () => {
    const f = await fixture(), source = await f.enable();
    f.directories.setDefault({ expectedVersion: 1, directoryId: f.secondTarget.id, requestKey: randomUUID() });
    const changed = f.save(source), ordinary = await f.preview(changed);
    expect(ordinary.snapshot.targetDirectory.id).toBe(f.secondTarget.id);
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

it("新同步使用当前下载目录，已受理作业和已确认预览仍保留原计划", async () => {
  const f = await fixture(), rule = await f.enable(); await f.advance();
  const original = await f.preview(rule, "execution");
  const job = await f.rules.confirm({ previewId: original.id, requestKey: randomUUID(), filesComplete: true });
  const pending = await f.preview(rule, "execution");
  f.directories.setDefault({ expectedVersion: 1, directoryId: f.secondTarget.id, requestKey: randomUUID() });
  expect(f.rules.getPreview(pending.id).state).toBe("EXPIRED");
  const next = await f.preview(rule, "execution"); expect(next.snapshot.targetDirectory.id).toBe(f.secondTarget.id);
  await f.rules.tick(); expect(f.rules.getJob(job.jobId!).state).toBe("DONE");
  expect(await readFile(join(f.target.path, "completed/原片.mp4"), "utf8")).toBe(f.content);
});


describe("删除同步任务保留文件与成功历史", () => {
  it("未停止任务不能删除，暂停后移除列表且恢复来源不会继续旧任务，重复删除幂等", async () => {
    const f = await fixture(), source = await f.enable(); await f.advance();
    const preview = await f.preview(source, "execution"), result = await f.rules.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true });
    const input = { id: result.jobId!, requestKey: randomUUID() };
    expect(() => f.rules.removeJob(input)).toThrow("请先暂停对应来源"); expect(f.rules.jobs({}).total).toBe(1);
    const paused = await f.rules.control({ ...f.version(source), operation: "pause", requestKey: randomUUID() });
    let finishTick!: () => void;
    vi.spyOn(f.local, "tick").mockReturnValueOnce(new Promise<void>((resolve) => { finishTick = resolve; }));
    const draining = f.rules.tick();
    expect(() => f.rules.removeJob(input)).toThrow("等待在途同步停止");
    finishTick(); await draining;
    expect(f.rules.removeJob(input)).toEqual({ id: result.jobId }); expect(f.rules.removeJob(input)).toEqual({ id: result.jobId });
    expect(f.rules.removeJob({ ...input, requestKey: randomUUID() })).toEqual({ id: result.jobId });
    expect(f.rules.jobs({})).toEqual({ items: [], total: 0 }); expect(f.rules.jobs({ sourceId: source.id }).total).toBe(0);
    expect(f.rules.getJob(input.id).state).toBe("CANCELED");
    await f.rules.control({ ...f.version(paused), operation: "resume", requestKey: randomUUID() }); await f.rules.tick();
    expect(f.rules.getJob(input.id).state).toBe("CANCELED");
    expect(() => f.rules.retry({ id: input.id, requestKey: randomUUID() })).toThrow("已删除");
    await expect(readFile(join(f.target.path, "completed/原片.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.input.path, "原片.mp4"), "utf8")).toBe(f.content);
  });
  it("完成任务删除后保留文件和去重收据，分页总数一致", async () => {
    const f = await fixture(), source = await f.enable(); await f.advance();
    const preview = await f.preview(source, "execution"), result = await f.rules.confirm({ previewId: preview.id, requestKey: randomUUID(), filesComplete: true }); await f.rules.tick();
    expect(f.rules.getJob(result.jobId!).state).toBe("DONE");
    f.rules.removeJob({ id: result.jobId!, requestKey: randomUUID() });
    expect(f.rules.jobs({ page: 1, pageSize: 1 })).toEqual({ items: [], total: 0 });
    expect(await readFile(join(f.target.path, "completed/原片.mp4"), "utf8")).toBe(f.content);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM sync_receipt").get()).toEqual({ n: 1 });
    const next = await f.preview(source, "execution"); expect(next.reused).toBe(1);
    expect(f.rules.jobFiles({ id: result.jobId! }).total).toBe(1);
  });
});


describe("改名视频的证据比较与会话成本", () => {
  it("22 个真实大小的改名视频全部弱命中，不全读视频，附属文件独立", async () => {
    const f = await fixture(), library = await libraryFixture(f); await rm(library.path);
    const groups = [
      { title: "喜鹊谋杀案 (2022)", id: "130766", ext: "mkv", sizes: [3089077793,2939657051,2793337122,2927107496,3108339946,2661929243] },
      { title: "猫头鹰谋杀案 (2024)", id: "241548", ext: "mp4", sizes: [5075701444,5182181063,5245158756,5082064527,5340880841,5287502372] },
      { title: "翠鸟谋杀案 (2026)", id: "283319", ext: "mp4", sizes: [2159612358,2038069916,2100821064,1005846347,990595961,1098595542] },
      { title: "翠鸟谋杀案 (2026)", id: "283319", ext: "mkv", sizes: [3940623422,3844999465,3718652682,3590012781] },
    ];
    for (const group of groups) {
      const root = join(library.grant.path, `${group.title} [tmdbid=${group.id}]`, "Season 01"); await mkdir(root, { recursive: true });
      for (const [index, size] of group.sizes.entries()) { const path = join(root, `${group.title} - S01E${String(index + 1).padStart(2, "0")} - 1080p.${group.ext}`); await writeFile(path, ""); await truncate(path, size); }
    }
    const read = vi.spyOn(SourceRoot.prototype, "digest"), discover = vi.spyOn(SourceRoot.prototype, "discover"), libraryIndex = new EmbyLibraryFiles(f.db); let count = 0, bytes = 0;
    for (const group of groups) for (const [index, size] of group.sizes.entries()) {
      const name = `English Title S01E${String(index + 1).padStart(2, "0")} - 第 ${index + 1} 集 - WEB-DL.${group.ext}`;
      const proof = await libraryIndex.find(name, size, undefined, { kind: "weak", size, modifiedAt: null }, ["视频电影", "X 喜鹊+猫头鹰+翠鸟谋杀案", group.title, "第 1 季 - WEB-DL", name]);
      expect(proof).toMatchObject({ comparison: "MEDIA_SIZE", sha256: null, identity: { title: group.title.split(" (")[0], season: 1, episode: String(index + 1) } });
      await libraryIndex.verify(proof!); count++; bytes += size;
    }
    expect(count).toBe(22); expect(bytes).toBe(73220767192); expect(read).not.toHaveBeenCalled(); expect(discover).toHaveBeenCalledTimes(1);
    expect(await libraryIndex.find("English Title S01E01.nfo", 1788)).toBeUndefined();
    expect(await libraryIndex.find("English Title S01E01.jpg", 133324)).toBeUndefined();
  });
  it.each(["sha256", "sha1", "md5"] as const)("改名视频按 %s 强比较，重复调用只读一次", async (algorithm) => {
    const f = await fixture(), library = await libraryFixture(f), size = Buffer.byteLength(f.content), digest = createHash(algorithm).update(f.content).digest("hex");
    const read = vi.spyOn(SourceRoot.prototype, "digest"), index = new EmbyLibraryFiles(f.db);
    const proofs = await Promise.all([1,2].map(() => index.find("改名文件.mkv", size, undefined, { kind: "hash", algorithm, value: digest })));
    expect(proofs[0]).toMatchObject({ comparison: "CONTENT", algorithm, digest, segments: ["影片", "原片.mp4"] }); expect(read).toHaveBeenCalledTimes(1);
    await new EmbyLibraryFiles(f.db).verify(proofs[0]!); expect(read).toHaveBeenCalledTimes(2);
    expect(await index.find("改名.mp4", size, undefined, { kind: "hash", algorithm, value: "0".repeat(digest.length) })).toBeUndefined();
    expect(await readFile(library.path, "utf8")).toBe(f.content);
  });
  it("本地来源文件改名仍按内容命中", async () => {
    const f = await fixture(), library = await libraryFixture(f); await rename(library.path, join(library.grant.path, "影片/另一个名字.mkv"));
    const source = await f.enable(), preview = await f.preview(source, "execution"); expect(preview).toMatchObject({ inLibrary: 1, observing: 0 });
    expect(f.rules.previewFiles({ id: preview.id }).items[0]?.reason).toContain("SHA256 内容摘要一致");
  });
  it("相同大小的弱候选身份矛盾或多路径不取第一个", async () => {
    const f = await fixture(), library = await libraryFixture(f), size = Buffer.byteLength(f.content), name = "Moonflower Murders S01E04.mp4";
    const folder = join(library.grant.path, "猫头鹰谋杀案 (2024) [tmdbid=241548]", "Season 01"); await mkdir(folder, { recursive: true });
    const first = join(folder, "猫头鹰谋杀案 (2024) - S01E04 - 2160p.mp4"); await writeFile(first, f.content);
    await expect(new EmbyLibraryFiles(f.db).find(name, size, undefined, undefined, ["猫头鹰谋杀案 (2024)", "第 2 季", name])).rejects.toThrow(/疑似重复/);
    await writeFile(join(folder, "猫头鹰谋杀案 (2024) - S01E04 - 1080p.mp4"), f.content);
    await expect(new EmbyLibraryFiles(f.db).find(name, size, undefined, undefined, ["猫头鹰谋杀案 (2024)", name])).rejects.toThrow(/无法唯一对应/);
    await expect(new EmbyLibraryFiles(f.db).find(name, size, undefined, undefined, ["猫头鹰谋杀案 (2024) [tmdbid=999]", name])).rejects.toThrow(/疑似重复/);
  });
  it("解析矛盾的季集、作品和年份不产生明确身份", () => {
    expect(libraryMediaIdentity(["作品 (2024)", "Season 02", "作品 (2024) - S01E01.mp4"]).conflict).toBe(true);
    expect(libraryMediaIdentity(["作品 (2024)", "另一作品 (2025) - S01E01.mp4"]).conflict).toBe(true);
    expect(libraryMediaIdentity(["作品 (2024)", "S01E01-E02.mp4"])).toMatchObject({ episode: "1-2", season: 1, conflict: false });
  });
  it("关联目录失联或扫描不完整时阻断并持久展示原因", async () => {
    const f = await fixture(), library = await libraryFixture(f), source = await f.enable(); await rename(library.grant.path, library.grant.path + "-离线");
    const preview = await f.preview(source, "execution"); expect(preview).toMatchObject({ state: "BLOCKED", conflicts: 1 });
    expect(f.rules.previewFiles({ id: preview.id }).items[0]).toMatchObject({ state: "UNAVAILABLE", reason: expect.stringContaining("媒体库检查未完成") });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_item").get()).toEqual({ n: 0 });
  });
  it("摘要读取期间取消不会保存命中证据", async () => {
    const f = await fixture(); await libraryFixture(f); const controller = new AbortController(), size = Buffer.byteLength(f.content);
    const digest = SourceRoot.prototype.digest;
    vi.spyOn(SourceRoot.prototype, "digest").mockImplementationOnce(async function (this: SourceRoot, handle, expectedSize, signal, consume) { controller.abort(); return digest.call(this, handle, expectedSize, signal, consume); });
    await expect(new EmbyLibraryFiles(f.db, controller.signal).find("改名.mp4", size, undefined, { kind: "hash", algorithm: "sha256", value: createHash("sha256").update(f.content).digest("hex") })).rejects.toThrow(/中断/);
  });
  it("扫描超限和取消不能解释成无候选", async () => {
    const f = await fixture(); await libraryFixture(f);
    vi.spyOn(SourceRoot.prototype, "discover").mockRejectedValueOnce(new Error("超过一万项"));
    await expect(new EmbyLibraryFiles(f.db).find("原片.mp4", Buffer.byteLength(f.content))).rejects.toThrow(/媒体库检查未完成/);
    const controller = new AbortController(), index = new EmbyLibraryFiles(f.db, controller.signal); controller.abort();
    await expect(index.find("原片.mp4", Buffer.byteLength(f.content))).rejects.toThrow(/核对已中断/);
  });
});


describe("原网盘同步任务重新核对媒体库", () => {
  async function queued() {
    const f = await fixture(), preview = await cloudPreview(f), accepted = await f.rules.confirm({ previewId: preview.id, requestKey: randomUUID(), runOnce: true }); await f.rules.tick();
    const jobId = accepted.jobId!, downloadJobId = f.rules.getJob(jobId).downloadJobId!;
    return { ...f, jobId, downloadJobId, source: accepted.rule, cloudPreviewSnapshot: preview };
  }
  it("必须暂停，受理后阻止恢复和删除，后台命中仅撤销原需求且重放幂等", async () => {
    const f = await queued(), input = { id: f.jobId, requestKey: randomUUID() };
    expect(() => f.rules.recheckLibrary(input)).toThrow(/先暂停对应来源/);
    const paused = await f.rules.control({ ...f.version(f.source), requestKey: randomUUID(), operation: "pause" });
    const library = await libraryFixture(f);
    expect(f.rules.recheckLibrary(input)).toMatchObject({ libraryRecheck: { state: "PENDING" } });
    await expect(f.rules.control({ ...f.version(paused), requestKey: randomUUID(), operation: "resume" })).rejects.toThrow(/正在重新核对/);
    expect(() => f.rules.removeJob({ id: f.jobId, requestKey: randomUUID() })).toThrow(/正在重新核对/);
    expect(() => f.rules.retry({ id: f.jobId, requestKey: randomUUID() })).toThrow(/正在重新核对/);
    await f.rules.tick();
    expect(f.rules.getJob(f.jobId)).toMatchObject({ state: "DONE", inLibrary: 1, libraryRecheck: { state: "DONE", checked: 1, matched: 1, skippedBytes: Buffer.byteLength(f.content) } });
    expect(f.rules.get(f.source.id).paused).toBe(true);
    expect(f.rules.jobFiles({ id: f.jobId }).items[0]).toMatchObject({ state: "IN_LIBRARY", targetPath: library.path, reason: expect.stringContaining("弱比较") });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job_item WHERE job_id=?").get(f.downloadJobId)).toEqual({ n: 0 });
    expect(f.db.connection.prepare("SELECT state FROM download_item").get()).toEqual({ state: "CANCELLED" });
    expect(f.rules.recheckLibrary(input)).toMatchObject({ libraryRecheck: { state: "DONE" } });
    await f.rules.control({ ...f.version(f.rules.get(f.source.id)), requestKey: randomUUID(), operation: "resume" }); await f.rules.tick();
    expect(f.rules.getJob(f.jobId).state).toBe("DONE"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM sync_receipt").get()).toEqual({ n: 0 });
  });
  it("共享需求仍存在时保留另一个作业与物理下载", async () => {
    const f = await queued(), secondDraft = f.rules.save({ id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, expectedLifecycleRevision: 0, requestKey: randomUUID(), configuration: { ...f.source.draft, name: "另一共享来源" } }), secondPreview = await f.preview(secondDraft);
    let ready = f.rules.getPreview(secondPreview.id); for (let i = 0; ready.state === "BUILDING" && i < 100; i++) { await new Promise((done) => setTimeout(done, 5)); ready = f.rules.getPreview(ready.id); }
    const second = await f.rules.confirm({ previewId: ready.id, requestKey: randomUUID(), runOnce: true }); await f.rules.tick();
    const secondDownloadId = f.rules.getJob(second.jobId!).downloadJobId!;
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_item").get()).toEqual({ n: 1 });
    await f.rules.control({ ...f.version(f.rules.get(f.source.id)), requestKey: randomUUID(), operation: "pause" });
    await libraryFixture(f); f.rules.recheckLibrary({ id: f.jobId, requestKey: randomUUID() }); await f.rules.tick();
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job_item WHERE job_id=?").get(secondDownloadId)).toEqual({ n: 1 });
    expect(f.db.connection.prepare("SELECT state FROM download_item").get()).toEqual({ state: "QUEUED" });
    expect(f.rules.get(second.rule.id).paused).toBe(false);
    expect(f.rules.jobFiles({ id: second.jobId! }).items[0]?.state).toBe("PENDING");
  });
  it("扫描失败、疑似重复或事务失败不部分撤销需求，失败原因持久可查", async () => {
    const f = await queued(), library = await libraryFixture(f); await rename(library.path, join(library.grant.path, "影片/不明作品.mp4"));
    await f.rules.control({ ...f.version(f.source), requestKey: randomUUID(), operation: "pause" });
    f.rules.recheckLibrary({ id: f.jobId, requestKey: randomUUID() }); await f.rules.tick();
    expect(f.rules.getJob(f.jobId)).toMatchObject({ inLibrary: 0, libraryRecheck: { state: "FAILED", matched: 0, failure: expect.stringContaining("疑似重复") } });
    expect(f.rules.jobFiles({ id: f.jobId }).items[0]).toMatchObject({ state: "NEEDS_ATTENTION", reason: expect.stringContaining("疑似重复") });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job_item WHERE job_id=?").get(f.downloadJobId)).toEqual({ n: 1 });
    await rename(join(library.grant.path, "影片/不明作品.mp4"), library.path);
    f.db.connection.exec("CREATE TRIGGER recheck_fault BEFORE DELETE ON download_job_item BEGIN SELECT RAISE(ABORT,'复核事务注入失败'); END");
    f.rules.recheckLibrary({ id: f.jobId, requestKey: randomUUID() }); await f.rules.tick();
    expect(f.rules.getJob(f.jobId)).toMatchObject({ inLibrary: 0, libraryRecheck: { state: "FAILED" } });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job_item WHERE job_id=?").get(f.downloadJobId)).toEqual({ n: 1 });
    f.db.connection.exec("DROP TRIGGER recheck_fault");
    f.rules.recheckLibrary({ id: f.jobId, requestKey: randomUUID() }); await f.rules.tick(); expect(f.rules.getJob(f.jobId)).toMatchObject({ inLibrary: 1, libraryRecheck: { state: "DONE" } });
  });
  it("部分文件已完成时只跳过未完成视频，真实成功收据与文件保留", async () => {
    const f = await queued(), cloud = f.downloads.previews.row((f.db.connection.prepare("SELECT preview_id FROM sync_job WHERE id=?").get(f.jobId) as { preview_id: string }).preview_id)!;
    const snapshot = JSON.parse(cloud.snapshot_json), accountId = snapshot.binding.accountId, ref = randomUUID(), itemId = randomUUID(), root = f.roots.files.get(f.target.id);
    const bytes = Buffer.from("已有真实完成成果与收据"), segments = ["已经完成.mp4"], version = { kind: "weak", size: bytes.length, modifiedAt: null }, versionKey = createHash("sha256").update(JSON.stringify(version)).digest("hex"), slot = root.slotKey(segments), attempt = randomUUID();
    const stage = await root.prepareStage(attempt); await writeFile(join(stage, segments[0]!), bytes); const evidence = await root.verifyStage(attempt, segments, bytes.length); await root.commit(attempt, segments, evidence);
    f.db.connection.prepare("INSERT INTO remote_entry(id,account_id,name,type,size,observed_at) VALUES(?,?,?,'file',?,'测试')").run(ref, accountId, segments[0], bytes.length);
    f.db.connection.prepare("INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,target_root_id,target_path_key,target_segments_json,expected_size,state,local_sha256,completed_size,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'COMPLETED',?,?,?,?)").run(itemId, accountId, ref, versionKey, JSON.stringify(version), f.target.id, slot, JSON.stringify(segments), bytes.length, evidence.sha256, bytes.length, "测试", "测试");
    f.db.connection.prepare("INSERT INTO download_item_runtime(item_id) VALUES(?)").run(itemId); f.db.connection.prepare("INSERT INTO download_job_item VALUES(?,?,?,'ACTIVE')").run(f.downloadJobId, itemId, accountId);
    const receipt = new SyncReceipts(f.db).recordDownload(itemId, evidence);
    snapshot.items.push({ ...snapshot.items[0], itemId, targetSegments: segments, targetPathKey: slot, expectedSize: bytes.length, versionKey, source: { binding: snapshot.binding, remoteRef: ref, locator: { kind: "path", segments }, expectedVersion: version } });
    f.db.connection.prepare("UPDATE cloud_preview SET snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), cloud.id);
    await f.rules.control({ ...f.version(f.source), requestKey: randomUUID(), operation: "pause" }); await libraryFixture(f);
    f.rules.recheckLibrary({ id: f.jobId, requestKey: randomUUID() }); await f.rules.tick();
    expect(f.rules.getJob(f.jobId)).toMatchObject({ state: "DONE", done: 1, inLibrary: 1, libraryRecheck: { state: "DONE", matched: 1 } });
    expect(f.rules.jobFiles({ id: f.jobId }).items.map((file) => file.state)).toEqual(["IN_LIBRARY", "DONE"]);
    expect(new SyncReceipts(f.db).get(receipt.id)).toEqual(receipt); expect(await readFile(join(f.target.path, "completed", segments[0]!))).toEqual(bytes);
    expect(f.db.connection.prepare("SELECT item_id FROM download_job_item WHERE job_id=?").all(f.downloadJobId)).toEqual([{ item_id: itemId }]);
  });
  it("已完成文件保留成功事实，显式重同步拒绝普通复核", async () => {
    const f = await queued();
    f.db.connection.prepare("UPDATE download_item SET state='COMPLETED',local_sha256=?,completed_size=expected_size").run(createHash("sha256").update(f.content).digest("hex"));
    await f.rules.control({ ...f.version(f.source), requestKey: randomUUID(), operation: "pause" });
    expect(() => f.rules.recheckLibrary({ id: f.jobId, requestKey: randomUUID() })).toThrow(/安全点/);
    const cloud = f.downloads.previews.row((f.db.connection.prepare("SELECT preview_id FROM sync_job WHERE id=?").get(f.jobId) as { preview_id: string }).preview_id)!;
    const snapshot = JSON.parse(cloud.snapshot_json); snapshot.variant = "force:test"; f.db.connection.prepare("UPDATE cloud_preview SET snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), cloud.id);
    expect(() => f.rules.recheckLibrary({ id: f.jobId, requestKey: randomUUID() })).toThrow(/显式重新同步/);
    expect(f.db.connection.prepare("SELECT state,local_sha256 FROM download_item").get()).toMatchObject({ state: "COMPLETED", local_sha256: expect.any(String) });
  });
  it("重启恢复持久受理的复核，不依赖页面和新请求", async () => {
    const f = await queued(); await f.rules.control({ ...f.version(f.source), requestKey: randomUUID(), operation: "pause" }); await libraryFixture(f);
    f.rules.recheckLibrary({ id: f.jobId, requestKey: randomUUID() });
    const reopenedLocal = new LocalSync(f.db, f.directories, f.roots, f.now), reopened = new SyncRules(f.db, f.directories, f.downloads, reopenedLocal, f.now); cleanup.push(() => reopened.close());
    await reopened.tick(); expect(reopened.getJob(f.jobId)).toMatchObject({ inLibrary: 1, libraryRecheck: { state: "DONE", matched: 1 } });
    await reopened.tick(); expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job_item WHERE job_id=?").get(f.downloadJobId)).toEqual({ n: 0 });
  });
});


describe("简写季目录与无年份片名", () => {
  it("小城日常 S1 数字命名的 13 集全部按精确大小匹配，弱比较不读视频", async () => {
    const f = await fixture(), library = await libraryFixture(f); await rm(library.path);
    const folder = join(library.grant.path, "小城日常 (2025) [tmdbid=272118]", "Season 01"); await mkdir(folder, { recursive: true });
    const sizes = [873414405,878799414,886739090,872005132,919413685,904594356,854016845,831368542,886737425,902613525,934170512,934191261,840362124];
    for (const [i, size] of sizes.entries()) { const path = join(folder, `小城日常 (2025) - S01E${String(i + 1).padStart(2, "0")}.mp4`); await writeFile(path, ""); await truncate(path, size); }
    const index = new EmbyLibraryFiles(f.db), read = vi.spyOn(SourceRoot.prototype, "digest");
    for (const [i, size] of sizes.entries()) { const name = String(i + 1).padStart(2, "0") + ".mp4"; expect(await index.find(name, size, undefined, undefined, ["视频电影", "小城日常", "S1", name])).toMatchObject({ comparison: "MEDIA_SIZE", identity: { title: "小城日常", year: 2025, season: 1, episode: String(i + 1) } }); }
    expect(read).not.toHaveBeenCalled();
  });
  it("同名不同年份作品在不同大小桶中仍然要求核对", async () => {
    const f = await fixture(), library = await libraryFixture(f); await rm(library.path); const size = Buffer.byteLength(f.content);
    for (const year of [2024,2025]) { const folder = join(library.grant.path, `同名作品 (${year})`, "Season 01"); await mkdir(folder, { recursive: true }); await writeFile(join(folder, `同名作品 (${year}) - S01E01.mp4`), year === 2024 ? f.content : f.content + "另一个版本"); }
    await expect(new EmbyLibraryFiles(f.db).find("01.mp4", size, undefined, undefined, ["视频", "同名作品", "S1", "01.mp4"])).rejects.toThrow(/疑似重复/);
  });
  it("数字名必须有明确季目录，矛盾的季集仍保留冲突", () => {
    expect(libraryMediaIdentity(["视频", "小城日常", "S1", "12.mp4"])).toMatchObject({ title: "小城日常", season: 1, episode: "12", conflict: false });
    expect(libraryMediaIdentity(["视频", "小城日常", "12.mp4"]).episode).toBeUndefined();
    expect(libraryMediaIdentity(["作品", "S2", "S01E12.mp4"]).conflict).toBe(true);
  });
});


describe("疑似重复的逐项人工核对", () => {
  async function reviewFixture() {
    const f = await fixture(), library = await libraryFixture(f); await rename(library.path, join(library.grant.path, "影片/候选视频.mp4"));
    const preview = await cloudPreview(f, "BLOCKED"), file = f.rules.previewFiles({ id: preview.id }).items[0]!;
    expect(preview).toMatchObject({ conflicts: 0, libraryReviews: 1 }); expect(file.state).toBe("LIBRARY_REVIEW"); expect(file.libraryReview?.candidates).toHaveLength(1);
    return { ...f, library, preview, file, candidate: file.libraryReview!.candidates[0]! };
  }
  it("用户选择候选跳过可解除阻断、持久复用、执行前仍核验；不创建下载", async () => {
    const f = await reviewFixture(), input = { previewId: f.preview.id, relativePath: f.file.relativePath, decision: "USE_LIBRARY" as const, candidateId: f.candidate.id, requestKey: randomUUID() };
    const output = await f.rules.resolveLibraryReview(input); expect(output).toMatchObject({ state: "READY", libraryReviews: 0, inLibrary: 1 });
    expect(await f.rules.resolveLibraryReview(input)).toEqual(output);
    expect(f.rules.previewFiles({ id: f.preview.id }).items[0]).toMatchObject({ state: "IN_LIBRARY", targetPath: f.candidate.path, reason: expect.stringContaining("用户核对") });
    expect(JSON.stringify(f.file.libraryReview)).not.toContain("grant");
    const result = await f.rules.confirm({ previewId: f.preview.id, requestKey: randomUUID(), runOnce: true }); await f.rules.tick(); expect(f.rules.getJob(result.jobId!)).toMatchObject({ state: "DONE", inLibrary: 1 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_item").get()).toEqual({ n: 0 });
  });
  it("选择仍需同步只解除本次疑似匹配，必须再次确认才创建任务", async () => {
    const f = await reviewFixture();
    const result = await f.rules.resolveLibraryReview({ previewId: f.preview.id, relativePath: f.file.relativePath, decision: "DOWNLOAD", requestKey: randomUUID() });
    expect(result).toMatchObject({ state: "READY", libraryReviews: 0, inLibrary: 0 }); expect(f.rules.previewFiles({ id: f.preview.id }).items[0]?.state).toBe("READY");
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get()).toEqual({ n: 0 }); expect(await readFile(f.candidate.path, "utf8")).toBe(f.content);
  });
  it("伪造候选、过期与配置变化不允许沿用决定", async () => {
    const f = await reviewFixture(), base = { previewId: f.preview.id, relativePath: f.file.relativePath, decision: "USE_LIBRARY" as const, candidateId: f.candidate.id };
    await expect(f.rules.resolveLibraryReview({ ...base, candidateId: "f".repeat(64), requestKey: randomUUID() })).rejects.toThrow(/候选不属于/);
    expect(f.rules.getPreview(f.preview.id).libraryReviews).toBe(1);
    f.db.connection.prepare("UPDATE sync_configuration_preview SET expires_at=0 WHERE id=?").run(f.preview.id);
    await expect(f.rules.resolveLibraryReview({ ...base, requestKey: randomUUID() })).rejects.toThrow(/过期/);
  });
  it("候选替换后拒绝人工跳过，仍保存原待核对条目", async () => {
    const f = await reviewFixture(); await rm(f.candidate.path); await writeFile(f.candidate.path, f.content);
    await expect(f.rules.resolveLibraryReview({ previewId: f.preview.id, relativePath: f.file.relativePath, decision: "USE_LIBRARY", candidateId: f.candidate.id, requestKey: randomUUID() })).rejects.toThrow(/已变化/);
    expect(f.rules.getPreview(f.preview.id).libraryReviews).toBe(1);
  });
  it("授权代际及来源配置改变后拒绝旧核对决定", async () => {
    const f = await reviewFixture(), input = { previewId: f.preview.id, relativePath: f.file.relativePath, decision: "DOWNLOAD" as const, requestKey: randomUUID() };
    f.db.connection.prepare("UPDATE provider_binding SET generation=? WHERE state='ACTIVE'").run(randomUUID());
    await expect(f.rules.resolveLibraryReview(input)).rejects.toThrow(/授权已变化/);
    const row = f.rules.get(f.preview.sourceId); f.rules.save({ ...f.version(row), requestKey: randomUUID(), configuration: { ...row.draft, name: "配置已修改" } });
    await expect(f.rules.resolveLibraryReview({ ...input, requestKey: randomUUID() })).rejects.toThrow(/过期/);
  });
  it("仍需同步保留期间新增的真实成功收据，之后预览不重复要求核对", async () => {
    const f = await reviewFixture(), corePreview = f.db.connection.prepare("SELECT download_preview_id FROM sync_configuration_preview WHERE id=?").get(f.preview.id) as { download_preview_id: string };
    const raw = JSON.parse(f.downloads.previews.row(corePreview.download_preview_id)!.snapshot_json), file = raw.items[0], root = f.roots.files.get(f.target.id), attempt = randomUUID(), itemId = randomUUID();
    const stage = await root.prepareStage(attempt); await writeFile(join(stage, "原片.mp4"), f.content); const evidence = await root.verifyStage(attempt, ["原片.mp4"], Buffer.byteLength(f.content)); await root.commit(attempt, ["原片.mp4"], evidence);
    f.db.connection.prepare("INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,target_root_id,target_path_key,target_segments_json,expected_size,state,local_sha256,completed_size,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'COMPLETED',?,?,?,?)").run(itemId, raw.binding.accountId, file.source.remoteRef, file.versionKey, JSON.stringify(file.source.expectedVersion), f.target.id, file.targetPathKey, JSON.stringify(file.targetSegments), evidence.size, evidence.sha256, evidence.size, "测试", "测试");
    const receipt = new SyncReceipts(f.db).recordDownload(itemId, evidence);
    const result = await f.rules.resolveLibraryReview({ previewId: f.preview.id, relativePath: f.file.relativePath, decision: "DOWNLOAD", requestKey: randomUUID() });
    expect(result).toMatchObject({ state: "READY", reused: 1, libraryReviews: 0 }); expect(f.rules.previewFiles({ id: f.preview.id }).items[0]?.state).toBe("REUSED"); expect(new SyncReceipts(f.db).get(receipt.id)).toEqual(receipt);
    let next = await f.rules.preview({ ...f.version(f.rules.get(f.preview.sourceId)), requestKey: randomUUID(), mode: "configuration" }); for (let i = 0; next.state === "BUILDING" && i < 100; i++) { await new Promise((done) => setTimeout(done, 5)); next = f.rules.getPreview(next.id); }
    expect(next).toMatchObject({ state: "READY", reused: 1, libraryReviews: 0 });
  });
  it("仍需同步不能覆盖已占用的下载目标", async () => {
    const f = await reviewFixture(); await writeFile(join(f.target.path, "completed/原片.mp4"), "已存在的其他内容");
    const result = await f.rules.resolveLibraryReview({ previewId: f.preview.id, relativePath: f.file.relativePath, decision: "DOWNLOAD", requestKey: randomUUID() });
    expect(result).toMatchObject({ state: "BLOCKED", libraryReviews: 0, conflicts: 1 }); expect(f.rules.previewFiles({ id: f.preview.id }).items[0]?.state).toBe("CONFLICT");
    expect(await readFile(join(f.target.path, "completed/原片.mp4"), "utf8")).toBe("已存在的其他内容");
  });
  it("仍需同步不能绕过空间预算，失败后保留待核对状态", async () => {
    const f = await reviewFixture(); vi.spyOn(f.roots, "budget").mockRejectedValueOnce(new Error("隔离磁盘空间不足"));
    await expect(f.rules.resolveLibraryReview({ previewId: f.preview.id, relativePath: f.file.relativePath, decision: "DOWNLOAD", requestKey: randomUUID() })).rejects.toThrow(/空间不足/);
    expect(f.rules.getPreview(f.preview.id).libraryReviews).toBe(1);
  });
});
