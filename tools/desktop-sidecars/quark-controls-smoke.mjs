// 复用明确指定的临时验收账号，验证真实窗口与 CLI 暂停/恢复/取消；不读取 Cookie。
import { _electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep, resolve } from "node:path";
const run = promisify(execFile), delay = (ms) => new Promise((done) => setTimeout(done, ms));
const directory = process.argv[2], remotePath = process.argv[3]; let application, step = "initialize";
try {
  const data = await realpath(directory), temporary = await realpath(tmpdir());
  if (!data.startsWith(temporary + sep + "marshal-quark-desktop-") || !remotePath?.startsWith("/")) throw new Error();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.MARSHAL_EXECUTABLE === "1";
  application = await _electron.launch({ ...(packaged ? { executablePath: process.env.MARSHAL_APP_PATH } : {}), args: [...(packaged ? [] : [resolve("apps/desktop")]), `--user-data-dir=${directory}`], env }); const page = await application.firstWindow();
  await page.getByText("核心已连接", { exact: true }).waitFor();
  await page.getByRole("link", { name: "云端下载", exact: true }).click(); await page.getByText("下载完成", { exact: true }).waitFor();
  const prior = await page.evaluate(async () => (await window.desktopApi.listDownloads({})).items.find((job) => job.state === "COMPLETED")); if (!prior) throw new Error();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 640));
  await mkdir("test-results/sidecars", { recursive: true }); await page.screenshot({ path: "test-results/sidecars/quark-download-completed.png" });
  step = "restore-account"; let account;
  for (let count = 0; count < 180; count++) { account = await page.evaluate(async () => (await window.desktopApi.listCloudAccounts()).find((value) => value.status === "READY")); if (account) break; await delay(250); }
  if (!account) throw new Error();
  const target = join(data, "control-test-download-" + randomUUID()); await mkdir(target, { recursive: true });
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, target);
  await page.getByRole("link", { name: "云端网盘", exact: true }).click(); await page.getByRole("button", { name: "选择下载目录", exact: true }).click(); await page.getByText(target, { exact: true }).waitFor();
  await page.locator(".cloud-account-select").filter({ hasText: account.name }).first().click();
  step = "browse"; const segments = remotePath.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    const action = index < segments.length - 1 ? "打开" : "预览", button = page.getByRole("button", { name: `${action} ${segments[index]}`, exact: true });
    for (let count = 0; count < 2000; count++) { if (await button.count()) break; if (await page.getByText("正在读取目录…", { exact: true }).count()) { await delay(100); continue; } const more = page.getByRole("button", { name: "加载更多", exact: true }); if (!await more.count()) throw new Error(); await more.click(); await delay(200); }
    await button.click();
  }
  await page.getByRole("button", { name: "预览下载范围", exact: true }).click(); await page.getByText(/完整范围：1 个文件/).waitFor({ timeout: 60000 }); await page.getByRole("button", { name: "确认下载", exact: true }).click();
  const writers = async () => (await run("/bin/ps", ["-axo", "pid=,command="])).stdout.split("\n").filter((line) => /\/bin\/rclone\s/.test(line) && (line.includes(data) || line.includes(directory))).map((line) => Number(line.trim().split(/\s+/)[0]));
  const waitWriter = async () => { for (let count = 0; count < 100; count++) { const found = await writers(); if (found.length === 1) return found[0]; if (found.length > 1) throw new Error(); await delay(25); } throw new Error(); };
  step = "unknown-progress"; const firstWriter = await waitWriter();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  const current = page.locator(".download-job").first(); await current.getByText(/\/ 未知/).waitFor({ timeout: 2000 });
  if (await current.locator("progress").count()) throw new Error(); await page.screenshot({ path: "test-results/sidecars/quark-download-unknown.png" });
  step = "pause"; await current.getByRole("button", { name: "暂停下载", exact: true }).click(); await current.getByText("已暂停", { exact: true }).waitFor();
  if ((await writers()).length) throw new Error();
  const paused = await page.evaluate(async () => (await window.desktopApi.listDownloads({})).items[0]);
  await page.reload(); await page.getByText("核心已连接", { exact: true }).waitFor(); await page.getByText("已暂停", { exact: true }).waitFor();
  const restored = await page.evaluate(async (id) => (await window.desktopApi.listDownloads({})).items.find((job) => job.id === id), paused.id); if (restored?.state !== "PAUSED") throw new Error();
  await page.screenshot({ path: "test-results/sidecars/quark-download-paused.png" });
  step = "resume-cancel"; await page.locator(".download-job").first().getByRole("button", { name: "恢复下载", exact: true }).click(); const secondWriter = await waitWriter(); if (secondWriter === firstWriter) throw new Error();
  await page.locator(".download-job").first().getByRole("button", { name: "取消下载", exact: true }).click(); await page.locator(".download-job").first().getByText("已取消", { exact: true }).waitFor(); if ((await writers()).length) throw new Error();
  step = "retained-completed"; const completed = await page.evaluate(async (id) => (await window.desktopApi.listDownloads({})).items.find((job) => job.id === id), prior.id); if (completed?.state !== "COMPLETED") throw new Error();
  if ((await stat(join(data, "whole-file-download", "completed", segments.at(-1)))).size !== 604951500) throw new Error();
  await page.evaluate((id) => window.desktopApi.openDownloadDirectory(id), prior.id);
  const report = { target: `${process.platform}-${process.arch}`, packaged, scope: "真实窗口与正式 Main/Core/Host/OpenList/Rclone 控制", unknownProgressWithoutPercentage: true, pausedOnlyAfterNativeExit: true, pausedJobRetainedAfterReload: true, resumeCreatedDifferentNativeWriter: true, cancelledOnlyAfterNativeExit: true, priorCompletedFileRetained: true, openCompletedDirectory: true, signed: false };
  await writeFile("test-results/sidecars/quark-controls.json", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); console.log(JSON.stringify(report));
} catch { console.log(JSON.stringify({ passed: false, step, detail: "原始错误、路径和凭据未打印" })); process.exitCode = 1; }
finally { await application?.close().catch(() => {}); }
