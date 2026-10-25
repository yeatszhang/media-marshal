import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, lstat, open, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir, release, version } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
if (process.platform !== "darwin") throw new Error("文件系统实测仅在 macOS 执行");
const binary = resolve(process.argv[2] ?? `build-artifacts/desktop-files/darwin-${process.arch}/rename-exclusive.node`), manifest = JSON.parse(await readFile(join(binary, "../manifest.json"), "utf8"));
const bytes = await readFile(binary); assert.equal(manifest.binary.sha256, createHash("sha256").update(bytes).digest("hex")); assert.equal(manifest.target, `darwin-${process.arch}`);
const native = createRequire(import.meta.url)(binary), run = promisify(execFile), work = await realpath(await mkdtemp(join(tmpdir(), "marshal-exclusive-volumes-"))), volumes = [];
const plist = (text) => new Promise((done, fail) => { const child = spawn("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { stdio: ["pipe", "pipe", "pipe"] }); let output = ""; child.stdout.on("data", (bytes) => { output += bytes; }); child.stderr.resume(); child.on("error", fail); child.on("exit", (code) => { if (code) fail(new Error("无法核对磁盘映像归属")); else { try { done(JSON.parse(output)); } catch (error) { fail(error); } } }); child.stdin.end(text); });
const identity = (info) => Object.fromEntries(["dev", "ino", "size", "birthtimeNs", "mtimeNs", "ctimeNs"].map((key) => [key, info[key]]));
const report = { capturedAt: new Date().toISOString(), os: { release: release(), version: version() }, build: manifest, platform: process.platform, arch: process.arch, napi: process.versions.napi, binarySha256: manifest.binary.sha256, results: [], cleanup: false };
let failure;
try {
  for (const [label, format] of [["APFS", "APFS"], ["HFS+", "Journaled HFS+"], ["exFAT", "ExFAT"]]) {
    const key = label === "HFS+" ? "hfs" : label.toLowerCase(), image = join(work, key + ".sparseimage"), mount = join(work, key); await mkdir(mount);
    const volume = { image, mount, attached: false }; volumes.push(volume);
    await run("/usr/bin/hdiutil", ["create", "-size", "256m", "-type", "SPARSE", "-fs", format, "-volname", "MM" + key, "-nospotlight", image], { timeout: 30000 });
    await run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-noautoopen", "-mountpoint", mount, image], { timeout: 30000 }); volume.attached = true;
    const fromPath = join(mount, "原目录 中文"), toPath = join(mount, "新目录 中文"); await mkdir(fromPath); await mkdir(toPath); await writeFile(join(fromPath, "原视频.mkv"), "自有测试媒体"); await writeFile(join(toPath, "占用.mkv"), "第三方占用保留");
    const from = await open(fromPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), to = await open(toPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), host = await open(work, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const expected = identity(await lstat(join(fromPath, "原视频.mkv"), { bigint: true })), occupied = await native.renameExclusive(from.fd, "原视频.mkv", to.fd, "占用.mkv", expected);
      assert.equal(occupied.state, "NOT_RENAMED"); assert(["TARGET_EXISTS", "UNSUPPORTED"].includes(occupied.code)); assert.equal(await readFile(join(toPath, "占用.mkv"), "utf8"), "第三方占用保留"); assert.equal(await readFile(join(fromPath, "原视频.mkv"), "utf8"), "自有测试媒体");
      const renamed = await native.renameExclusive(from.fd, "原视频.mkv", to.fd, "修正后.mkv", expected);
      if (renamed.state === "RENAMED") { assert.equal((await lstat(join(toPath, "修正后.mkv"), { bigint: true })).ino, expected.ino); assert.equal(await readFile(join(toPath, "修正后.mkv"), "utf8"), "自有测试媒体"); }
      else { assert.equal(label, "exFAT"); assert.equal(renamed.code, "UNSUPPORTED"); assert.equal(renamed.moved, false); }
      await writeFile(join(work, "跨卷.mkv"), "跨卷来源保留"); const crossExpected = identity(await lstat(join(work, "跨卷.mkv"), { bigint: true })), cross = await native.renameExclusive(host.fd, "跨卷.mkv", to.fd, "跨卷.mkv", crossExpected);
      assert.equal(cross.state, "NOT_RENAMED"); assert(["CROSS_VOLUME", "UNSUPPORTED"].includes(cross.code)); assert.equal(await readFile(join(work, "跨卷.mkv"), "utf8"), "跨卷来源保留");
      report.results.push({ filesystem: label, occupied, renamed, crossVolume: cross });
    } finally { await Promise.all([from.close(), to.close(), host.close()]); }
  }
} catch (error) { failure = error; }
finally {
  for (const volume of volumes.reverse()) {
    try {
      const info = await plist((await run("/usr/bin/hdiutil", ["info", "-plist"], { timeout: 10000 })).stdout), image = info.images?.find((image) => image["image-path"] === volume.image);
      if (!image) { volume.attached = false; continue; }
      const entity = image["system-entities"]?.find((item) => item["mount-point"] === volume.mount) ?? image["system-entities"]?.find((item) => /^\/dev\/disk\d+$/.test(item["dev-entry"] ?? ""));
      if (!entity?.["dev-entry"] || !/^\/dev\/disk\d+(?:s\d+)*$/.test(entity["dev-entry"])) throw new Error("自有映像挂载归属无法确认，保留测试目录");
      await run("/usr/bin/hdiutil", ["detach", entity["dev-entry"]], { timeout: 30000 }); volume.attached = false;
    } catch (error) { failure ??= error; }
  }
  const device = (await lstat(work, { bigint: true })).dev;
  const mounted = await Promise.all(volumes.map(async (volume) => (await lstat(volume.mount, { bigint: true })).dev !== device));
  if (!volumes.some((volume) => volume.attached) && !mounted.some(Boolean)) { await rm(work, { recursive: true, force: true }); report.cleanup = true; }
  else failure ??= new Error("测试挂载尚未完成安全清理，请核对自有映像");
}
console.log(JSON.stringify(report, null, 2)); if (failure) throw failure;
