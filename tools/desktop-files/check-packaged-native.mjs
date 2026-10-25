// 独立目录包核验；只复制并改写本工具创建的副本，不修改原安装包或个人配置。
import { _electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
if (process.platform !== "darwin") throw new Error("此核验仅适用于 Mac 目录包");
const run = promisify(execFile), sha = (value) => createHash("sha256").update(value).digest("hex"), source = resolve(process.argv[2] ?? `apps/desktop/release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/Media Marshal.app`), work = await mkdtemp(join(tmpdir(), "marshal-native-package-")), copy = join(work, "中文 安装副本.app"), executable = join(copy, "Contents/MacOS/Media Marshal"), resources = join(copy, "Contents/Resources/native-files");
const report = { capturedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, os: release(), minimalPath: "/usr/bin:/bin:/usr/sbin:/sbin", manifestSha256: null, originalBinarySha256: null, results: [], cleanup: false };
let application, failure;
async function close() { if (!application) return; const child = application.process(); await application.close(); assert(child.exitCode !== null || child.signalCode !== null, "应用尚未退出，保留隔离安装副本"); application = undefined; }
async function launch(profile) {
  const env = { ...process.env, PATH: report.minimalPath }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${join(work, profile)}`], env }); const window = await application.firstWindow(); await window.getByText("核心已连接", { exact: true }).waitFor({ timeout: 30000 }); return window;
}
try {
  await run("/bin/cp", ["-cR", source, copy], { timeout: 30000 }); const manifestPath = join(resources, "manifest.json"), manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes.toString()), path = join(resources, "rename-exclusive.node"), binary = await readFile(path); report.manifestSha256 = sha(manifestBytes); report.originalBinarySha256 = sha(binary); assert.equal(manifest.binary.sha256, report.originalBinarySha256);
  const first = await launch("valid-profile"), healthy = await first.evaluate(() => window.desktopApi.getRuntime()); assert.equal(healthy.core, "ready"); assert.equal(healthy.status.correctionFiles, "ready"); assert.equal(healthy.status.parser, "ready"); assert.equal(healthy.status.taskCount, 0); report.results.push({ label: "原目录包组件加载", core: healthy.core, native: healthy.status.correctionFiles, parser: healthy.status.parser, schema: healthy.status.schemaVersion }); await close();
  // 改写外部模块与其清单，使二者相互匹配；ASAR 内清单仍是 Main 的可信锚点。
  const changed = Buffer.concat([binary, Buffer.from("\nISOLATED-INTEGRITY-FIXTURE\n")]); await writeFile(path, changed); manifest.binary.size = changed.length; manifest.binary.sha256 = sha(changed); await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const second = await launch("tampered-profile"), unavailable = await second.evaluate(() => window.desktopApi.getRuntime()); assert.equal(unavailable.core, "ready"); assert.equal(unavailable.status.correctionFiles, "unavailable"); assert.equal(unavailable.status.parser, "ready"); assert.equal(unavailable.status.taskCount, 0);
  const rejected = await second.evaluate(async ({ taskId, requestKey }) => { try { await window.desktopApi.previewCorrection({ taskId, requestKey, selection: { tmdbId: 2, mediaType: "MOVIE" } }); return false; } catch (error) { return String(error.message).includes("安全修正文件组件不可用"); } }, { taskId: randomUUID(), requestKey: randomUUID() }); assert(rejected); assert.deepEqual(await second.evaluate(() => window.desktopApi.listCorrections({})), { items: [], total: 0 }); report.results.push({ label: "外部模块和清单同时变化", core: unavailable.core, native: unavailable.status.correctionFiles, parser: unavailable.status.parser, rejectedWithoutFileOperation: rejected });
} catch (error) { failure = error; }
finally { try { await close(); await rm(work, { recursive: true, force: true }); report.cleanup = true; } catch (error) { failure ??= error; } }
console.log(JSON.stringify(report, null, 2)); if (failure) throw failure;
