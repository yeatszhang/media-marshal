import { test, expect, _electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let application: ElectronApplication;
let directory: string;
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marshal-quark-login-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${join(directory, "data")}`], env });
  await mkdir("test-results/desktop", { recursive: true });
  const window = await application.firstWindow();
  await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  // 用同源 HTTPS 固定响应隔离网络；所有 Electron 窗口、Session 和 IPC 仍使用真实实现。
  await application.evaluate(({ app }) => {
    app.on("browser-window-created", (_event, login) => {
      if (!login.getParentWindow()) return;
      const isolated = login.webContents.session;
      (globalThis as any).quarkLoginSessions ??= [];
      (globalThis as any).quarkLoginSessions.push(isolated);
      isolated.protocol.handle("https", () => new Response('<!doctype html><html lang="zh"><meta charset="utf-8"><title>夸克登录测试页</title><body><h1>夸克登录测试页</h1><p>此固定页面用于验证登录窗口生命周期，不包含真实账号。</p></body></html>', { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    });
  });
  await window.getByRole("link", { name: "网盘账号", exact: true }).click();
  await window.getByRole("button", { name: "连接夸克账号", exact: true }).click();
  await window.getByRole("textbox", { name: "账号名称", exact: true }).fill("扫码窗口测试");
});
test.afterEach(async () => {
  await application?.close().catch(() => {});
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("扫码默认入口、真实沙盒窗口、取消与重载清理", async () => {
  const window = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640));
  await expect(window.locator('input[type="password"]')).toHaveCount(0);
  expect(await window.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await window.screenshot({ path: "test-results/desktop/quark-scan-default.png" });
  const opened = application.waitForEvent("window");
  await window.getByRole("button", { name: "打开扫码登录", exact: true }).click();
  const login = await opened;
  await expect(login.getByRole("heading", { name: "夸克登录测试页" })).toBeVisible();
  expect(login.url()).toBe("https://pan.quark.cn/");
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const child = BrowserWindow.getAllWindows().find((item) => !!item.getParentWindow())!;
    const value = child.webContents.getLastWebPreferences();
    return { sandbox: value.sandbox, contextIsolation: value.contextIsolation, nodeIntegration: value.nodeIntegration, preload: value.preload, storagePath: child.webContents.session.storagePath };
  });
  expect(preferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, storagePath: null });
  expect(preferences.preload).toBeFalsy();
  expect(await login.evaluate(() => ({ require: typeof (window as any).require, api: typeof (window as any).desktopApi }))).toEqual({ require: "undefined", api: "undefined" });
  await expect(window.getByRole("button", { name: "打开扫码登录", exact: true })).toBeDisabled();
  await window.getByRole("button", { name: "取消扫码", exact: true }).click();
  await expect.poll(() => application.windows().length).toBe(1);
  expect(await window.evaluate(() => window.desktopApi.listCloudAccounts())).toEqual([]);
  const reopened = application.waitForEvent("window");
  await window.getByRole("button", { name: "打开扫码登录", exact: true }).click(); await reopened;
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((item) => !!item.getParentWindow())!.close());
  await expect(window.getByRole("button", { name: "打开扫码登录", exact: true })).toBeEnabled();
  const reloadLogin = application.waitForEvent("window");
  await window.getByRole("button", { name: "打开扫码登录", exact: true }).click(); await reloadLogin;
  await window.reload();
  await expect.poll(() => application.windows().length).toBe(1);
  const cleared = await application.evaluate(async () => {
    const sessions = (globalThis as any).quarkLoginSessions as Electron.Session[];
    return Promise.all(sessions.map(async (isolated) => (await isolated.cookies.get({})).length));
  });
  expect(cleared).toEqual([0, 0, 0]);
});

test("扫码登录态直接交给 Main 授权链，公开响应与默认会话不包含凭据", async () => {
  const window = await application.firstWindow(), requestKey = crypto.randomUUID();
  const opened = application.waitForEvent("window");
  const result = window.evaluate((requestKey) => window.desktopApi.loginCloudAccount({ name: "自动获取测试", requestKey }), requestKey);
  const login = await opened;
  await expect(login.getByRole("heading", { name: "夸克登录测试页" })).toBeVisible();
  await application.evaluate(async ({ BrowserWindow }) => {
    const isolated = BrowserWindow.getAllWindows().find((item) => !!item.getParentWindow())!.webContents.session;
    await isolated.cookies.set({ url: "https://pan.quark.cn/", name: "__pus", value: "fixture-private-pus", httpOnly: true, secure: true });
    await isolated.cookies.set({ url: "https://pan.quark.cn/", name: "__puus", value: "fixture-private-puus", httpOnly: true, secure: true });
  });
  const job = await result;
  expect(job).toMatchObject({ requestKey, state: "RUNNING" });
  expect(JSON.stringify(job)).not.toContain("fixture-private");
  await expect.poll(() => application.windows().length).toBe(1);
  const cookies = await application.evaluate(async ({ session }) => ({
    defaultCount: (await session.defaultSession.cookies.get({ url: "https://pan.quark.cn/" })).length,
    loginCount: (await (globalThis as any).quarkLoginSessions[0].cookies.get({})).length,
  }));
  expect(cookies).toEqual({ defaultCount: 0, loginCount: 0 });
  const accounts = await window.evaluate(() => window.desktopApi.listCloudAccounts());
  expect(accounts).toHaveLength(1); expect(accounts[0]!.name).toBe("自动获取测试");
  expect(JSON.stringify(accounts)).not.toContain("fixture-private");
  // 测试凭据不代表真实账号验证成功；此处只核验提交和公开边界。
});
