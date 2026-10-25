import {
  test,
  expect,
  _electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { CORE_DATA_SCHEMA_VERSION } from "@media-marshal/contracts/internal/core";
const { identify, matches, stopVerified, children } = createRequire(resolve("package.json"))(resolve("tools/desktop-sidecars/process-identity.cjs"));
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
test("服务密钥经系统保险箱注入，窗口重载和核心重启后恢复且查询与命令行不回显", async () => {
  const secret = "fixture-service-private-key", requests: string[] = [];
  const server = createHttpServer((req, res) => {
    requests.push(req.headers["x-emby-token"] as string);
    if (req.headers["x-emby-token"] !== secret) { res.writeHead(401).end(); return; }
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/System/Info")) res.end(JSON.stringify({ Id: "fixture-server", Version: "4.9-fixture" }));
    else if (req.url?.startsWith("/Library/VirtualFolders/Query")) res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
    const address = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    await window.evaluate(async ({ address, secret }) => { await window.desktopApi.saveSettings({ language: "zh-CN", embyUrl: address, tmdbProxy: "" }); await window.desktopApi.saveCredential("emby", secret); }, { address, secret });
    const read = () => window.evaluate(async () => { try { return (await window.desktopApi.listEmbyLibraries()).serverId; } catch { return "pending"; } });
    await expect.poll(read).toBe("fixture-server");
    await window.reload(); await expect.poll(read).toBe("fixture-server");
    await window.evaluate(() => window.desktopApi.restartCore()); await expect.poll(read).toBe("fixture-server");
    const settings = await window.evaluate(() => window.desktopApi.getSettings()); expect(settings.embyKeyConfigured).toBe(true); expect(JSON.stringify(settings)).not.toContain(secret);
    for (const name of ["desktop.sqlite3", "desktop.sqlite3-wal", "credentials.json"]) { const bytes = await readFile(join(directory, "data", name)).catch(() => Buffer.alloc(0)); expect(bytes.includes(Buffer.from(secret)), name).toBe(false); }
    const pids = await application.evaluate(({ app }) => [process.pid, ...app.getAppMetrics().filter((row) => row.name === "Media Marshal Core").map((row) => row.pid)]);
    expect(pids.length).toBeGreaterThan(1); for (const pid of pids) { const processIdentity = identify(pid); expect(processIdentity).toBeTruthy(); expect(processIdentity.command).not.toContain(secret); }
    expect(requests.length).toBeGreaterThanOrEqual(6); expect(requests.every((value) => value === secret)).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
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
  expect(runtime.status?.schemaVersion).toBe(CORE_DATA_SCHEMA_VERSION);
  expect(runtime.status?.parser).toBe("ready");
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
test("云端全局暂停独立于本地来源，重载与 Core 重启保留状态", async () => {
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await window.getByRole("link", { name: "目录订阅", exact: true }).click();
  await expect(window.getByRole("heading", { name: "还没有目录订阅", exact: true })).toBeVisible();
  await expect(window.getByText(/暂停本地整理不影响云端下载/)).toBeVisible();
  await window.getByRole("link", { name: "云端下载", exact: true }).click();
  await window.getByRole("button", { name: "暂停全部云端下载", exact: true }).click();
  await expect(window.getByRole("button", { name: "恢复全部云端下载", exact: true })).toBeVisible();
  await window.reload(); await window.evaluate(() => window.desktopApi.restartCore());
  await expect.poll(async () => window.evaluate(() => window.desktopApi.getCloudDownloadPause())).toEqual({ paused: true, pausing: false });
  expect(await window.evaluate(() => window.desktopApi.listSources())).toEqual([]);
  await window.getByRole("link", { name: "云端下载", exact: true }).click(); await window.getByRole("button", { name: "恢复全部云端下载", exact: true }).click();
  await expect.poll(async () => window.evaluate(() => window.desktopApi.getCloudDownloadPause())).toEqual({ paused: false, pausing: false });
  await window.screenshot({ path: "test-results/desktop/subscription-pause.png" });
});
test("整包升级停写备份和原生恢复保留现存文件，重开核对数据", async () => {
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await application.evaluate(({ app, dialog }) => { const quit = app.quit.bind(app); app.quit = () => { app.quit = quit; }; dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox; });
  const media = join(directory, "升级保留文件"); await mkdir(media); await (await import("node:fs/promises")).writeFile(join(media, "保留.txt"), "现存文件不随数据库回退");
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog; }, media);
  await window.evaluate(() => window.desktopApi.chooseDownloadRoot());
  await window.evaluate(() => window.desktopApi.saveSettings({ language: "zh-CN", embyUrl: "", tmdbProxy: "http://127.0.0.1:8890" }));
  await window.getByRole("link", { name: "设置", exact: true }).click(); await window.getByRole("button", { name: "准备升级并退出", exact: true }).click();
  const root = join(directory, "data", "private-backups"); let ids: string[] = [];
  await expect.poll(async () => { ids = await readdir(root).catch(() => []); return ids.filter((id) => /^[a-f0-9-]{36}$/.test(id)).length; }).toBe(1);
  const id = ids.find((id) => /^[a-f0-9-]{36}$/.test(id))!, manifest = JSON.parse(await readFile(join(root, id, "manifest.json"), "utf8"));
  expect(manifest.version.schemaVersion).toBe(CORE_DATA_SCHEMA_VERSION); expect(manifest.files.some((file: { path: string }) => file.path === "desktop.sqlite3")).toBe(true); expect(JSON.stringify(manifest.files)).not.toMatch(/completed|staging/);
  await new Promise((done) => setTimeout(done, 200)); await application.close();
  const launchAgain = async () => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ ...(process.env.MARSHAL_EXECUTABLE ? { executablePath: process.env.MARSHAL_APP_PATH } : {}), args: [...(process.env.MARSHAL_EXECUTABLE ? [] : [process.env.MARSHAL_APP_PATH ?? resolve("apps/desktop")]), `--user-data-dir=${join(directory, "data")}`], env });
    const page = await application.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible(); return page;
  };
  const next = await launchAgain(); await next.evaluate(() => window.desktopApi.saveSettings({ language: "zh-CN", embyUrl: "", tmdbProxy: "http://127.0.0.1:8891" }));
  await application.evaluate(({ app, dialog }) => { const quit = app.quit.bind(app); app.quit = () => { app.quit = quit; }; dialog.showMessageBox = (async (options: any) => ({ response: options.title === "确认恢复并退出" ? 1 : 0, checkboxChecked: false })) as typeof dialog.showMessageBox; });
  await next.evaluate(() => window.desktopApi.restoreDesktopUpgrade()); await new Promise((done) => setTimeout(done, 200)); await application.close();
  const restored = await launchAgain(); expect((await restored.evaluate(() => window.desktopApi.getSettings())).tmdbProxy).toBe("http://127.0.0.1:8890");
  await expect.poll(async () => (await restored.evaluate(() => window.desktopApi.listDownloadRoots()))[0]?.state).toBe("AVAILABLE"); expect(await readFile(join(media, "保留.txt"), "utf8")).toBe("现存文件不随数据库回退");
});
test("受管下载目录原生授权、取消与核心重启恢复", async () => {
  test.skip(process.platform !== "darwin");
  const window = await application.firstWindow(), chosenPath = join(directory, "中文 下载目录"); await mkdir(chosenPath); const root = await realpath(chosenPath);
  await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await application.evaluate(({ dialog }, path) => {
    let calls = 0;
    dialog.showOpenDialog = (async () => ++calls === 1 ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [path] }) as typeof dialog.showOpenDialog;
  }, root);
  await window.getByRole("link", { name: "云端网盘", exact: true }).click();
  await window.getByRole("button", { name: "选择下载目录", exact: true }).click();
  await expect(window.getByText("尚未授权下载目录")).toBeVisible();
  await window.getByRole("button", { name: "选择下载目录", exact: true }).click();
  await expect(window.getByText(root, { exact: true })).toBeVisible();
  const before = await window.evaluate(() => window.desktopApi.listDownloadRoots()); expect(before).toHaveLength(1); expect(before[0]?.state).toBe("AVAILABLE");
  await window.evaluate(() => window.desktopApi.restartCore());
  await expect.poll(async () => (await window.evaluate(() => window.desktopApi.listDownloadRoots()))[0]?.state).toBe("AVAILABLE");
  expect((await window.evaluate(() => window.desktopApi.listDownloadRoots()))[0]?.id).toBe(before[0]?.id);
  await window.reload(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await window.getByRole("link", { name: "云端网盘", exact: true }).click(); await expect(window.getByText(root, { exact: true })).toBeVisible();
  await window.screenshot({ path: "test-results/desktop/download-root.png" });
});
test("云端账号界面取消、无凭据回显与非法远端参数拒绝", async () => {
  const window = await application.firstWindow();
  await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await window.getByRole("link", { name: "云端网盘", exact: true }).click();
  await expect(window.getByRole("heading", { name: "还没有云端账号" })).toBeVisible();
  await window.getByRole("button", { name: "连接夸克账号", exact: true }).click();
  await window.getByLabel("账号名称").fill("取消输入测试");
  await window.getByLabel("本人账号 Cookie").fill("fixture-cookie-never-submitted");
  await window.getByRole("button", { name: "取消", exact: true }).click();
  await window.getByRole("button", { name: "连接夸克账号", exact: true }).click();
  await expect(window.getByLabel("本人账号 Cookie")).toHaveValue("");
  expect(await window.evaluate(() => window.desktopApi.listCloudAccounts())).toEqual([]);
  expect(await window.evaluate(async () => {
    try { await window.desktopApi.listRemote({ accountId: crypto.randomUUID(), parentRef: crypto.randomUUID(), endpoint: "http://127.0.0.1:5244", locator: { kind: "path", segments: [] } } as any); return false; }
    catch { return true; }
  })).toBe(true);
  expect(await window.evaluate(() => Object.keys(window.desktopApi))).not.toContain("requestPrivate");
  await window.screenshot({ path: "test-results/desktop/cloud-account-form.png" });
});
test("真实 Mac 授权作业异步返回、失效 Cookie 不启用账号且输入清空", async () => {
  test.skip(process.platform !== "darwin", "当前新功能优先验收 Mac");
  const window = await application.firstWindow();
  await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await window.getByRole("link", { name: "云端网盘", exact: true }).click();
  await window.getByRole("button", { name: "连接夸克账号", exact: true }).click();
  await window.getByLabel("账号名称").fill("失效授权测试");
  await window.getByLabel("本人账号 Cookie").fill("__pus=invalid; __puus=invalid");
  await window.getByRole("button", { name: "验证并连接", exact: true }).click();
  await expect(window.getByLabel("本人账号 Cookie")).toHaveCount(0);
  await expect.poll(async () => (await window.evaluate(() => window.desktopApi.listCloudAccounts()))[0]?.status, { timeout: 35000 }).toBe("AUTH_REQUIRED");
  const account = (await window.evaluate(() => window.desktopApi.listCloudAccounts()))[0]!;
  expect(account.rootRef).toBeNull(); expect(JSON.stringify(account)).not.toMatch(/cookie|credentialRef|bindingId|mount_path|raw_url/);
  await expect(window.getByRole("alert")).toBeVisible();
  await expect(window.getByRole("alert")).toContainText("账号需要重新授权");
  await window.getByRole("button", { name: "重新授权", exact: true }).click();
  await expect(window.getByLabel("本人账号 Cookie")).toHaveValue("");
  await window.screenshot({ path: "test-results/desktop/cloud-invalid-authorization.png" });
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

test("主进程异常退出后核心与离线解析器不残留", async () => {
  const window = await application.firstWindow();
  await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const pid = await application.evaluate(
    ({ app }) =>
      app.getAppMetrics().find((metric) => metric.name === "Media Marshal Core")
        ?.pid,
  );
  expect(pid).toBeTruthy();
  // Windows 的启动器与真正 Main 可能不是同一 PID，必须从运行中的 Main 取得身份。
  const mainPid = await application.evaluate(() => process.pid);
  const mainIdentity = identify(mainPid);
  expect(mainIdentity).toBeTruthy();
  const identity = identify(pid!);
  expect(identity?.parent).toBe(mainPid);
  const parserRoot = await application.evaluate(({ app }) => {
    const path = process.getBuiltinModule("node:path"), fs = process.getBuiltinModule("node:fs");
    return fs.realpathSync(app.isPackaged ? path.join(process.resourcesPath, "parser") : path.join(app.getAppPath(), "resources/parser", `${process.platform}-${process.arch}`, "runtime"));
  });
  const parserChildren = children(pid!).filter((child: { command: string }) => child.command.includes(parserRoot));
  expect(parserChildren).toHaveLength(1);
  // 来自本次 Main 的 AppMetrics，并复核 OS 创建时间和完整命令；不按裸 PID 回收。
  const marker = identity.command;
  stopVerified(mainIdentity, mainIdentity.command);
  const alive = () => matches(identity, marker);
  try {
    await expect.poll(alive, { timeout: 10000 }).toBe(false);
    for (const parser of parserChildren) await expect.poll(() => matches(parser, parserRoot), { timeout: 10000 }).toBe(false);
  } finally {
    if (alive()) stopVerified(identity, marker);
    for (const parser of parserChildren) if (matches(parser, parserRoot)) stopVerified(parser, parserRoot);
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

test("诊断导出使用原生保存授权且不包含个人路径", async () => {
  const window = await application.firstWindow();
  await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const output = join(directory, "diagnostics.json");
  await application.evaluate(({ dialog }, path) => {
    let calls = 0;
    dialog.showSaveDialog = (async () => ++calls === 1 ? { canceled: true, filePath: undefined } : { canceled: false, filePath: path }) as typeof dialog.showSaveDialog;
  }, output);
  await window.getByRole("link", { name: "设置", exact: true }).click();
  const button = window.getByRole("button", { name: "导出诊断", exact: true });
  await button.click(); await expect(button).toBeEnabled();
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  await button.click(); await expect(window.getByText("诊断已导出", { exact: true })).toBeVisible();
  const text = await readFile(output, "utf8"), report = JSON.parse(text);
  expect(text).not.toContain(directory); expect(text).not.toMatch(/Cookie|raw_url|authorization|password|data\.db/i);
  expect(report.privateDataIncluded).toBe(false); expect(report.cloud.state).toBe("DISABLED");
});
