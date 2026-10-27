// 真实账号验收工具；仅开发机使用，Chrome 和 Cookie 都不进入产品依赖。
import { chromium, _electron } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

if (!process.stdin.isTTY) { console.log("请使用保留 stdin 的交互终端启动本验收工具。"); process.exit(1); }
const directory = await mkdtemp(join(tmpdir(), "marshal-quark-desktop-"));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let application, browser, context, page, closing = false, checking = false;
const input = createInterface({ input: process.stdin });
const close = async () => {
  if (closing) return; closing = true;
  clearInterval(timer); input.close();
  await application?.close().catch(() => {}); await browser?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
};
const timer = setInterval(async () => {
  if (!context || checking || closing) return; checking = true;
  try { const cookies = await context.cookies("https://pan.quark.cn/"); if (cookies.some((value) => value.name === "__pus") && cookies.some((value) => value.name === "__puus")) { clearInterval(timer); console.log("已检测到独立夸克登录会话，等待只读验收指令。"); } }
  catch {} finally { checking = false; }
}, 1500);
try {
  application = await _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${directory}`], env });
  page = await application.firstWindow(); await page.getByText("核心已连接", { exact: true }).waitFor();
  await page.getByRole("link", { name: "云端网盘", exact: true }).click();
  const proxyValue = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  browser = await chromium.launch({ channel: "chrome", headless: false, ...(proxyValue ? { proxy: { server: new URL(proxyValue).origin } } : {}) });
  context = await browser.newContext({ acceptDownloads: false });
  const login = await context.newPage(); await login.goto("https://pan.quark.cn/", { waitUntil: "domcontentloaded", timeout: 30000 }); await login.bringToFront();
  console.log("已打开独立 Chrome 夸克登录窗口和真实 Mac 客户端。请扫码；Cookie 不会打印或写入聊天。");
} catch { console.log("登录验收窗口初始化失败。"); await close(); process.exitCode = 1; }

let verifying = false;
input.on("line", async (line) => {
  try {
    const command = JSON.parse(line);
    if (command.action === "close") return void close();
    if (command.action !== "verify" || verifying || typeof command.remotePath !== "string" || closing) return;
    const segments = command.remotePath.split("/").filter(Boolean);
    if (!segments.length || segments.length > 128 || segments.some((part) => part === "." || part === ".." || part.length > 1024)) throw new Error();
    verifying = true;
    let cookies = await context.cookies("https://pan.quark.cn/");
    if (!["__pus", "__puus"].every((name) => cookies.some((entry) => entry.name === name))) { console.log("尚未检测到登录，请在独立 Chrome 窗口完成扫码。"); return; }
    let cookie = cookies.map((value) => `${value.name}=${value.value}`).join("; "); cookies = [];
    const job = await page.evaluate((value) => window.desktopApi.authorizeCloudAccount({ name: "夸克真实联调", cookie: value, requestKey: crypto.randomUUID() }), cookie); cookie = undefined;
    const deadline = Date.now() + 45000; let authorization;
    while (Date.now() < deadline) {
      authorization = await page.evaluate((key) => window.desktopApi.getCloudAuthorization(key), job.requestKey);
      if (authorization && authorization.state !== "RUNNING") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (authorization?.state !== "SUCCEEDED") { console.log(JSON.stringify({ authorized: false, failure: authorization?.failure?.code ?? "TIMEOUT" })); return; }
    const result = await page.evaluate(async ({ accountId, segments }) => {
      const account = (await window.desktopApi.listCloudAccounts()).find((value) => value.id === accountId);
      if (!account?.rootRef) throw new Error("AUTH_REQUIRED");
      let ref = account.rootRef;
      for (const name of segments) {
        let cursor = null, match;
        for (let count = 0; count < 2000; count++) {
          const page = await window.desktopApi.listRemote({ accountId, parentRef: ref, cursor, pageSize: 100 });
          match = page.items.find((item) => item.name === name);
          if (match || page.complete) break;
          if (!page.nextCursor) throw new Error("INCOMPLETE"); cursor = page.nextCursor;
        }
        if (!match) throw new Error("REMOTE_NOT_FOUND"); ref = match.ref;
      }
      const entry = await window.desktopApi.statRemote(accountId, ref);
      return { ref, size: entry.size, type: entry.type, versionKind: entry.version?.kind ?? "unavailable", objectIdentity: account.capabilities?.objectIdentity, accountIdentity: account.capabilities?.accountIdentity };
    }, { accountId: job.accountId, segments });
    await page.evaluate(() => window.desktopApi.restartCore());
    let recovered = false;
    for (let count = 0; count < 160; count++) {
      const state = await page.evaluate(async (accountId) => (await window.desktopApi.listCloudAccounts()).find((value) => value.id === accountId)?.status, job.accountId).catch(() => null);
      if (state === "READY") {
        const metadata = await page.evaluate(({ accountId, ref }) => window.desktopApi.statRemote(accountId, ref), { accountId: job.accountId, ref: result.ref });
        recovered = metadata.size === result.size; break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const report = { target: `${process.platform}-${process.arch}`, scope: "真实客户端 Main/保险箱/Core/Host/OpenList，只读账号、目录、元数据与重启重建；不代表文件下载完成", authorized: true, browseAndStat: true, restartRebuiltMountAndReferences: recovered, size: result.size, type: result.type, versionKind: result.versionKind, objectIdentity: result.objectIdentity, accountIdentity: result.accountIdentity };
    await mkdir("test-results/sidecars", { recursive: true }); await writeFile("test-results/sidecars/quark-desktop.json", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    await page.reload(); await page.getByText("核心已连接", { exact: true }).waitFor();
    console.log(JSON.stringify(report));
  } catch { console.log("真实客户端验收未通过；错误内容未打印以保护路径与凭据。"); }
  finally { verifying = false; }
});
input.on("close", () => { void close(); });
process.on("SIGINT", () => { void close(); });
