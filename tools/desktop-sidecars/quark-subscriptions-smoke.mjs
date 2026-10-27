// 仅复用本工具创建的临时账号；只下载调用者指定的文件，不输出凭据或个人路径。
import { _electron } from "@playwright/test";
import { realpath, mkdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const [directory, remotePath] = process.argv.slice(2); let application;
try {
  const data = await realpath(directory), temporary = await realpath(tmpdir()), parts = remotePath?.split("/").filter(Boolean);
  if (!data.startsWith(temporary + sep + "marshal-quark-desktop-") || !remotePath.startsWith("/") || parts.length < 2) throw new Error();
  const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const packaged = process.env.MARSHAL_EXECUTABLE === "1";
  application = await _electron.launch({ ...(packaged ? { executablePath: process.env.MARSHAL_APP_PATH } : {}), args: [...(packaged ? [] : [resolve("apps/desktop")]), `--user-data-dir=${directory}`], env });
  const page = await application.firstWindow(); await page.getByText("核心已连接", { exact: true }).waitFor();
  let account;
  for (let i = 0; i < 180; i++) { account = await page.evaluate(async () => (await window.desktopApi.listCloudAccounts()).find((a) => a.status === "READY")); if (account) break; await delay(250); }
  if (!account) throw new Error();
  const root = join(data, "subscription-" + randomUUID()); await mkdir(root);
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, root);
  await page.getByRole("link", { name: "云端网盘", exact: true }).click(); await page.getByRole("button", { name: "选择下载目录", exact: true }).click();
  await page.locator(".cloud-account-select").filter({ hasText: account.name }).first().click();
  for (let index = 0; index < parts.length - 1; index++) {
    const action = index === parts.length - 2 ? "预览" : "打开", button = page.getByRole("button", { name: `${action} ${parts[index]}`, exact: true });
    for (let count = 0; count < 1000 && !await button.count(); count++) {
      if (await page.getByText("正在读取目录…", { exact: true }).count()) { await delay(100); continue; }
      const more = page.getByRole("button", { name: "加载更多", exact: true }); if (!await more.count()) throw new Error(); await more.click(); await delay(200);
    }
    await button.click();
  }
  await page.getByLabel("下载方式").selectOption("subscription"); await page.getByLabel("精确文件名过滤").fill(parts.at(-1));
  await page.getByLabel("扫描间隔").selectOption("60");
  const before = await page.evaluate(() => window.desktopApi.listDownloads({ page: 1, pageSize: 100 }));
  await page.getByRole("button", { name: "预览下载范围", exact: true }).click(); await page.getByText(/完整范围：1 个文件/).waitFor({ timeout: 60000 });
  if ((await page.evaluate(() => window.desktopApi.listDownloads({ page: 1, pageSize: 100 }))).total !== before.total) throw new Error();
  const begin = Date.now(); await page.getByRole("button", { name: "确认启用订阅", exact: true }).click(); await page.getByRole("heading", { name: "目录订阅", exact: true }).waitFor();
  let sub;
  for (let i = 0; i < 2400; i++) {
    sub = await page.evaluate(async () => (await window.desktopApi.listCloudSubscriptions({ page: 1, pageSize: 25 })).items[0]);
    const job = sub?.lastResult?.jobId ? await page.evaluate(async (id) => (await window.desktopApi.listDownloads({ page: 1, pageSize: 100 })).items.find((j) => j.id === id), sub.lastResult.jobId) : null;
    if (job?.state === "COMPLETED") break;
    if (sub && ["FAILED", "AUTH_REQUIRED", "BLOCKED_LOCAL", "RESELECT_REQUIRED"].includes(sub.state)) throw new Error();
    if (job && ["FAILED", "AUTH_REQUIRED", "BLOCKED_LOCAL", "RECONCILING"].includes(job.state)) throw new Error();
    if (i === 2399) throw new Error(); if (i % 80 === 0) console.log(JSON.stringify({ phase: "subscription-download", state: sub?.state, bytes: job?.progress.bytes ?? 0 })); await delay(250);
  }
  const durationMs = Date.now() - begin, file = join(root, "completed", ...parts), size = (await stat(file)).size, hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk); const localSha256 = hash.digest("hex");
  if (size !== 604951500 || localSha256 !== "01663a977dc49a136db3f257113a3125b0de00358c54406a28d2991f75abb503") throw new Error();
  const subId = sub.id, jobsBefore = (await page.evaluate(() => window.desktopApi.listDownloads({ page: 1, pageSize: 100 }))).total;
  await page.getByRole("button", { name: "立即扫描", exact: true }).first().click();
  for (let i = 0; i < 240; i++) { const value = await page.evaluate(async (id) => (await window.desktopApi.listCloudSubscriptions({})).items.find((s) => s.id === id), subId); if (value?.lastResult?.reused === 1 && value.state === "IDLE") break; if (i === 239) throw new Error(); await delay(250); }
  if ((await page.evaluate(() => window.desktopApi.listDownloads({}))).total !== jobsBefore) throw new Error();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 640));
  if (!await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)) throw new Error();
  await mkdir("test-results/sidecars", { recursive: true }); await page.screenshot({ path: "test-results/sidecars/quark-subscription-completed.png" });
  await page.getByRole("button", { name: "暂停订阅", exact: true }).first().click();
  await page.reload(); await page.evaluate(() => window.desktopApi.restartCore());
  let restored;
  for (let i = 0; i < 120; i++) { restored = await page.evaluate(async (id) => (await window.desktopApi.listCloudSubscriptions({})).items.find((s) => s.id === id), subId).catch(() => null); if (restored?.state === "PAUSED") break; await delay(250); }
  if (restored?.state !== "PAUSED" || restored.configurationVersion !== 1) throw new Error();
  const report = { target: `${process.platform}-${process.arch}`, packaged, size, localSha256, durationMs, firstScopeConfirmed: true, literalNameFilterOnlyApprovedFile: true, directoryLayoutVerified: true, incrementalLocalEvidenceReused: true, rescanCreatedNoDuplicateJob: true, pauseRetainedAfterReloadAndCoreRestart: true, minimumWindowNoHorizontalOverflow: true, remoteEvidence: "weak", endToEndDigestClaimed: false, signed: false };
  await writeFile("test-results/sidecars/quark-subscriptions.json", JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report));
} catch { console.log("真实订阅验收未通过；原始错误、路径和凭据未输出。"); process.exitCode = 1; }
finally { await application?.close().catch(() => {}); }
