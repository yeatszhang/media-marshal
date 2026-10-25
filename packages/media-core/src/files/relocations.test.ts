import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, lstat, statfs, realpath, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import { CoreDatabase } from "../infrastructure/database";
import { ManagedRoots } from "./index";
import { FileRelocations } from "./relocations";
import { SourceRoot } from "./source-root";
import { loadNativeRename, type NativeRenameApi } from "./native-rename";

const run = promisify(execFile), cleanup: (() => unknown | Promise<unknown>)[] = [];
let work: string, native: NativeRenameApi, nativeLaunch: { manifestPath: string; manifestSha256: string };
describe.skipIf(process.platform !== "darwin")("持久修正文件步骤（真实 SQLite 与隔离媒体目标）", () => {
  beforeAll(async () => {
    work = await realpath(await mkdtemp(join(tmpdir(), "marshal-relocations-")));
    await run(process.execPath, [resolve("tools/desktop-files/build.mjs"), "--out", join(work, "native")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000 });
    const manifestPath = join(work, "native/manifest.json"); nativeLaunch = { manifestPath, manifestSha256: createHash("sha256").update(await readFile(manifestPath)).digest("hex") }; native = await loadNativeRename(nativeLaunch);
    await run(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "packages/media-core/tsconfig.json"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000 });
  }, 40000);
  afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
  afterAll(async () => { if (work) await rm(work, { recursive: true, force: true }); });
  async function fixture(copy = false, api = native, bytes = Buffer.from("原媒体目标内容")) {
    const path = await mkdtemp(join(work, "case-")), fromPath = join(path, "原媒体库"), toPath = join(path, "新媒体库"); await mkdir(fromPath); await mkdir(toPath);
    const db = await CoreDatabase.open(join(path, "core.sqlite3")); cleanup.push(() => db.close()); const roots = new ManagedRoots("direct"); cleanup.push(() => roots.close());
    async function grant(path: string, volumeId: string): Promise<ManagedRootGrant> { const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true }); return { id: randomUUID(), path, volume: { volumeId, rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "isolated-test", caseSensitive: false, unicodeEquivalent: true, pathMaxBytes: 4096 } }; }
    // COPY 分支由已授权的卷身份决定；此组使用同一隔离文件系统，不充当实际跨卷验收。
    const volume = randomUUID(), fromGrant = await grant(fromPath, volume), toGrant = await grant(toPath, copy ? randomUUID() : volume);
    for (const grant of [fromGrant, toGrant]) { db.connection.prepare("INSERT INTO media_target_root(id,grant_json) VALUES(?,?)").run(grant.id, JSON.stringify(grant)); await roots.install(grant); }
    const item = () => { const source = randomUUID(), task = randomUUID(), job = randomUUID(), id = randomUUID(), stamp = new Date().toISOString(); db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'旧来源','custom',?,?,'AUTO','COPY',?)").run(source, join(path, source), fromPath, stamp); db.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,target_path,created_at,updated_at) VALUES(?,?,?,'DONE',?,?,?)").run(task, source, join(path, source, "下载原件.mkv"), join(fromPath, "原视频.mkv"), stamp, stamp); db.connection.prepare("INSERT INTO desktop_job VALUES(?,'correction','RUNNING','{}',?)").run(job, stamp); db.connection.prepare("INSERT INTO correction_item VALUES(?,?,?,'PENDING','{}')").run(id, job, task); return id; };
    const itemId = item(), original = ["原视频.mkv"], target = ["修正作品", "修正视频.mkv"]; await writeFile(join(fromPath, ...original), bytes); await writeFile(join(path, "下载原件.mkv"), bytes);
    const expected = (await roots.get(fromGrant.id).inspectForRelocation(original)).evidence, engine = new FileRelocations(db, roots, api); cleanup.push(() => engine.close());
    const input = { id: randomUUID(), itemId, ordinal: 0, from: { grant: fromGrant, segments: original }, to: { grant: toGrant, segments: target }, expected };
    return { path, fromPath, toPath, fromGrant, toGrant, db, roots, engine, input, expected, bytes, item };
  }
  it("规划重复申请幂等、计划不可变，活动位置同时阻止来源／目标交叉占用及目录前缀碰撞", async () => {
    const f = await fixture(), first = f.engine.plan(f.input); expect(f.engine.plan(f.input)).toEqual(first); expect(await readFile(join(f.fromPath, "原视频.mkv"))).toEqual(f.bytes); await expect(lstat(join(f.toPath, ...f.input.to.segments))).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => f.engine.plan({ ...f.input, to: { ...f.input.to, segments: ["另一个目标.mkv"] } })).toThrow(); expect(() => f.db.connection.prepare("UPDATE media_file_relocation SET plan_json='{}' WHERE id=?").run(first.id)).toThrow("不可变");
    const itemId = f.item(); for (const parts of [f.input.to.segments, ["修正作品"], ["修正作品", "修正视频.mkv", "子文件.mkv"]]) expect(() => f.engine.plan({ ...f.input, id: randomUUID(), itemId, from: { ...f.input.to, segments: parts }, to: { ...f.input.to, segments: ["其他.mkv"] }, expected: { ...f.expected, volumeId: f.toGrant.volume.volumeId } })).toThrow("占用");
  });
  it("同卷隔离后独占改名，重复执行复用原步骤，文件 DONE 仍不释放位置或自动改任务历史", async () => {
    const f = await fixture(), row = f.engine.plan(f.input), a = f.engine.run(row.id), b = f.engine.run(row.id); expect(a).toBe(b); expect(await a).toMatchObject({ phase: "DONE", recorded: 0 });
    const result = await f.roots.get(f.toGrant.id).inspectForRelocation(f.input.to.segments); expect(result.evidence).toEqual(f.expected); await expect(lstat(join(f.fromPath, "原视频.mkv"))).rejects.toMatchObject({ code: "ENOENT" }); expect(await f.engine.run(row.id)).toMatchObject({ phase: "DONE" });
    expect(await readFile(join(f.path, "下载原件.mkv"))).toEqual(f.bytes); expect(f.db.connection.prepare("SELECT status FROM media_task").get()).toEqual({ status: "DONE" }); expect(() => f.engine.releaseRecorded(f.input.itemId)).toThrow();
    expect(() => f.engine.plan({ ...f.input, id: randomUUID(), itemId: f.item(), from: f.input.to, to: { ...f.input.to, segments: ["第三位置.mkv"] } })).toThrow("占用");
  });
  it("目标抢占时保留两个文件，修复后只沿原步骤重试", async () => {
    const f = await fixture(); await mkdir(join(f.toPath, "修正作品")); await writeFile(join(f.toPath, ...f.input.to.segments), "外部文件不能覆盖"); const row = f.engine.plan(f.input);
    expect(await f.engine.run(row.id)).toMatchObject({ phase: "NEEDS_ATTENTION", resume_phase: "PENDING", failure_code: "CONFLICT" }); expect(await readFile(join(f.fromPath, "原视频.mkv"))).toEqual(f.bytes); expect(await readFile(join(f.toPath, ...f.input.to.segments), "utf8")).toBe("外部文件不能覆盖");
    await rename(join(f.toPath, ...f.input.to.segments), join(f.toPath, "外部文件保留.mkv")); f.engine.retry(row.id); expect(await f.engine.run(row.id)).toMatchObject({ phase: "DONE" }); expect(await readFile(join(f.toPath, "外部文件保留.mkv"), "utf8")).toBe("外部文件不能覆盖");
  });
  it("原路径不变仍产生完成收据，只有大小写变化则经过私有隔离", async () => {
    const f = await fixture(); f.input.to = f.input.from; const none = f.engine.plan(f.input); expect(JSON.parse(none.plan_json).mode).toBe("NONE"); expect(await f.engine.run(none.id)).toMatchObject({ phase: "DONE" });
    const g = await fixture(); g.input.to = { ...g.input.from, segments: ["原视频.MKV"] }; const move = g.engine.plan(g.input); expect(JSON.parse(move.plan_json).mode).toBe("MOVE"); expect(await g.engine.run(move.id)).toMatchObject({ phase: "DONE" }); expect((await g.roots.get(g.fromGrant.id).inspectForRelocation(g.input.to.segments)).evidence).toEqual(g.expected);
  });
  it("COPY 先发布并保留暂存锚点，再隔离与回收旧媒体；历史记账后才清理暂存", async () => {
    const f = await fixture(true), row = f.engine.plan(f.input), done = await f.engine.run(row.id); expect(done).toMatchObject({ phase: "DONE", recorded: 0 }); const evidence = JSON.parse(done.evidence_json!); expect(evidence.sha256).toBe(f.expected.sha256); expect(evidence.inode).not.toBe(f.expected.inode);
    expect(await f.roots.get(f.toGrant.id).verifyStage(done.attempt_id!, f.input.to.segments, f.bytes.length)).toEqual(evidence); await expect(lstat(join(f.fromPath, "原视频.mkv"))).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(join(f.path, "下载原件.mkv"))).toEqual(f.bytes);
    await expect(f.engine.cleanupRecorded(row.id)).rejects.toThrow(); f.db.connection.prepare("UPDATE correction_item SET state='RECORDED' WHERE id=?").run(f.input.itemId); f.engine.releaseRecorded(f.input.itemId); await f.engine.cleanupRecorded(row.id); expect(await readFile(join(f.toPath, ...f.input.to.segments))).toEqual(f.bytes); await expect(f.roots.get(f.toGrant.id).verifyStage(done.attempt_id!, f.input.to.segments, f.bytes.length)).rejects.toMatchObject({ code: "ENOENT" }); await f.engine.cleanupRecorded(row.id);
  });
  it.each(["隔离后", "新位置发布后"])("同卷%s丢失回执，原步骤可恢复而不重复移动已完成文件", async (checkpoint) => {
    let interrupted = false; const api: NativeRenameApi = { ...native, renameBeneath: async (...args) => { const result = await native.renameBeneath(...args); if (result.moved && !interrupted && (checkpoint === "隔离后" ? args[3][0] === ".media-marshal" : args[1][0] === ".media-marshal")) { interrupted = true; throw new Error("模拟回执丢失"); } return result; } };
    const f = await fixture(false, api), row = f.engine.plan(f.input); expect(await f.engine.run(row.id)).toMatchObject({ phase: "NEEDS_ATTENTION", resume_phase: checkpoint === "隔离后" ? "PENDING" : "QUARANTINED" }); f.engine.retry(row.id); expect(await f.engine.run(row.id)).toMatchObject({ phase: "DONE" }); expect((await f.roots.get(f.toGrant.id).inspectForRelocation(f.input.to.segments)).evidence).toEqual(f.expected);
  });
  it("跨卷发布回执丢失只补记，旧目标离线时保留新文件并等待原卷恢复", async () => {
    let path = "", once = false; const api: NativeRenameApi = { ...native, linkBeneath: async (...args) => { const result = await native.linkBeneath(...args); if (result.published && !once) { once = true; await rename(path, path + "-离线"); } return result; } };
    const f = await fixture(true, api); path = f.fromPath; const row = f.engine.plan(f.input), paused = await f.engine.run(row.id); expect(paused).toMatchObject({ phase: "PUBLISHED", failure_code: "LOCAL_UNAVAILABLE" }); const published = (await lstat(join(f.toPath, ...f.input.to.segments))).ino;
    await rename(path + "-离线", path); f.engine.retry(row.id); expect(await f.engine.run(row.id)).toMatchObject({ phase: "DONE" }); expect((await lstat(join(f.toPath, ...f.input.to.segments))).ino).toBe(published);
  });
  it("核验旧隔离文件期间新目标被改写，删除前复核保留旧媒体，不把先前摘要当作当前证据", async () => {
    const f = await fixture(true), source = f.roots.get(f.fromGrant.id), remove = source.removeRelocation.bind(source); vi.spyOn(source, "removeRelocation").mockImplementationOnce(async (...args) => { await writeFile(join(f.toPath, ...f.input.to.segments), "新目标已被外部改写"); return remove(...args); }); const row = f.engine.plan(f.input);
    expect(await f.engine.run(row.id)).toMatchObject({ phase: "NEEDS_ATTENTION", resume_phase: "REMOVING_OLD" }); expect(await readFile(join(f.fromPath, ...source.relocationSegments(row.id)))).toEqual(f.bytes); expect(await readFile(join(f.toPath, ...f.input.to.segments), "utf8")).toBe("新目标已被外部改写"); expect(await readFile(join(f.path, "下载原件.mkv"))).toEqual(f.bytes);
  });
  it("复制中取消保留原媒体和持久阶段，恢复使用新 attempt 而不追加损坏的半文件", async () => {
    const f = await fixture(true, native, Buffer.alloc(3 * 1024 * 1024, 37)), controller = new AbortController(), original = SourceRoot.prototype.digest; let aborted = false;
    vi.spyOn(SourceRoot.prototype, "digest").mockImplementation(function (this: SourceRoot, handle, size, signal, consume) { return original.call(this, handle, size, signal, async (bytes) => { await consume?.(bytes); if (!aborted) { aborted = true; controller.abort(); } }); });
    const row = f.engine.plan(f.input), stopped = await f.engine.run(row.id, controller.signal); expect(stopped).toMatchObject({ phase: "COPYING", failure_code: "INTERRUPTED" }); expect(await readFile(join(f.fromPath, "原视频.mkv"))).toEqual(f.bytes); vi.restoreAllMocks(); f.engine.retry(row.id); const done = await f.engine.run(row.id); expect(done.phase).toBe("DONE"); expect(done.attempt_id).not.toBe(stopped.attempt_id); expect(await readFile(join(f.toPath, ...f.input.to.segments))).toEqual(f.bytes);
  });
  it("复制完成后的暂存核验也可暂停，未校验的文件不发布，恢复沿新尝试继续", async () => {
    const f = await fixture(true), target = f.roots.get(f.toGrant.id), verify = target.verifyStage.bind(target); vi.spyOn(target, "verifyStage").mockImplementationOnce(async (...args) => { f.engine.interrupt(); return verify(...args); });
    const row = f.engine.plan(f.input), stopped = await f.engine.run(row.id); expect(stopped).toMatchObject({ phase: "COPYING", failure_code: "INTERRUPTED" }); await expect(lstat(join(f.toPath, ...f.input.to.segments))).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(join(f.fromPath, "原视频.mkv"))).toEqual(f.bytes); f.engine.retry(row.id); expect(await f.engine.run(row.id)).toMatchObject({ phase: "DONE" });
  });
  it("全局暂停停止下一文件步骤，不动已计划文件；未登记的媒体根不能用于修正", async () => {
    const f = await fixture(), paused = new FileRelocations(f.db, f.roots, native, Date.now, () => false); cleanup.push(() => paused.close()); const row = paused.plan(f.input); expect(await paused.run(row.id)).toMatchObject({ phase: "PENDING", failure_code: "INTERRUPTED" }); expect(await readFile(join(f.fromPath, "原视频.mkv"))).toEqual(f.bytes);
    const grant = { ...f.toGrant, id: randomUUID() }; expect(() => f.engine.plan({ ...f.input, id: randomUUID(), to: { grant, segments: ["非法目标.mkv"] } })).toThrow("授权不可用");
  });
  it("原生改名在途时暂停，等待已隔离结果落日志；恢复只从隔离阶段继续", async () => {
    let release!: () => void, entered!: () => void, held = false; const gate = new Promise<void>((done) => { release = done; }), ready = new Promise<void>((done) => { entered = done; }); cleanup.push(() => release());
    const api: NativeRenameApi = { ...native, renameBeneath: async (...args) => { const result = await native.renameBeneath(...args); if (result.moved && !held) { held = true; entered(); await gate; } return result; } };
    const f = await fixture(false, api), row = f.engine.plan(f.input), pending = f.engine.run(row.id); await ready; f.engine.interrupt(); release(); expect(await pending).toMatchObject({ phase: "QUARANTINED", failure_code: "INTERRUPTED" });
    expect((await f.roots.get(f.fromGrant.id).inspectForRelocation(f.roots.get(f.fromGrant.id).relocationSegments(row.id))).evidence).toEqual(f.expected); f.engine.retry(row.id); expect(await f.engine.run(row.id)).toMatchObject({ phase: "DONE" });
  });
  it("已发布但未记账的新位置被外部替换，恢复不认领同内容文件，也不删除旧目标", async () => {
    let once = false; const api: NativeRenameApi = { ...native, linkBeneath: async (...args) => { const result = await native.linkBeneath(...args); if (result.published && !once) { once = true; throw new Error("发布后回执丢失"); } return result; } };
    const f = await fixture(true, api), row = f.engine.plan(f.input); expect(await f.engine.run(row.id)).toMatchObject({ phase: "NEEDS_ATTENTION", resume_phase: "VERIFIED" }); await rename(join(f.toPath, ...f.input.to.segments), join(f.toPath, "真实成果保留.mkv")); await writeFile(join(f.toPath, ...f.input.to.segments), f.bytes);
    f.engine.retry(row.id); expect(await f.engine.run(row.id)).toMatchObject({ phase: "NEEDS_ATTENTION", resume_phase: "VERIFIED" }); expect(await readFile(join(f.fromPath, "原视频.mkv"))).toEqual(f.bytes); expect(await readFile(join(f.toPath, "真实成果保留.mkv"))).toEqual(f.bytes); expect(await readFile(join(f.toPath, ...f.input.to.segments))).toEqual(f.bytes);
  });
  it("文件完成但历史未记账时，新目标缺失仅用原暂存锚点重建，不要求旧卷在线", async () => {
    const f = await fixture(true), row = f.engine.plan(f.input); expect(await f.engine.run(row.id)).toMatchObject({ phase: "DONE" });
    const path = join(f.toPath, ...f.input.to.segments), original = (await lstat(path, { bigint: true })).ino; await rename(path, join(f.toPath, "已发布成果保留.mkv")); await rename(f.fromPath, f.fromPath + "-离线");
    expect(await f.engine.run(row.id)).toMatchObject({ phase: "DONE" }); expect((await lstat(path, { bigint: true })).ino).toBe(original); expect(await readFile(path)).toEqual(f.bytes);
    await rename(path, join(f.toPath, "再次保留成果.mkv")); await writeFile(path, f.bytes); expect(await f.engine.run(row.id)).toMatchObject({ phase: "NEEDS_ATTENTION", resume_phase: "OLD_REMOVED" }); expect((await lstat(path, { bigint: true })).ino).not.toBe(original); expect(await readFile(join(f.path, "下载原件.mkv"))).toEqual(f.bytes);
  });
  it.each([["ENOSPC", "释放空间"], ["EACCES", "读写权限"]])("%s 持久等待包含文件对象和可信修复动作，不保留原始错误", async (code, action) => {
    const api: NativeRenameApi = { ...native, renameBeneath: async () => { throw Object.assign(new Error("原始敏感响应不应持久化"), { code }); } }, f = await fixture(false, api), row = f.engine.plan(f.input), stopped = await f.engine.run(row.id);
    expect(stopped).toMatchObject({ phase: "PENDING", failure_code: "LOCAL_UNAVAILABLE", failure: null }); expect(stopped.waiting_reason).toContain("原视频.mkv"); expect(stopped.waiting_reason).toContain(action); expect(JSON.stringify(stopped)).not.toContain("原始敏感响应"); expect(await readFile(join(f.fromPath, "原视频.mkv"))).toEqual(f.bytes);
  });
  it.each([
    ["isolated", false, "PENDING"], ["moved", false, "QUARANTINED"], ["copying", true, "COPYING"],
    ["published", true, "VERIFIED"], ["removed", true, "REMOVING_OLD"], ["done", true, "DONE"],
  ] as const)("真实独立 Core 在 %s 后 SIGKILL，按原日志恢复而不覆盖或再次移动成果", async (checkpoint, copy, phase) => {
    const f = await fixture(copy, native, Buffer.alloc(3 * 1024 * 1024, 53)), row = f.engine.plan(f.input), database = join(f.path, "core.sqlite3"), config = join(f.path, "crash.json");
    await writeFile(config, JSON.stringify({ database, id: row.id, native: nativeLaunch, checkpoint })); f.db.close();
    const child = spawn(process.execPath, [resolve("tools/desktop-files/relocation-crash-child.mjs"), config], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "", timeout: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<{ code: number | null; signal: string | null }>((done, fail) => { child.once("error", fail); child.once("exit", (code, signal) => done({ code, signal })); });
    const reached = new Promise<void>((done) => { child.stdout.on("data", (bytes) => { output += bytes.toString(); if (output.includes("CHECKPOINT:" + checkpoint + "\n")) done(); }); }); child.stderr.on("data", (bytes) => { errors = (errors + bytes.toString()).slice(-8192); });
    try {
      await Promise.race([reached, exited.then(() => { throw new Error("检查点前子进程退出：" + errors); }), new Promise((_, fail) => { timeout = setTimeout(() => fail(new Error("检查点等待超时：" + errors)), 15000); })]);
      expect(child.kill("SIGKILL")).toBe(true); expect((await exited).signal).toBe("SIGKILL");
    } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
    const restored = await CoreDatabase.open(database); cleanup.push(() => restored.close()); const engine = new FileRelocations(restored, f.roots, native); cleanup.push(() => engine.close()); const persisted = engine.get(row.id); expect(persisted.phase).toBe(phase);
    const before = await lstat(join(f.toPath, ...f.input.to.segments), { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
    const done = await engine.run(row.id); expect(done).toMatchObject({ phase: "DONE", recorded: 0 }); const current = await f.roots.get(f.toGrant.id).inspectForRelocation(f.input.to.segments); expect(current.evidence.sha256).toBe(f.expected.sha256); if (before) expect(current.snapshot.ino).toBe(before.ino);
    expect((await engine.run(row.id)).id).toBe(row.id); expect(await readFile(join(f.path, "下载原件.mkv"))).toEqual(f.bytes); expect(restored.connection.prepare("SELECT status FROM media_task").get()).toEqual({ status: "DONE" });
  }, 25000);
});
