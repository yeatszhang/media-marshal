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
const binary = resolve(process.argv[2] ?? `apps/desktop/resources/native-files/darwin-${process.arch}/rename-exclusive.node`), manifest = JSON.parse(await readFile(join(binary, "../manifest.json"), "utf8"));
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
      await writeFile(join(fromPath, "根内改名.mkv"), "根内改名内容"); const beneathExpected = identity(await lstat(join(fromPath, "根内改名.mkv"), { bigint: true })), beneath = await native.renameBeneath(from.fd, ["根内改名.mkv"], to.fd, ["嵌套目录", "修正后.mkv"], beneathExpected);
      if (beneath.state === "RENAMED") { assert.equal((await lstat(join(toPath, "嵌套目录/修正后.mkv"), { bigint: true })).ino, beneathExpected.ino); assert.equal(await readFile(join(toPath, "嵌套目录/修正后.mkv"), "utf8"), "根内改名内容"); }
      else { assert.equal(label, "exFAT"); assert.equal(beneath.moved, false); assert.equal(await readFile(join(fromPath, "根内改名.mkv"), "utf8"), "根内改名内容"); }
      await writeFile(join(fromPath, "暂存锚点.mkv"), "发布内容"); const staged = identity(await lstat(join(fromPath, "暂存锚点.mkv"), { bigint: true })), published = await native.linkBeneath(from.fd, ["暂存锚点.mkv"], to.fd, ["发布目录", "发布.mkv"], staged);
      if (published.state === "PUBLISHED") {
        const fresh = identity(await lstat(join(fromPath, "暂存锚点.mkv"), { bigint: true })); assert.equal((await lstat(join(toPath, "发布目录/发布.mkv"), { bigint: true })).ino, fresh.ino); assert.equal(await readFile(join(toPath, "发布目录/发布.mkv"), "utf8"), "发布内容");
        assert.equal((await native.linkBeneath(from.fd, ["暂存锚点.mkv"], to.fd, ["占用.mkv"], fresh)).code, "TARGET_EXISTS");
      } else { assert.equal(label, "exFAT"); assert.equal(published.published, false); }
      assert.equal(await readFile(join(fromPath, "暂存锚点.mkv"), "utf8"), "发布内容"); assert.equal(await readFile(join(toPath, "占用.mkv"), "utf8"), "第三方占用保留");
      const crossBeneath = await native.renameBeneath(host.fd, ["跨卷.mkv"], to.fd, ["跨卷不创建", "不得移动.mkv"], crossExpected); assert.equal(crossBeneath.code, "CROSS_VOLUME"); assert.equal(crossBeneath.moved, false); await assert.rejects(lstat(join(toPath, "跨卷不创建")), { code: "ENOENT" });
      report.results.push({ filesystem: label, occupied, renamed, crossVolume: cross, renameBeneath: beneath, publishBeneath: published, crossBeneath });
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
