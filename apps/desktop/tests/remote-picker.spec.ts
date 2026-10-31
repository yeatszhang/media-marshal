import { expect, test, _electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("远端目录加载、失败重试与范围选择在最小窗口可操作", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marshal-remote-picker-"));
  let application: ElectronApplication | undefined;
  try {
    // 仅在本次测试启动入口替换网盘读取；其余宿主、Preload 和 Renderer 使用正式构建。
    const bootstrap = join(directory, "bootstrap.cjs"), appPath = resolve("apps/desktop");
    await writeFile(bootstrap, `
      const { app, ipcMain } = require("electron");
      const { randomUUID } = require("node:crypto");
      app.setAppPath(${JSON.stringify(appPath)});
      const account = { id: randomUUID(), rootRef: randomUUID(), name: "隔离网盘账号", status: "READY", providerKind: "quark", capabilities: null };
      const entry = { accountId: account.id, ref: randomUUID(), parentRef: account.rootRef, name: "测试远端目录", type: "directory", size: null, modifiedAt: null, version: null };
      const state = globalThis.remotePickerFixture = { calls: 0, active: false, finish: null, fail: true };
      const handle = ipcMain.handle.bind(ipcMain);
      ipcMain.handle = (channel, listener) => handle(channel, async (event, input) => {
        if (channel !== "media-marshal:desktop:v1") return listener(event, input);
        const success = (result) => ({ protocolVersion: 1, requestId: input.requestId, ok: true, result });
        const failure = (code, message) => ({ protocolVersion: 1, requestId: input.requestId, ok: false, error: { code, message, retryable: true } });
        if (input.action === "cloud.accounts.list") return success([account]);
        if (input.action === "cloud.remote.stat") return success(entry);
        if (input.action !== "cloud.remote.list") return listener(event, input);
        state.calls++;
        if (state.active) return failure("CONFLICT", "操作存在冲突，请查询当前状态");
        state.active = true;
        await new Promise((done) => { state.finish = done; });
        state.active = false; state.finish = null;
        if (state.fail) { state.fail = false; return failure("NETWORK_UNAVAILABLE", "网络暂不可用"); }
        return success({ items: [entry], nextCursor: null, total: 1, complete: true });
      });
      require(${JSON.stringify(join(appPath, "out/main/index.js"))});
    `);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ args: [bootstrap, `--user-data-dir=${join(directory, "data")}`], env });
    const page = await application.firstWindow();
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640));
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "来源", exact: true }).click();
    await page.getByRole("button", { name: "添加同步来源", exact: true }).click();
    await page.getByLabel("来源类型", { exact: true }).selectOption("cloud");
    await page.getByLabel("网盘账号", { exact: true }).selectOption({ label: "隔离网盘账号 · 可用" });
    await page.getByRole("button", { name: "选择远端范围", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择远端文件或目录", exact: true });
    await expect(dialog.getByRole("status")).toContainText("正在核对");
    expect(await application.evaluate(() => (globalThis as any).remotePickerFixture.calls)).toBe(1);
    await application.evaluate(() => (globalThis as any).remotePickerFixture.finish());
    await expect(dialog.getByRole("alert")).toContainText("读取账号「隔离网盘账号」的目录「网盘根目录」失败：网络暂不可用");
    await page.screenshot({ path: "test-results/desktop/remote-picker-error-920.png" });
    await dialog.getByRole("button", { name: "重试", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("正在核对");
    expect(await application.evaluate(() => (globalThis as any).remotePickerFixture.calls)).toBe(2);
    await application.evaluate(() => (globalThis as any).remotePickerFixture.finish());
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.getByRole("status")).toContainText("共 1 项");
    await page.screenshot({ path: "test-results/desktop/remote-picker-success-920.png" });
    await dialog.getByRole("button", { name: "选择范围 测试远端目录", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("region", { name: "同步来源表单", exact: true })).toContainText("测试远端目录");
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
