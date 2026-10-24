import {
  test,
  expect,
  _electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { resolve, join } from "node:path";
const occupied: Server[] = [];
test.beforeAll(async () => {
  for (const port of [8000, 8080]) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve();
        else reject(error);
      });
      server.listen(port, "127.0.0.1", () => {
        occupied.push(server);
        resolve();
      });
    });
  }
});
test.afterAll(async () => {
  await Promise.all(
    occupied.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});
let application: ElectronApplication;
let directory: string;
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marshal-electron-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    executablePath: process.env.MARSHAL_EXECUTABLE
      ? process.env.MARSHAL_APP_PATH
      : undefined,
    args: [
      ...(process.env.MARSHAL_EXECUTABLE
        ? []
        : [process.env.MARSHAL_APP_PATH ?? resolve("apps/desktop")]),
      `--user-data-dir=${join(directory, "data")}`,
    ],
    env,
  });
});
test.afterEach(async () => {
  if (application) await application.close().catch(() => {});
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("真实窗口、核心握手与沙盒边界", async () => {
  const window = await application.firstWindow();
  await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await expect(
    window.getByRole("heading", { name: "让好内容，回到你的媒体库。" }),
  ).toBeVisible();
  const preferences = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences(),
  );
  expect(preferences.sandbox).toBe(true);
  expect(preferences.contextIsolation).toBe(true);
  expect(preferences.nodeIntegration).toBe(false);
  expect(await window.evaluate(() => typeof (window as any).require)).toBe(
    "undefined",
  );
  expect(
    await window.evaluate(() => Object.keys(window.desktopApi)),
  ).not.toContain("invoke");
  const runtime = await window.evaluate(() => window.desktopApi.getRuntime());
  expect(runtime.status?.schemaVersion).toBe(2);
  expect(
    await window.evaluate(async () => {
      try {
        await window.desktopApi.saveSettings({
          language: "zh-CN",
          embyUrl: "",
          tmdbProxy: "",
          sql: "DROP TABLE app_setting",
        } as any);
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  await window.screenshot({ path: "test-results/desktop/overview.png" });
});
test("原生目录桥授权、来源持久化与核心重启", async () => {
  const window = await application.firstWindow();
  await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const source = join(directory, "网盘下载目录_长中文路径_".repeat(4)),
    target = join(directory, "媒体库目录_长中文路径_".repeat(4));
  await mkdir(source);
  await mkdir(target);
  // 这里只验证桥接与界面；原生对话框仍需目标系统实测。
  await application.evaluate(
    ({ dialog }, paths) => {
      let call = 0;
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [paths[call++]!],
      })) as typeof dialog.showOpenDialog;
    },
    [source, target],
  );
  await window.getByRole("link", { name: "来源", exact: true }).click();
  await window.getByRole("button", { name: "添加来源", exact: true }).click();
  await window.getByLabel("来源名称").fill("内测下载目录");
  await window
    .getByRole("button", { name: "选择目录", exact: true })
    .nth(0)
    .click();
  await window
    .getByRole("button", { name: "选择目录", exact: true })
    .nth(1)
    .click();
  await window.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    window.getByRole("heading", { name: /内测下载目录/ }),
  ).toBeVisible();
  await window.evaluate(() => window.desktopApi.restartCore());
  await expect
    .poll(() =>
      window.evaluate(
        async () => (await window.desktopApi.listSources()).length,
      ),
    )
    .toBe(1);
  await window.reload();
  await expect(
    window.getByRole("heading", { name: /内测下载目录/ }),
  ).toBeVisible();
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(920,640));
  expect(await window.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await expect(window.getByRole('button',{name:'暂停来源',exact:true})).toBeInViewport();
  await window.screenshot({ path: "test-results/desktop/sources.png" });
});

test("主进程异常退出后核心不成为孤儿写入者", async () => {
  const window = await application.firstWindow();
  await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const pid = await application.evaluate(
    ({ app }) =>
      app.getAppMetrics().find((metric) => metric.name === "Media Marshal Core")
        ?.pid,
  );
  expect(pid).toBeTruthy();
  application.process().kill("SIGKILL");
  const alive = () => {
    try {
      process.kill(pid!, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await expect.poll(alive, { timeout: 10000 }).toBe(false);
  } finally {
    if (alive()) process.kill(pid!, "SIGKILL");
  }
});

test("最小窗口下键盘取消新增来源恢复焦点", async () => {
  const window = await application.firstWindow();
  await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setSize(920, 640),
  );
  await window.getByRole("link", { name: "来源", exact: true }).click();
  const add = window.getByRole("button", { name: "添加来源", exact: true });
  await add.focus();
  await window.keyboard.press("Enter");
  await expect(window.getByLabel("来源名称")).toBeFocused();
  await window
    .getByLabel("来源名称")
    .fill("下载目录与媒体库的中文名称用于最小窗口交互验证");
  await window.keyboard.press("Escape");
  await expect(add).toBeFocused();
  expect(
    await window.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await window.screenshot({ path: "test-results/desktop/minimum-window.png" });
});
