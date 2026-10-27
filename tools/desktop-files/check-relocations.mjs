// 必须用当前 Electron Node 执行，SQLite ABI 与桌面一致；仅使用自有临时目录和磁盘映像。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, statfs, rm } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { CoreDatabase } from "../../packages/media-core/dist/infrastructure/database.js";
import { ManagedRoots } from "../../packages/media-core/dist/files/index.js";
import { FileRelocations } from "../../packages/media-core/dist/files/relocations.js";
import { loadNativeRename } from "../../packages/media-core/dist/files/native-rename.js";
if (process.platform !== "darwin") throw new Error("真实跨卷验证仅在 macOS 执行");
const run = promisify(execFile), work = await realpath(await mkdtemp(join(tmpdir(), "marshal-relocation-volumes-"))), mount = join(work, "hfs"), image = join(work, "test.sparseimage"), host = join(work, "host");
const plist = (input) => new Promise((done, fail) => { const child = spawn("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { stdio: ["pipe", "pipe", "pipe"] }); let output = ""; child.stdout.on("data", (bytes) => { output += bytes; }); child.stderr.resume(); child.on("error", fail); child.on("exit", (code) => { if (code) fail(new Error("磁盘映像归属无法核对")); else { try { done(JSON.parse(output)); } catch (error) { fail(error); } } }); child.stdin.end(input); });
const roots = new ManagedRoots("direct"), report = { capturedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, os: release(), electron: process.versions.electron, node: process.versions.node, schema: null, build: null, core: null, filesystems: null, results: [], downloadOriginalPreserved: false, cleanup: false };
let database, engine, failure;
try {
  await mkdir(mount); await mkdir(host);
  await run("/usr/bin/hdiutil", ["create", "-size", "256m", "-type", "SPARSE", "-fs", "Journaled HFS+", "-volname", "MMRelocation", "-nospotlight", image], { timeout: 30000 });
  await run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-noautoopen", "-mountpoint", mount, image], { timeout: 30000 });
  const target = join(mount, "媒体目标"); await mkdir(target);
  const manifestPath = resolve(`apps/desktop/resources/native-files/darwin-${process.arch}/manifest.json`), manifestBytes = await readFile(manifestPath), native = await loadNativeRename({ manifestPath, manifestSha256: createHash("sha256").update(manifestBytes).digest("hex") }); report.build = JSON.parse(manifestBytes);
  database = await CoreDatabase.open(join(work, "core.sqlite3"), undefined, { exclusiveOwner: true }); report.schema = database.schemaVersion;
  report.core = Object.fromEntries(await Promise.all(["files/relocations.js", "infrastructure/file-relocation-migration.js"].map(async (path) => [path, createHash("sha256").update(await readFile(new URL("../../packages/media-core/dist/" + path, import.meta.url))).digest("hex")])));
  async function grant(path, fsType) { const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true }); return { id: randomUUID(), path, volume: { volumeId: randomUUID(), rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType, caseSensitive: false, unicodeEquivalent: true, pathMaxBytes: 1024 } }; }
  const volumeInfo = async (path) => { const device = (await run("/bin/df", ["-P", path], { timeout: 10000 })).stdout.trim().split("\n").at(-1)?.trim().split(/\s+/)[0]; if (!/^\/dev\/disk\d+(?:s\d+)*$/.test(device ?? "")) throw new Error("测试卷设备无法核对"); return plist((await run("/usr/sbin/diskutil", ["info", "-plist", device], { timeout: 10000 })).stdout); };
  const hostInfo = await volumeInfo(host), targetInfo = await volumeInfo(target); assert.equal(hostInfo.FilesystemType, "apfs"); assert.equal(targetInfo.FilesystemType, "hfs"); report.filesystems = { host: hostInfo.FilesystemType, target: targetInfo.FilesystemType };
  const hostGrant = await grant(host, "apfs"), hfsGrant = await grant(target, "hfs"); assert.notEqual(hostGrant.volume.observedDevice, hfsGrant.volume.observedDevice);
  for (const grant of [hostGrant, hfsGrant]) { database.connection.prepare("INSERT INTO media_target_root(id,grant_json) VALUES(?,?)").run(grant.id, JSON.stringify(grant)); await roots.install(grant); }
  engine = new FileRelocations(database, roots, native);
  async function transfer(label, from, fromParts, to, toParts) {
    const task = randomUUID(), source = randomUUID(), job = randomUUID(), itemId = randomUUID(), id = randomUUID(), time = new Date().toISOString(), db = database.connection;
    db.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'测试来源','custom',?,?,'AUTO','COPY',?)").run(source, join(work, source), from.path, time);
    db.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'DONE',?,?)").run(task, source, join(work, source, "未访问下载文件.mkv"), time, time); db.prepare("INSERT INTO desktop_job VALUES(?,'correction','RUNNING','{}',?)").run(job, time); db.prepare("INSERT INTO correction_item VALUES(?,?,?,'PENDING','{}')").run(itemId, job, task);
    const expected = (await roots.get(from.id).inspectForRelocation(fromParts)).evidence, planned = engine.plan({ id, itemId, ordinal: 0, from: { grant: from, segments: fromParts }, to: { grant: to, segments: toParts }, expected }), mode = JSON.parse(planned.plan_json).mode, result = await engine.run(id); assert.equal(result.phase, "DONE", result.failure ?? result.waiting_reason);
    const actual = (await roots.get(to.id).inspectForRelocation(toParts)).evidence; assert.equal(actual.sha256, expected.sha256); assert.equal(actual.size, expected.size); await assert.rejects(lstat(join(from.path, ...fromParts)), { code: "ENOENT" });
    const stagedBeforeHistory = mode === "COPY" && JSON.stringify(await roots.get(to.id).verifyStage(result.attempt_id, toParts, expected.size)) === JSON.stringify(actual); if (mode === "COPY") assert(stagedBeforeHistory);
    db.prepare("UPDATE correction_item SET state='RECORDED' WHERE id=?").run(itemId); engine.releaseRecorded(itemId); await engine.cleanupRecorded(id); assert.equal((await roots.get(to.id).inspectForRelocation(toParts)).evidence.sha256, expected.sha256);
    report.results.push({ label, mode, differentDevices: from.volume.observedDevice !== to.volume.observedDevice, bytes: expected.size, sha256: expected.sha256, done: true, stagedBeforeHistory, targetPreservedAfterCleanup: true });
  }
  const bytes = Buffer.alloc(5 * 1024 * 1024, 73); await writeFile(join(work, "下载原件.mkv"), bytes); await writeFile(join(host, "旧视频.mkv"), bytes);
  await transfer("APFS → HFS+", hostGrant, ["旧视频.mkv"], hfsGrant, ["新作品", "新视频.mkv"]);
  await transfer("HFS+ → APFS", hfsGrant, ["新作品", "新视频.mkv"], hostGrant, ["再次修正", "新视频.mkv"]);
  await writeFile(join(target, "本卷旧视频.mkv"), bytes); await transfer("HFS+ 本卷改名", hfsGrant, ["本卷旧视频.mkv"], hfsGrant, ["本卷新作品", "新视频.mkv"]);
  assert.deepEqual(await readFile(join(work, "下载原件.mkv")), bytes); report.downloadOriginalPreserved = true;
} catch (error) { failure = error; }
finally {
  for (const close of [() => engine?.close(), () => roots.close(), () => database?.close()]) try { await close(); } catch (error) { failure ??= error; }
  try {
    const info = await plist((await run("/usr/bin/hdiutil", ["info", "-plist"], { timeout: 10000 })).stdout), owned = info.images?.find((row) => row["image-path"] === image);
    if (owned) { const device = owned["system-entities"]?.find((row) => row["mount-point"] === mount)?.["dev-entry"]; if (!/^\/dev\/disk\d+(?:s\d+)*$/.test(device ?? "")) throw new Error("自有挂载设备未确认，保留测试目录"); await run("/usr/bin/hdiutil", ["detach", device], { timeout: 30000 }); }
    const device = (await lstat(work, { bigint: true })).dev; let mounted = false; try { mounted = (await lstat(mount, { bigint: true })).dev !== device; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (mounted) throw new Error("测试映像仍挂载，保留测试目录"); await rm(work, { recursive: true, force: true }); report.cleanup = true;
  } catch (error) { failure ??= error; }
}
console.log(JSON.stringify(report, null, 2)); if (failure) throw failure;
