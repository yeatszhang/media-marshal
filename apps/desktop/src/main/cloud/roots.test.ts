import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, mkdir, rename, rm, symlink, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CoreDatabase } from "../../../../../packages/media-core/src/infrastructure/database";
import { CloudRoots } from "../../../../../packages/media-core/src/cloud/roots";
import { createMediaApplication } from "@media-marshal/media-core";
import { ManagedRoots, assertSpaceBudget, isManagedPrivatePath, pathsOverlap } from "@media-marshal/media-core/files";
import { probeManagedVolume } from "./volume-probe";
import { DownloadRootController } from "./roots";

const directories: string[] = [], cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function directory() { const path = await realpath(await mkdtemp(join(tmpdir(), "marshal-root-"))); directories.push(path); return path; }
async function setup() {
  const path = await directory(), grant = await probeManagedVolume(path), db = await CoreDatabase.open(":memory:"); cleanup.push(() => db.close());
  const roots = new CloudRoots(db); cleanup.push(() => roots.close()); await roots.authorize(grant); return { path, grant, db, roots, root: roots.files.get(grant.id) };
}
describe.skipIf(process.platform !== "darwin")("Mac 真实受管目录与卷策略", () => {
  it("原生探测卷身份和命名能力，安装与恢复保持同一授权，探测文件无残留", async () => {
    const { path, grant, db, roots } = await setup();
    expect(grant.volume.fsType).toBe("apfs");
    expect(await probeManagedVolume(path, grant.id)).toEqual(grant);
    expect((await readdir(path)).some((name) => name.includes("probe"))).toBe(false);
    const second = await roots.authorize(await probeManagedVolume(path)); expect(second.id).toBe(grant.id);
    expect(await roots.list()).toMatchObject([{ id: grant.id, state: "AVAILABLE", availableBytes: expect.any(Number) }]);
    const restored = new CloudRoots(db); cleanup.push(() => restored.close());
    expect(await restored.list()).toMatchObject([{ state: "UNAVAILABLE", availableBytes: null }]);
    await restored.authorize(await probeManagedVolume(path, grant.id)); expect(await restored.list()).toMatchObject([{ state: "AVAILABLE" }]);
  });
  it("下载授权拒绝应用与私有目录及其父目录，拒绝发生在命名探测写入之前", async () => {
    const base = await directory(), privateRoot = join(base, "private"), sibling = join(base, "downloads"); await mkdir(privateRoot); await mkdir(sibling);
    const probe = vi.fn(probeManagedVolume), core = { requestPrivate: vi.fn(), request: vi.fn() }, controller = new DownloadRootController(core as never, { installRoot: async () => {} }, probe, [privateRoot]);
    await expect(controller.choose(privateRoot)).rejects.toMatchObject({ code: "FORBIDDEN" }); await expect(controller.choose(base)).rejects.toMatchObject({ code: "FORBIDDEN" }); expect(probe).not.toHaveBeenCalled(); expect(await readdir(privateRoot)).toEqual([]);
    let grant: any; core.requestPrivate.mockImplementation(async (_action: any, value: any) => { grant = value; return value; }); core.request.mockImplementation(async () => [{ id: grant.id, path: grant.path, state: "AVAILABLE", availableBytes: 0 }] as never);
    expect((await controller.choose(sibling)).path).toBe(sibling); expect(probe).toHaveBeenCalledTimes(1);
  });
  it("原卷元数据不变但旧目录句柄已失效时，重新授权必须重开句柄", async () => {
    const { path, grant, roots } = await setup(), previous = roots.files.get(grant.id); await previous.close();
    await expect(previous.check()).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
    const observed = await probeManagedVolume(path, grant.id); expect(observed).toEqual(grant); await roots.authorize(observed);
    expect(roots.files.get(grant.id)).not.toBe(previous); expect(await roots.list()).toMatchObject([{ state: "AVAILABLE" }]);
  });
  it("拒绝路径越界、实际卷的大小写/Unicode 槽位碰撞，暂存区统一排除", async () => {
    const { path, root, grant } = await setup();
    for (const parts of [["..", "x"], ["/outside"], ["a/b"], [""], ["x".repeat(256)], ["a".repeat(250), "b".repeat(250), "c".repeat(250), "d".repeat(250)]]) expect(() => root.segments(parts)).toThrow();
    expect(root.slotKey(["A.mp4"]) === root.slotKey(["a.mp4"])).toBe(!grant.volume.caseSensitive);
    expect(root.slotKey(["é.mp4"]) === root.slotKey(["e\u0301.mp4"])).toBe(grant.volume.unicodeEquivalent);
    if (!grant.volume.caseSensitive) expect(() => root.assertMappings([["A", "one.mp4"], ["a", "two.mp4"]])).toThrow();
    expect(pathsOverlap(path, join(path, "completed"), grant.volume)).toBe(true);
    expect(pathsOverlap(path, path + "-other", grant.volume)).toBe(false);
    expect(isManagedPrivatePath([".media-marshal", "staging", randomUUID()])).toBe(true);
    expect(isManagedPrivatePath(["completed", "movie.mp4"])).toBe(false);
    expect(() => assertSpaceBudget(100, 101)).toThrow();
    expect(() => assertSpaceBudget(30 * 1024 * 1024, 10 * 1024 * 1024, 5 * 1024 * 1024, 1)).toThrow();
    expect(() => assertSpaceBudget(30 * 1024 * 1024, 10 * 1024 * 1024)).not.toThrow();
    await expect(root.check().then((available) => assertSpaceBudget(available, Number.MAX_SAFE_INTEGER))).rejects.toThrow();
  });
  it("父目录/文件链接逃逸、同名目录被替换和缺盘均阻断，不创建替代根", async () => {
    const { path, root, grant, roots } = await setup(), outside = await directory(), attemptId = randomUUID();
    const stage = await root.prepareStage(attemptId);
    await symlink(outside, join(stage, "escape")); await writeFile(join(outside, "file.mp4"), "secret");
    await expect(root.verifyStage(attemptId, ["escape", "file.mp4"], 6)).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
    await symlink(join(outside, "file.mp4"), join(stage, "linked.mp4")); await expect(root.verifyStage(attemptId, ["linked.mp4"], 6)).rejects.toThrow();
    await rename(path, path + "-detached"); directories.push(path + "-detached");
    await expect(root.check()).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
    await mkdir(path);
    await expect(roots.authorize(await probeManagedVolume(path, grant.id))).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
    expect(await readdir(path)).toEqual([]);
    expect(await roots.list()).toMatchObject([{ state: "UNAVAILABLE" }]);
  });
  it("通过真实 Core 私有授权隔离普通来源，双向拒绝目录交叉覆盖", async () => {
    const path = await directory(), runtime = createMediaApplication(join(path, "app.sqlite3")); await runtime.app.start(); cleanup.push(() => runtime.stop());
    const source = join(path, "source"), target = join(path, "target"), managed = join(path, "managed"); await Promise.all([source, target, managed].map((p) => mkdir(p)));
    const core = {
      requestPrivate: (action: string, payload: unknown) => runtime.dispatchPrivate({ kind: "core.private.request", requestId: randomUUID(), action, payload }),
      request: (action: string, payload: unknown) => runtime.dispatch({ kind: "request", protocolVersion: 1, requestId: randomUUID(), action, payload }),
    };
    const installed: unknown[] = [], controller = new DownloadRootController(core as never, { installRoot: async (grant) => { installed.push(grant); } });
    const root = await controller.choose(managed); expect(installed).toHaveLength(1); expect(root.state).toBe("AVAILABLE");
    const save = (sourcePath: string, targetPath: string) => core.request("sources.save", { name: "本地来源", kind: "custom", sourcePath, targetPath });
    await expect(save(join(managed, "completed"), target)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(save(source, managed)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await save(source, target);
    await expect(controller.choose(source)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(controller.choose(path)).rejects.toMatchObject({ code: "CONFLICT" });
    await controller.restore(); expect(installed).toHaveLength(2);
    expect(JSON.stringify(await core.request("cloud.roots.list", {}))).not.toMatch(/volumeId|rootInode|observedDevice/);
    await expect(core.request("cloud.roots.authorize", { path: source })).rejects.toThrow();
  });
  it("独占不覆盖提交在同名抢建及崩溃后核对时保留原文件", async () => {
    const { path, root } = await setup(), id = randomUUID(), stage = await root.prepareStage(id);
    await writeFile(join(stage, "电影.mp4"), "test-content"); const evidence = await root.verifyStage(id, ["电影.mp4"], 12);
    await writeFile(join(path, "completed", "电影.mp4"), "foreign-data");
    await expect(root.commit(id, ["电影.mp4"], evidence)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(path, "completed", "电影.mp4"), "utf8")).toBe("foreign-data");
    const next = randomUUID(), nextStage = await root.prepareStage(next); await writeFile(join(nextStage, "safe.mp4"), "verified");
    const proof = await root.verifyStage(next, ["safe.mp4"], 8), first = await root.commit(next, ["safe.mp4"], proof);
    expect(first.alreadyCommitted).toBe(false); expect((await root.commit(next, ["safe.mp4"], proof)).alreadyCommitted).toBe(true);
    await root.cleanupAttempt(next); expect(await root.inspectCompleted(["safe.mp4"])).toEqual(proof);
    await expect(root.cleanupAttempt(randomUUID())).rejects.toThrow();
    const missing = new ManagedRoots(); cleanup.push(() => missing.close()); expect(() => missing.get(randomUUID())).toThrow();
  });
  it("另一进程在计划后抢建同名目标不会被覆盖，不支持的真实文件系统在写入前被拒绝", async () => {
    const { path, root } = await setup(), attempt = randomUUID(), stage = await root.prepareStage(attempt); await writeFile(join(stage, "race.mp4"), "verified-source");
    const proof = await root.verifyStage(attempt, ["race.mp4"], 15), target = join(path, "completed", "race.mp4");
    await promisify(execFile)(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'another-process', {flag:'wx'})", target], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, shell: false, timeout: 5000 });
    await expect(root.commit(attempt, ["race.mp4"], proof)).rejects.toMatchObject({ code: "CONFLICT" }); expect(await readFile(target, "utf8")).toBe("another-process");
    await expect(probeManagedVolume("/dev")).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
});
