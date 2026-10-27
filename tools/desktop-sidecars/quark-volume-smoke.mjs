// 使用自建 APFS 磁盘映像模拟缺盘；所有卸载/删除都限制在本次工具创建的映像中。
import { _electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile, lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
const run = promisify(execFile), delay = (ms) => new Promise((done) => setTimeout(done, ms));
const [directory, remotePath] = process.argv.slice(2); let application, scratch, attached = false, step = "validate";
try {
  const data = await realpath(directory), temporary = await realpath(tmpdir()); if (process.platform !== "darwin" || !data.startsWith(temporary + sep + "marshal-quark-desktop-") || !remotePath?.startsWith("/")) throw new Error();
  scratch = await realpath(await mkdtemp(join(tmpdir(), "marshal-owned-volume-"))); const image = join(scratch, "test.sparseimage"), mount = join(scratch, "挂载 测试"), target = join(mount, "downloads");
  await run("/usr/bin/hdiutil", ["create", "-size", "2g", "-type", "SPARSE", "-fs", "APFS", "-volname", "MediaMarshalTest", image]);
  const attach = async () => { await mkdir(mount, { recursive: true }); await run("/usr/bin/hdiutil", ["attach", image, "-nobrowse", "-mountpoint", mount]); attached = true; };
  const detach = async () => {
    const result = await run("/usr/bin/hdiutil", ["info", "-plist"]), conversion = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { timeout: 8000 }); conversion.child.stdin.end(result.stdout);
    const info = JSON.parse((await conversion).stdout);
    if (!info.images?.some((value) => value["image-path"] === image && value["system-entities"]?.some((entry) => entry["mount-point"] === mount))) throw new Error();
    await run("/usr/bin/hdiutil", ["detach", "-force", mount]); attached = false;
  };
  await attach(); await mkdir(target);
  const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const packaged = process.env.MARSHAL_EXECUTABLE === "1"; step = "launch";
  application = await _electron.launch({ ...(packaged ? { executablePath: process.env.MARSHAL_APP_PATH } : {}), args: [...(packaged ? [] : [resolve("apps/desktop")]), `--user-data-dir=${directory}`], env });
  const page = await application.firstWindow(); await page.getByText("核心已连接", { exact: true }).waitFor(); let account;
  for (let i = 0; i < 180; i++) { account = await page.evaluate(async () => (await window.desktopApi.listCloudAccounts()).find((a) => a.status === "READY")); if (account) break; await delay(250); } if (!account) throw new Error();
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, target);
  await page.getByRole("link", { name: "云端网盘", exact: true }).click(); await page.getByRole("button", { name: "选择下载目录", exact: true }).click(); await page.locator(".cloud-account-select").filter({ hasText: account.name }).first().click();
  const parts = remotePath.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const action = i < parts.length - 1 ? "打开" : "预览", button = page.getByRole("button", { name: `${action} ${parts[i]}`, exact: true });
    for (let n = 0; n < 1000 && !await button.count(); n++) { if (await page.getByText("正在读取目录…", { exact: true }).count()) { await delay(100); continue; } const more = page.getByRole("button", { name: "加载更多", exact: true }); if (!await more.count()) throw new Error(); await more.click(); await delay(200); } await button.click();
  }
  await page.getByRole("button", { name: "预览下载范围", exact: true }).click(); await page.getByText(/完整范围：1 个文件/).waitFor({ timeout: 60000 }); await page.getByRole("button", { name: "确认下载", exact: true }).click();
  let job; const current = async () => (await page.evaluate(() => window.desktopApi.listDownloads({}))).items[0];
  for (let i = 0; i < 120; i++) { job = await current(); if (job?.state === "RUNNING" && job.progress.bytes > 0) break; await delay(100); } if (job?.state !== "RUNNING") throw new Error();
  step = "detach-during-write"; await detach();
  for (let i = 0; i < 160; i++) { job = await current(); if (job.state === "BLOCKED_LOCAL") break; await delay(250); } if (job.state !== "BLOCKED_LOCAL") throw new Error();
  if (await lstat(target).then(() => true, () => false)) throw new Error();
  step = "replacement-root"; await mkdir(target, { recursive: true }); await page.evaluate(() => window.desktopApi.restoreCloudAccounts());
  if ((await current()).state !== "BLOCKED_LOCAL") throw new Error();
  if ((await (await import("node:fs/promises")).readdir(target)).length) throw new Error(); await rm(mount, { recursive: true });
  step = "original-volume-restored"; await attach(); await page.evaluate(() => window.desktopApi.restoreCloudAccounts());
  const restoredRoot = await page.evaluate(async (path) => (await window.desktopApi.listDownloadRoots()).find((root) => root.path === path)?.state, target); if (restoredRoot !== "AVAILABLE") throw new Error();
  for (let i = 0; i < 2400; i++) { job = await current(); if (job.state === "COMPLETED") break; if (["FAILED", "AUTH_REQUIRED", "RECONCILING"].includes(job.state)) throw new Error(); if (i % 80 === 0) console.log(JSON.stringify({ phase: step, state: job.state, bytes: job.progress.bytes })); await delay(250); }
  if (job.state !== "COMPLETED") throw new Error(); const file = join(target, "completed", parts.at(-1)), hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); const localSha256 = hash.digest("hex");
  if (localSha256 !== "01663a977dc49a136db3f257113a3125b0de00358c54406a28d2991f75abb503") throw new Error();
  const report = { target: `${process.platform}-${process.arch}`, packaged, actualApfsImageForceDetachedDuringTransfer: true, missingOriginalRootNotRecreated: true, replacementMountPathReceivedNoFiles: true, originalVolumeRestored: true, resumedSameLogicalJob: true, completedSize: job.progress.totalBytes, localSha256, externalPhysicalDiskClaimed: false, signed: false };
  await writeFile("test-results/sidecars/quark-volume.json", JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report));
} catch { console.log(JSON.stringify({ passed: false, step, detail: "未输出原始错误、路径或凭据" })); process.exitCode = 1; }
finally {
  await application?.close().catch(() => {});
  if (scratch) {
    if (attached) await run("/usr/bin/hdiutil", ["detach", "-force", join(scratch, "挂载 测试")]).then(() => { attached = false; }, () => {});
    if (!attached) await rm(scratch, { recursive: true, force: true });
  }
}
