import { expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchDesktop } from "./support/test-electron";

let application: ElectronApplication, directory: string;
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marshal-presentation-"));
  application = await launchDesktop(resolve("."), {
    dataDir: join(directory, "data"),
    mode: process.env.MARSHAL_E2E_MODE === "foreground" ? "foreground" : "background",
    target: process.env.MARSHAL_EXECUTABLE ? "packaged" : "development",
  });
});
test.afterEach(async () => {
  await application?.close().catch(() => {});
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("E2E 呈现模式覆盖启动、显示请求、窗口重建及真实页面截图", async () => {
  const background = process.env.MARSHAL_E2E_MODE === "background";
  let page = await application.firstWindow();
  await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  const presentation = () =>
    application.evaluate(({ BrowserWindow, app }) => ({
      windows: BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused(),
        focusable: window.isFocusable(),
        throttled: window.webContents.getBackgroundThrottling(),
      })),
      dock: process.platform === "darwin" ? app.dock?.isVisible() : null,
    }));
  const check = async () => {
    const state = await presentation();
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0]).toMatchObject({
      visible: !background,
      focusable: !background,
      throttled: !background,
    });
    if (background) {
      expect(state.windows[0]!.focused).toBe(false);
      if (process.platform === "darwin") expect(state.dock).toBe(false);
    }
  };
  await check();
  await application.evaluate(({ Menu, BrowserWindow }) => {
    const item = Menu.getApplicationMenu()!.items[0]!.submenu!.items.find(
      (item) => item.label === "显示主窗口",
    )!;
    item.click();
    BrowserWindow.getAllWindows()[0]!.setSize(920, 640);
  });
  await page.reload();
  await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  await check();
  const screenshot = await page.screenshot({
    path: `test-results/desktop/presentation-${background ? "background" : "foreground"}.png`,
  });
  expect(screenshot.byteLength).toBeGreaterThan(2000);
  const reopened = application.waitForEvent("window");
  await application.evaluate(({ BrowserWindow, app }) => {
    BrowserWindow.getAllWindows()[0]!.destroy();
    app.emit("activate");
  });
  page = await reopened;
  await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  await check();
  await writeFile(
    "test-results/desktop/presentation-mode.json",
    JSON.stringify({
      mode: background ? "background" : "foreground",
      ...(await presentation()),
      screenshotBytes: screenshot.byteLength,
    }),
  );
});
