// 开发验收：仅创建自己的稀疏映像和测试文件，按映像路径核对归属后卸载。
import { execFile, execFileSync, fork } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, lstat, readdir, open, link } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import ts from "typescript";
import { managedRootGrantSchema } from "@media-marshal/contracts/internal";

const [reportPath, selected] = process.argv.slice(2);
const formats = [["APFS", "APFS"], ["HFS+", "Journaled HFS+"], ["exFAT", "ExFAT"]].filter(([label]) => !selected || label === selected);
if (!formats.length) throw new Error("只支持 APFS、HFS+、exFAT 三种验收范围");
if (process.platform !== "darwin" || !reportPath || !isAbsolute(reportPath)) throw new Error("请在 macOS 指定本机私有报告的绝对路径");
await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
const reportFile = await open(reportPath, "wx", 0o600), work = await realpath(await mkdtemp(join(tmpdir(), "marshal-filesystem-matrix-")));
const repository = fileURLToPath(new URL("../../", import.meta.url)), execute = promisify(execFile), images = new Set(), abort = new AbortController();
const report = { schemaVersion: 1, date: new Date().toISOString(), os: release(), arch: process.arch, requestedFilesystems: formats.map(([label]) => label), method: "macOS 原生驱动挂载的独立稀疏磁盘映像；未访问用户媒体卷", privateWorkspace: work, sourceSha256: {}, cases: [], cleanup: { detached: false, temporaryDirectoryRemoved: false }, passed: false };
const owner = randomUUID(); await writeFile(join(work, "owner.json"), JSON.stringify({ owner, reportPath, pid: process.pid }), { flag: "wx", mode: 0o600 });
async function persist() { const bytes = Buffer.from(JSON.stringify(report, null, 2) + "\n"); let offset = 0; while (offset < bytes.length) { const { bytesWritten } = await reportFile.write(bytes, offset, bytes.length - offset, offset); if (!bytesWritten) throw new Error("私有报告写入中断"); offset += bytesWritten; } await reportFile.truncate(bytes.length); await reportFile.sync(); }
await persist();
const interrupted = () => abort.abort(); process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
async function run(file, args, cleanup = false) { return (await execute(file, args, { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, shell: false, ...(cleanup ? {} : { signal: abort.signal }) })).stdout; }
function plist(xml) { return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: xml, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 })); }
async function detach(image) {
  const info = plist(await run("/usr/bin/hdiutil", ["info", "-plist"], true));
  const attached = info.images?.find((item) => item["image-path"] === image); if (!attached) return;
  const device = attached["system-entities"]?.find((item) => /^\/dev\/disk\d+$/.test(item["dev-entry"] ?? ""))?.["dev-entry"];
  if (!device) throw new Error("无法核对自有映像设备，已保留临时目录");
  await run("/usr/bin/hdiutil", ["detach", device], true);
}
async function attach(image, mount) { await run("/usr/bin/hdiutil", ["attach", "-plist", "-nobrowse", "-noautoopen", "-mountpoint", mount, image]); }
async function compile(relative, name, replacements = {}) {
  const source = await readFile(join(repository, relative), "utf8"); report.sourceSha256[relative] = createHash("sha256").update(source).digest("hex");
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const dependencies = { "@media-marshal/contracts": pathToFileURL(join(repository, "packages/contracts/dist/index.js")).href, "@media-marshal/contracts/internal": pathToFileURL(join(repository, "packages/contracts/dist/internal/index.js")).href, zod: import.meta.resolve("zod"), ...replacements };
  for (const [specifier, address] of Object.entries(dependencies)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(address));
  const file = join(work, name + ".mjs"); await writeFile(file, code, { mode: 0o600 }); return pathToFileURL(file).href;
}
async function claim(target, bytes) {
  const child = fork(join(repository, "tools/desktop-sidecars/claim-commit-target.mjs"), [target, bytes.toString("base64")], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  return new Promise((resolveClaim, reject) => {
    let result; const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); reject(new Error("目标占用测试子进程超时")); }, 5000);
    child.once("message", (value) => { result = value; }); child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); if (code !== 0 || !result) reject(new Error("目标占用测试子进程未完成")); else resolveClaim(result); });
  });
}
async function race(root, folder, variant) {
  const bytes = Buffer.from("测试原始完整数据"), foreign = variant === "same-content" ? bytes : Buffer.from("其他进程的数据"), attempt = randomUUID(), segments = [variant + " 中文目标.mp4"];
  await root.prepareStage(attempt); const stage = await root.stageFilePath(attempt, segments); await writeFile(stage, bytes); const proof = await root.verifyStage(attempt, segments, bytes.length), target = join(folder, ...segments);
  const originalHash = root.hash; let armed = true, claimed;
  if (variant !== "application-first") root.hash = async function (file, ...args) {
    const evidence = await originalHash.call(this, file, ...args);
    if (armed && file === stage) { armed = false; await assert.rejects(lstat(target), { code: "ENOENT" }); claimed = await claim(target, foreign); assert.equal(claimed.state, "CLAIMED"); }
    return evidence;
  };
  try {
    if (variant === "application-first") { const committed = await root.commit(attempt, segments, proof); assert.equal(committed.evidence.inode, proof.inode); assert.equal((await claim(target, foreign)).state, "OCCUPIED"); }
    else { await assert.rejects(root.commit(attempt, segments, proof), { code: "CONFLICT" }); assert.equal(armed, false); assert.equal(String((await lstat(target, { bigint: true })).ino), claimed.inode); }
    const expected = variant === "application-first" ? bytes : foreign; assert.ok((await readFile(target)).equals(expected)); await root.cleanupAttempt(attempt); assert.ok((await readFile(target)).equals(expected));
    return { variant, passed: true, targetPreserved: true, ownStageCleanupOnly: true };
  } finally { root.hash = originalHash; }
}

try {
  const filesAddress = await compile("packages/media-core/src/files/index.ts", "files"), { ManagedRoot, sameVolumeRoot } = await import(filesAddress);
  const sourceAddress = await compile("packages/media-core/src/files/source-root.ts", "source-root", { "./index.js": filesAddress }), { SourceRoot } = await import(sourceAddress);
  const probeAddress = await compile("apps/desktop/src/main/cloud/volume-probe.ts", "volume-probe"), { probeManagedVolume, probeReadOnlyVolume } = await import(probeAddress);
  for (const [label, format] of formats) {
    if (abort.signal.aborted) throw new Error("验收已中断");
    const key = label === "HFS+" ? "hfs" : label.toLowerCase(), image = join(work, key + ".sparseimage"), mount = join(work, key + "-mount"); images.add(image); await mkdir(mount);
    const result = { filesystem: label, backing: "自有 256 MiB 稀疏磁盘映像", readOnlySource: null, writableTarget: null, nativeHardLink: null, races: [], remount: null }; report.cases.push(result);
    console.log(JSON.stringify({ event: "filesystem-start", filesystem: label }));
    result.phase = "create"; await run("/usr/bin/hdiutil", ["create", "-size", "256m", "-type", "SPARSE", "-fs", format, "-volname", "MM" + key, "-nospotlight", image]);
    result.phase = "attach"; await attach(image, mount);
    const sourceFolder = join(mount, "source"), targetFolder = join(mount, "target"), nativeFolder = join(mount, "native");
    for (const path of [sourceFolder, targetFolder, nativeFolder]) await mkdir(path);
    const sample = Buffer.from("只读来源必须保留的测试内容"); await writeFile(join(sourceFolder, "preserve.bin"), sample);
    const nativeDevice = (await run("/bin/df", ["-P", sourceFolder])).trim().split("\n").at(-1).trim().split(/\s+/)[0], nativeInfo = plist(await run("/usr/sbin/diskutil", ["info", "-plist", nativeDevice]));
    result.nativeMetadata = { filesystem: nativeInfo.FilesystemType, volumeUuidLength: nativeInfo.VolumeUUID?.length ?? 0, volumeUuidAccepted: managedRootGrantSchema.shape.volume.shape.volumeId.safeParse(nativeInfo.VolumeUUID?.toLowerCase()).success, };
    try { result.nativeMetadata.pathMax = (await run("/usr/bin/getconf", ["PATH_MAX", sourceFolder])).trim(); } catch (error) { result.nativeMetadata.pathMaxUnavailableCode = error.code; }
    result.phase = "read-only-probe";
    const before = await readdir(sourceFolder), readGrant = await probeReadOnlyVolume(sourceFolder); result.phase = "read-only-open";
    const source = await SourceRoot.open(readGrant);
    try { result.phase = "read-only-inspect"; const snapshot = await source.inspect(["preserve.bin"]); let digest; result.phase = "read-only-content"; await source.read(["preserve.bin"], snapshot, async (handle) => { digest = await source.digest(handle, snapshot.size, new AbortController().signal); }); assert.equal(digest, createHash("sha256").update(sample).digest("hex")); }
    finally { await source.close(); }
    assert.deepEqual(await readdir(sourceFolder), before); result.readOnlySource = { accepted: true, filesystemType: readGrant.volume.fsType, contentPreserved: true, noProbeFilesWritten: true };
    result.phase = "native-link"; await writeFile(join(nativeFolder, "original"), sample);
    try { await link(join(nativeFolder, "original"), join(nativeFolder, "linked")); assert.equal((await lstat(join(nativeFolder, "original"))).ino, (await lstat(join(nativeFolder, "linked"))).ino); result.nativeHardLink = { supported: true }; }
    catch (error) { result.nativeHardLink = { supported: false, code: error.code ?? "UNKNOWN" }; }
    result.phase = "writable-policy"; if (label === "exFAT") {
      try { await probeManagedVolume(targetFolder); throw new Error("exFAT 写入未被当前策略阻断"); }
      catch (error) { assert.equal(error.code, "UNSUPPORTED_CAPABILITY"); assert.equal(error.directoryIssue?.reason, "UNSUPPORTED_FILESYSTEM"); result.writableTarget = { accepted: false, code: error.code, reason: error.directoryIssue.reason }; }
      assert.deepEqual(await readdir(targetFolder), []); await detach(image);
    } else {
      const grant = await probeManagedVolume(targetFolder), root = await ManagedRoot.open(grant, "direct");
      try { await root.initialize(); await root.verifyCommitSupport(); result.writableTarget = { accepted: true, filesystemType: grant.volume.fsType, caseSensitive: grant.volume.caseSensitive, unicodeEquivalent: grant.volume.unicodeEquivalent }; for (const variant of ["different-content", "same-content", "application-first"]) result.races.push(await race(root, targetFolder, variant)); }
      finally { await root.close(); }
      await detach(image); await attach(image, mount); const restored = await probeManagedVolume(targetFolder, grant.id); assert.equal(sameVolumeRoot(grant.volume, restored.volume), true);
      const recovered = await ManagedRoot.open(restored, "direct"); try { await recovered.initialize(); await recovered.verifyCommitSupport(); } finally { await recovered.close(); }
      result.remount = { sameVolumeAndDirectoryIdentity: true, existingMarkerAccepted: true }; await detach(image);
    }
    result.phase = "complete"; console.log(JSON.stringify({ event: "filesystem-complete", filesystem: label }));
  }
  report.passed = true;
} catch (error) { report.error = { code: error.code ?? error.name, privateMessage: String(error.message).slice(0, 4096), ...(error.directoryIssue ? { directoryIssue: error.directoryIssue } : {}), ...(error.stderr ? { privateStderr: String(error.stderr).slice(0, 4096) } : {}), message: "文件系统验收未完成，请检查本机私有报告与临时映像状态" }; process.exitCode = 1; }
finally {
  try { for (const image of images) await detach(image); report.cleanup.detached = true; assert.equal(JSON.parse(await readFile(join(work, "owner.json"), "utf8")).owner, owner); await rm(work, { recursive: true, force: true }); report.cleanup.temporaryDirectoryRemoved = true; }
  catch { report.cleanup.message = "自有映像未能全部安全卸载，保留临时目录以供核对"; report.passed = false; process.exitCode = 1; }
  process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted);
  await persist(); await reportFile.close();
}
console.log(JSON.stringify({ passed: report.passed, filesystems: report.cases.length, cleanup: report.cleanup, privateReport: resolve(reportPath) }));
