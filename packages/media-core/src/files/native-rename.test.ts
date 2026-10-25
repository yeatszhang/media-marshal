import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, lstat, statfs, realpath, rm, symlink, rename, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import { ManagedRoot } from "./index";
import { loadNativeRename, type NativeRenameApi, type NativeRenameLaunch } from "./native-rename";

const run = promisify(execFile), digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
let work: string, native: NativeRenameApi, launch: NativeRenameLaunch;
const cleanup: (() => unknown | Promise<unknown>)[] = [];
describe.skipIf(process.platform !== "darwin")("修正文件组件的资源完整性与授权根接入", () => {
  beforeAll(async () => {
    work = await realpath(await mkdtemp(join(tmpdir(), "marshal-native-root-")));
    await run(process.execPath, [resolve("tools/desktop-files/build.mjs"), "--out", join(work, "native")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000 });
    launch = { manifestPath: join(work, "native/manifest.json"), manifestSha256: digest(await readFile(join(work, "native/manifest.json"))) }; native = await loadNativeRename(launch);
  }, 40000);
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
  afterAll(async () => { if (work) await rm(work, { recursive: true, force: true }); });
  async function fixture() {
    const path = await mkdtemp(join(work, "root-")), info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true });
    const grant: ManagedRootGrant = { id: randomUUID(), path, volume: { volumeId: randomUUID(), rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "real-isolated-test", caseSensitive: false, unicodeEquivalent: true, pathMaxBytes: 4096 } };
    const root = await ManagedRoot.open(grant, "direct"); cleanup.push(() => root.close()); await root.initialize(); return { path, root };
  }
  it("摘要或架构不符、链接资源和任意模块名均停止加载，错误不回显资源路径", async () => {
    const original = JSON.parse(await readFile(launch.manifestPath, "utf8"));
    const cases = [original, { ...original, target: process.arch === "arm64" ? "darwin-x64" : "darwin-arm64" }, { ...original, binary: { ...original.binary, name: "../foreign.node" } }];
    for (const [index, manifest] of cases.entries()) {
      const path = join(work, "bad-" + index); await mkdir(path); const bytes = JSON.stringify(manifest), manifestPath = join(path, "manifest.json"); await writeFile(manifestPath, bytes); await writeFile(join(path, "rename-exclusive.node"), "篡改资源");
      const error = await loadNativeRename({ manifestPath, manifestSha256: digest(bytes) }).catch((error: Error) => error); expect(error).toMatchObject({ code: "COMPONENT_UNAVAILABLE" }); expect(String(error)).not.toContain(work);
    }
    await expect(loadNativeRename({ ...launch, manifestSha256: "0".repeat(64) })).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
    const linkedManifest = join(work, "linked-manifest.json"); await symlink(launch.manifestPath, linkedManifest); await expect(loadNativeRename({ ...launch, manifestPath: linkedManifest })).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
    const directory = join(work, "linked-binary"); await mkdir(directory); await copyFile(launch.manifestPath, join(directory, "manifest.json")); await symlink(join(work, "native/rename-exclusive.node"), join(directory, "rename-exclusive.node")); await expect(loadNativeRename({ ...launch, manifestPath: join(directory, "manifest.json") })).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
  });
  it("已整理文件经私有隔离后改名，收据保持 inode／内容；下载原件不参与", async () => {
    const f = await fixture(), original = ["原作品.mkv"], target = ["新作品", "新作品.mkv"], id = randomUUID(); await writeFile(join(f.path, ...original), "媒体库中已整理的视频");
    const first = await f.root.inspectForRelocation(original), quarantine = f.root.relocationSegments(id);
    expect(await f.root.renameForRelocation(original, f.root, quarantine, first.snapshot, native)).toMatchObject({ state: "RENAMED" });
    const isolated = await f.root.inspectForRelocation(quarantine); expect(isolated.evidence).toEqual(first.evidence); expect(isolated.snapshot.ctimeNs).not.toBe(first.snapshot.ctimeNs);
    expect(await f.root.renameForRelocation(quarantine, f.root, target, isolated.snapshot, native)).toMatchObject({ state: "RENAMED" }); expect(await f.root.confirmRelocation(target, first.evidence)).toEqual(first.evidence);
    await expect(lstat(join(f.path, ...original))).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(join(f.path, ...target), "utf8")).toBe("媒体库中已整理的视频");
  });
  it("暂存发布的回执丢失后复用原 inode 补记，保留锚点且拒绝认领同内容外部文件", async () => {
    const f = await fixture(), attempt = randomUUID(), parts = ["新作品", "剧集.mkv"]; await f.root.prepareStage(attempt); await writeFile(await f.root.stageFilePath(attempt, parts), "跨卷复制暂存内容");
    const evidence = await f.root.verifyStage(attempt, parts, Buffer.byteLength("跨卷复制暂存内容"));
    // 模拟系统调用已发布、但上层没有收到确定回执；重试仍必须核对旧暂存锚点。
    const uncertain: NativeRenameApi = { ...native, linkBeneath: async (...args) => { const result = await native.linkBeneath(...args); return result.published ? { ...result, state: "UNCERTAIN", code: "SYNC_FAILED" } : result; } };
    await expect(f.root.publishRelocationStage(attempt, parts, evidence, uncertain)).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
    expect(await f.root.publishRelocationStage(attempt, parts, evidence, native)).toEqual(evidence); expect(await f.root.verifyStage(attempt, parts, evidence.size)).toEqual(evidence);
    await rename(join(f.path, ...parts), join(f.path, "真实发布保留.mkv")); await writeFile(join(f.path, ...parts), "跨卷复制暂存内容"); await expect(f.root.publishRelocationStage(attempt, parts, evidence, native)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(f.path, "真实发布保留.mkv"), "utf8")).toBe("跨卷复制暂存内容"); await f.root.cleanupAttempt(attempt); expect(await readFile(join(f.path, ...parts), "utf8")).toBe("跨卷复制暂存内容");
  });
  it("只清理证据一致的私有隔离文件，变化文件和其他私有路径均保留", async () => {
    const f = await fixture(), names = ["原视频.mkv"], id = randomUUID(); await writeFile(join(f.path, ...names), "旧目标"); const first = await f.root.inspectForRelocation(names), isolated = f.root.relocationSegments(id);
    await f.root.renameForRelocation(names, f.root, isolated, first.snapshot, native); await writeFile(join(f.path, ...isolated), "变更后必须保留"); await expect(f.root.removeRelocation(id, first.evidence)).rejects.toMatchObject({ code: "CONFLICT" }); expect(await readFile(join(f.path, ...isolated), "utf8")).toBe("变更后必须保留");
    await expect(f.root.inspectForRelocation([".media-marshal", "owner.json"])).rejects.toMatchObject({ code: "INVALID_REQUEST" }); await expect(f.root.inspectForRelocation(["..", "外部文件"])).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    const current = await f.root.inspectForRelocation(isolated); await f.root.removeRelocation(id, current.evidence); await expect(lstat(join(f.path, ...isolated))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("原根目录被替换、父级符号链接和已取消的摘要读取不会执行改名", async () => {
    const f = await fixture(); await writeFile(join(f.path, "视频.mkv"), "保留"); const controller = new AbortController(); controller.abort(); await expect(f.root.inspectForRelocation(["视频.mkv"], controller.signal)).rejects.toMatchObject({ code: "INTERRUPTED" });
    await symlink(work, join(f.path, "跳转")); await expect(f.root.inspectForRelocation(["跳转", "外部.mkv"])).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
    const file = await f.root.inspectForRelocation(["视频.mkv"]); await rename(f.path, f.path + "-原根"); await mkdir(f.path); await expect(f.root.renameForRelocation(["视频.mkv"], f.root, ["修正.mkv"], file.snapshot, native)).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" }); expect(await readFile(join(f.path + "-原根", "视频.mkv"), "utf8")).toBe("保留");
  });
});
