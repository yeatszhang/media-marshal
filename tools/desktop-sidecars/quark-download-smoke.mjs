// 复用本工具链已登录的临时客户端；不读取或导出 Cookie，不用于生产入口。
import { _electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, stat, writeFile, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep, dirname, basename } from "node:path";
const run = promisify(execFile), delay = (ms) => new Promise((done) => setTimeout(done, ms));
const sourceDirectory = process.argv[2], oldPid = Number(process.argv[3]), remotePath = process.argv[4];
let application, proxy, step = "validate-profile";
try {
  const data = await realpath(sourceDirectory), temporary = await realpath(tmpdir()), workspaceApp = resolve("apps/desktop");
  if (!data.startsWith(temporary + sep + "marshal-quark-desktop-") || !Number.isInteger(oldPid) || oldPid < 0 || !remotePath?.startsWith("/")) throw new Error();
  if (oldPid) {
  const oldCommand = (await run("/bin/ps", ["-p", String(oldPid), "-o", "command="])).stdout;
  if (!oldCommand.includes(workspaceApp) || !oldCommand.includes(`--user-data-dir=${sourceDirectory}`) || oldCommand.includes("--type=")) throw new Error();
  const addresses = (await run("/usr/sbin/lsof", ["-a", "-p", String(oldPid), "-iTCP", "-sTCP:LISTEN", "-Fn"])).stdout;
  let inspector;
  for (const port of [...addresses.matchAll(/^nlocalhost:(\d+)$/gm)].map((match) => match[1])) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => []);
    inspector = targets.find((target) => target.type === "node")?.webSocketDebuggerUrl;
    if (inspector) break;
  }
  if (!inspector || !/^ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+$/.test(inspector)) throw new Error();
  await new Promise((done, fail) => {
    const socket = new WebSocket(inspector), timer = setTimeout(() => { socket.close(); fail(new Error()); }, 10000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').app.quit()" } })));
    socket.addEventListener("message", (event) => { const result = JSON.parse(String(event.data)); if (result.id === 1) { clearTimeout(timer); socket.close(); if (result.result?.exceptionDetails || result.error) fail(new Error()); else done(); } });
    socket.addEventListener("close", () => { clearTimeout(timer); done(); }); socket.addEventListener("error", fail);
  });
  for (let count = 0; count < 80; count++) { const alive = await run("/bin/ps", ["-p", String(oldPid), "-o", "command="]).then(() => true, () => false); if (!alive) break; if (count === 79) throw new Error(); await delay(250); }
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH; env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  const networkFault = process.env.MARSHAL_NETWORK_FAULT === "1";
  if (networkFault) { proxy = await (await import("./network-fault-proxy.mjs")).networkFaultProxy(); for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) env[name] = proxy.url; env.NO_PROXY = env.no_proxy = "127.0.0.1,localhost"; }
  const packaged = process.env.MARSHAL_EXECUTABLE === "1", coldBegin = Date.now(); let readOnlyInstallVerified = false;
  step = "verify-readonly-install";
  if (process.env.MARSHAL_READ_ONLY_INSTALL === "1") {
    const probe = join(dirname(process.env.MARSHAL_APP_PATH), "../Resources/.marshal-test-" + randomUUID());
    try { await writeFile(probe, "", { flag: "wx" }); await unlink(probe); throw new Error(); }
    catch (error) { if (error.code !== "EROFS") throw error; readOnlyInstallVerified = true; }
  }
  step = "launch"; application = await _electron.launch({ ...(packaged ? { executablePath: process.env.MARSHAL_APP_PATH } : {}), args: [...(packaged ? [] : [workspaceApp]), `--user-data-dir=${sourceDirectory}`], env });
  const page = await application.firstWindow(); await page.getByText("核心已连接", { exact: true }).waitFor();
  step = "restore-account"; const coreReadyMs = Date.now() - coldBegin; let account;
  for (let count = 0; count < 180; count++) { account = await page.evaluate(async () => (await window.desktopApi.listCloudAccounts()).find((value) => ["READY", "RESELECT_REQUIRED"].includes(value.status))); if (account) break; await delay(250); }
  if (!account) throw new Error();
  const accountRestoreMs = Date.now() - coldBegin;
  console.log(JSON.stringify({ credentialRestored: true, freshBuild: true }));
  step = "authorize-root"; const root = join(data, packaged ? "whole-file-download-" + randomUUID() : "whole-file-download"); await mkdir(root, { recursive: true });
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, root);
  await page.getByRole("link", { name: "云端网盘", exact: true }).click(); await page.getByRole("button", { name: "选择下载目录", exact: true }).click();
  await page.getByText(await realpath(root), { exact: true }).waitFor();
  await page.locator(".cloud-account-select").filter({ hasText: account.name }).first().click();
  step = "browse"; const segments = remotePath.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    const name = segments[index], action = index < segments.length - 1 ? "打开" : "预览", button = page.getByRole("button", { name: `${action} ${name}`, exact: true });
    for (let count = 0; count < 2000; count++) {
      if (await button.count()) break;
      if (await page.getByText("正在读取目录…", { exact: true }).count()) { await delay(100); continue; }
      const more = page.getByRole("button", { name: "加载更多", exact: true }); if (!await more.count()) throw new Error(); await more.click(); await delay(200);
    }
    await button.click();
  }
  step = "preview"; await page.getByRole("button", { name: "预览下载范围", exact: true }).click();
  await page.getByText(/完整范围：1 个文件/).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "确认下载", exact: true }).click(); await page.getByRole("heading", { name: "云端下载", exact: true }).waitFor();
  await mkdir("test-results/sidecars", { recursive: true }); await page.screenshot({ path: "test-results/sidecars/quark-download-running.png" });
  step = "download"; let job, faultInjected = false, boundedFailure = null, recoveredAfterNetwork = false; const begin = Date.now(), metrics = [];
  const sample = async () => {
    const labels = new Map(await application.evaluate(({ app }) => app.getAppMetrics().map((metric) => [metric.pid, metric.serviceName === "Media Marshal Core" || metric.name === "Media Marshal Core" ? "Core" : metric.serviceName === "Media Marshal Sidecar Host" || metric.name === "Media Marshal Sidecar Host" ? "Host" : metric.type === "Browser" ? "Main" : metric.type === "Tab" ? "Renderer" : metric.type])));
    const rows = (await run("/bin/ps", ["-axo", "pid=,ppid=,rss=,%cpu=,comm="], { env: { ...env, LC_ALL: "C" } })).stdout.trim().split("\n").map((line) => { const [pid, ppid, rssKiB, cpuPercent, ...path] = line.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), rssKiB: Number(rssKiB), cpuPercent: Number(cpuPercent), name: basename(path.join(" ")) }; });
    const owned = new Set([application.process().pid]); let changed = true;
    while (changed) { changed = false; for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
    const processes = rows.filter((row) => owned.has(row.pid)).map(({ pid, name, rssKiB, cpuPercent }) => ({ role: /^(rclone|openlist|guardian)$/.test(name) ? name : labels.get(pid) ?? "Electron辅助进程", rssKiB, cpuPercent }));
    metrics.push({ elapsedMs: Date.now() - begin, processes, rssSumKiB: processes.reduce((sum, row) => sum + row.rssKiB, 0), cpuSumPercent: processes.reduce((sum, row) => sum + row.cpuPercent, 0) });
  };
  for (let count = 0; count < 2400; count++) {
    if (count % 4 === 0) await sample();
    job = await page.evaluate(async () => (await window.desktopApi.listDownloads({ page: 1, pageSize: 25 })).items[0]);
    if (networkFault && !faultInjected && job?.state === "RUNNING" && job.progress.bytes > 0) { proxy.cut(); faultInjected = true; console.log(JSON.stringify({ networkCutOnlyForOwnedClient: true })); }
    if (networkFault && faultInjected && !boundedFailure && job?.state === "FAILED") {
      boundedFailure = job.failure?.code ?? "INTERNAL_ERROR"; console.log(JSON.stringify({ networkFailureState: job.state, failure: boundedFailure })); if (!["NETWORK_UNAVAILABLE", "COMPONENT_UNAVAILABLE"].includes(boundedFailure)) throw new Error(); proxy.restore(); await page.evaluate((jobId) => window.desktopApi.controlDownload({ jobId, operation: "retry", requestKey: crypto.randomUUID() }), job.id); recoveredAfterNetwork = true; continue;
    }
    if (job?.state === "COMPLETED") break;
    if (job && ["FAILED", "AUTH_REQUIRED", "BLOCKED_LOCAL", "RECONCILING"].includes(job.state)) { console.log(JSON.stringify({ completed: false, state: job.state, failure: job.failure?.code, bytes: job.progress.bytes })); throw new Error(); }
    if (count % 20 === 0) console.log(JSON.stringify({ state: job?.state, bytes: job?.progress.bytes, totalBytes: job?.progress.totalBytes }));
    await delay(250);
  }
  if (job?.state !== "COMPLETED" || (networkFault && (!faultInjected || !boundedFailure || !recoveredAfterNetwork))) throw new Error();
  const elapsedMs = Date.now() - begin, file = join(root, "completed", segments.at(-1)), info = await stat(file), hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk); const localSha256 = hash.digest("hex");
  if (info.size !== job.progress.totalBytes || info.size <= 0) throw new Error();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 640));
  if (!await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)) throw new Error();
  await page.screenshot({ path: "test-results/sidecars/quark-download-completed.png" });
  await page.reload(); await page.getByText("核心已连接", { exact: true }).waitFor();
  await page.evaluate(() => window.desktopApi.restartCore());
  let restored;
  for (let count = 0; count < 160; count++) { restored = await page.evaluate(async (id) => (await window.desktopApi.listDownloads({ page: 1, pageSize: 25 })).items.find((value) => value.id === id), job.id).catch(() => null); if (restored?.state === "COMPLETED") break; await delay(250); }
  if (restored?.state !== "COMPLETED") throw new Error();
  const runtime = await page.evaluate(() => window.desktopApi.getRuntime());
  const report = { appVersion: runtime.appVersion, schemaVersion: runtime.status?.schemaVersion, ...(networkFault ? { scopedProxyCut: true, boundedFailure, explicitRetryAfterNetworkRestored: recoveredAfterNetwork, operatingSystemNetworkChanged: false } : {}), target: `${process.platform}-${process.arch}`, packaged, readOnlyInstallVerified, developerToolsExcludedFromAppPath: true, scope: "真实 Main/系统保险箱/Core/Host/OpenList/Rclone，窗口范围预览与确认、完整文件校验提交、重载与 Core 重启", wholeFileDownloaded: true, size: info.size, localSha256, remoteEvidence: "weak", endToEndDigestClaimed: false, membership: "user-declared-vip", durationMs: elapsedMs, coreReadyMs, accountRestoreMs, completedItems: job.progress.completedItems, restoredSameCompletedJob: true, minimumWindowNoHorizontalOverflow: true, signed: false };
  await writeFile(networkFault ? "test-results/sidecars/quark-network.json" : "test-results/sidecars/quark-whole-file.json", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); console.log(JSON.stringify(report));
  await writeFile(networkFault ? "test-results/sidecars/quark-network-metrics.json" : "test-results/sidecars/quark-process-metrics.json", JSON.stringify({ target: report.target, packaged, note: "单次实测；ps CPU 为系统观测口径，RSS 合计可能重复包含共享页，不等同独占物理内存。", metrics }, null, 2) + "\n", { mode: 0o600 });
} catch (error) { console.log(JSON.stringify({ passed: false, step, code: ["ENOENT", "EACCES", "EROFS", "EPERM", "EIO", "ETIMEDOUT"].includes(error?.code) ? error.code : null, detail: "真实整文件验收未通过；原始错误、路径和凭据未打印。" })); process.exitCode = 1; }
finally { await application?.close().catch(() => {}); await proxy?.close(); }
