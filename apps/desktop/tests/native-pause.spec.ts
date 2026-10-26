import { test, expect, _electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
const { identify, matches, children } = createRequire(resolve("package.json"))(resolve("tools/desktop-sidecars/process-identity.cjs"));
test.skip(process.platform !== "darwin", "本轮原生暂停菜单与进程信号仅验收 Mac");
let application: ElectronApplication, directory: string;
async function launch() {
  const env: Record<string, string> = {}; for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ ...(process.env.MARSHAL_EXECUTABLE ? { executablePath: process.env.MARSHAL_APP_PATH } : {}), args: [...(process.env.MARSHAL_EXECUTABLE ? [] : [process.env.MARSHAL_APP_PATH ?? resolve("apps/desktop")]), `--user-data-dir=${join(directory, "data")}`], env });
  return application.firstWindow();
}
test.beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "marshal-native-pause-")); await launch(); });
test.afterEach(async () => { await application?.close().catch(() => {}); if (directory) await rm(directory, { recursive: true, force: true }); });

test("原生暂停菜单分别控制整理与下载，页面、重载和整应用重启同步真实状态", async () => {
  test.setTimeout(70000);
  let page = await application.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  const state = () => application.evaluate(({ Menu }) => ["organize", "downloads"].map(kind => { const item = Menu.getApplicationMenu()!.getMenuItemById(`desktop.pause.${kind}`)!; return { checked: item.checked, enabled: item.enabled, label: item.label }; }));
  // 调用真实 MenuItem 的固定回调，验证 Main／Core；不冒充原生托盘点击。
  const select = (kind: "organize" | "downloads", paused: boolean) => application.evaluate(({ Menu }, { kind, paused }) => { const item = Menu.getApplicationMenu()!.getMenuItemById(`desktop.pause.${kind}`)!; if (item.checked !== paused) item.click(); }, { kind, paused });
  await expect.poll(state).toMatchObject([{ checked: false, enabled: true }, { checked: false, enabled: true }]);
  await select("organize", true); await expect.poll(() => page.evaluate(() => window.desktopApi.getOrganizePause())).toEqual({ paused: true }); expect(await page.evaluate(() => window.desktopApi.getCloudDownloadPause())).toMatchObject({ paused: false });
  await select("downloads", true); await expect.poll(() => page.evaluate(() => window.desktopApi.getCloudDownloadPause())).toMatchObject({ paused: true });
  await expect.poll(state).toMatchObject([{ checked: true, enabled: true }, { checked: true, enabled: true }]);
  await select("organize", false); await expect.poll(() => page.evaluate(() => window.desktopApi.getOrganizePause())).toEqual({ paused: false }); expect(await page.evaluate(() => window.desktopApi.getCloudDownloadPause())).toMatchObject({ paused: true });
  await page.evaluate(() => window.desktopApi.setOrganizePause({ paused: true, requestKey: crypto.randomUUID() })); await page.evaluate(() => window.desktopApi.setCloudDownloadPause({ paused: false, requestKey: crypto.randomUUID() }));
  await expect.poll(state).toMatchObject([{ checked: true, enabled: true }, { checked: false, enabled: true }]);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide()); await select("downloads", true); await expect.poll(() => page.evaluate(() => window.desktopApi.getCloudDownloadPause())).toMatchObject({ paused: true });
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show()); await page.reload(); await page.evaluate(() => window.desktopApi.restartCore());
  await expect.poll(state).toMatchObject([{ checked: true, enabled: true }, { checked: true, enabled: true }]); expect(await page.evaluate(() => window.desktopApi.listJobs())).toEqual([]);
  await application.close(); page = await launch(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  await expect.poll(state).toMatchObject([{ checked: true, enabled: true }, { checked: true, enabled: true }]);
  await select("organize", false); await expect.poll(state).toMatchObject([{ checked: false, enabled: true }, { checked: true, enabled: true }]); expect(await page.evaluate(() => window.desktopApi.listJobs())).toEqual([]);  await writeFile(resolve("test-results/desktop/native-pause-controls.json"), JSON.stringify({ menuItemCallbacks: true, sameFactoryAsTray: true, rendererMutationSynchronized: true, hiddenWindowControl: true, rendererReloadRetained: true, coreRestartRetained: true, appRestartRetained: true, finalOrganizePaused: false, finalDownloadPaused: true, fileJobsCreated: 0, nativeOsClick: false }));
});

test("原生暂停请求实际超时立即显示具体问题，核心恢复后核对状态且不自动重放", async () => {
  test.setTimeout(70000);
  const page = await application.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  await expect.poll(() => application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("desktop.pause.organize")!.enabled)).toBe(true);
  await application.evaluate(({ dialog }) => { (globalThis as any).__pauseProblems = []; dialog.showErrorBox = ((title: string, message: string) => { (globalThis as any).__pauseProblems.push({ title, message }); }) as typeof dialog.showErrorBox; });
  const owner = await application.evaluate(({ app }) => ({ main: process.pid, core: app.getAppMetrics().find(row => row.name === "Media Marshal Core")!.pid })), identity = identify(owner.core); expect(identity?.parent).toBe(owner.main); expect(matches(identity, identity.command)).toBe(true);
  const started = Date.now(); process.kill(identity.pid, "SIGSTOP");
  try {
    await application.evaluate(({ Menu }) => { const item = Menu.getApplicationMenu()!.getMenuItemById("desktop.pause.organize")!; item.click(); });
    await expect.poll(() => application.evaluate(() => (globalThis as any).__pauseProblems), { timeout: 22000, intervals: [100, 300, 1000] }).toMatchObject([{ title: "整理控制问题", message: expect.stringContaining("全部整理暂停设置未确认") }]);
    const failed = await application.evaluate(({ Menu }) => { const menu = Menu.getApplicationMenu()!, item = menu.getMenuItemById("desktop.pause.organize")!; return { checked: item.checked, enabled: item.enabled, label: item.label, problemVisible: menu.getMenuItemById("desktop.pause.problem.organize")!.visible, problems: (globalThis as any).__pauseProblems }; });
    expect(failed).toMatchObject({ checked: false, enabled: false, label: expect.stringContaining("状态未核对"), problemVisible: true }); expect(failed.problems[0].message).toContain("不会自动重试"); expect(failed.problems[0].message).toContain("请求等待超时"); expect(Date.now() - started).toBeGreaterThanOrEqual(14000);
  } finally { if (matches(identity, identity.command)) process.kill(identity.pid, "SIGCONT"); }
  await expect.poll(async () => { try { return (await page.evaluate(() => window.desktopApi.getRuntime())).core; } catch { return "waiting"; } }, { timeout: 20000 }).toBe("ready");
  await expect.poll(() => application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("desktop.pause.organize")!.enabled)).toBe(true);
  const current = await page.evaluate(() => window.desktopApi.getOrganizePause()); expect(await application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("desktop.pause.organize")!.checked)).toBe(current.paused);
  expect(await application.evaluate(() => (globalThis as any).__pauseProblems.length)).toBe(1); expect(await page.evaluate(() => window.desktopApi.listJobs())).toEqual([]); await application.close();
  const script = "const DB=require('better-sqlite3');const db=new DB(process.argv[1],{readonly:true});console.log(JSON.stringify(db.prepare(\"SELECT count(*) AS n FROM app_setting WHERE key LIKE 'ingestion.pause.command.%'\").get()));db.close();";
  const receipt = await new Promise<string>((done, fail) => execFile(createRequire(resolve("package.json"))("electron") as string, ["-e", script, join(directory, "data/desktop.sqlite3")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (error, stdout) => error ? fail(error) : done(stdout)));
  expect(JSON.parse(receipt).n).toBeLessThanOrEqual(1);
  await writeFile(resolve("test-results/desktop/native-pause-timeout.json"), JSON.stringify({ realUtilityProcessPaused: true, actualDeadlineExercised: true, pauseReceiptCount: JSON.parse(receipt).n, currentPaused: current.paused, errorReportedOnce: true, unknownStateDisabled: true, problemRetained: true, automaticWriteReplay: false }));
});


test("退出期间排空原生暂停读写，恢复自有核心后无残留解析器或迟到命令", async () => {
  test.setTimeout(35000);
  const page = await application.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  await expect.poll(() => application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("desktop.pause.organize")!.enabled)).toBe(true);
  const owner = await application.evaluate(({ app }) => ({ main: process.pid, core: app.getAppMetrics().find(row => row.name === "Media Marshal Core")!.pid })), identity = identify(owner.core), parsers = children(owner.core);
  expect(identity?.parent).toBe(owner.main); expect(parsers).toHaveLength(1); expect(matches(identity, identity.command)).toBe(true); process.kill(identity.pid, "SIGSTOP");
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("desktop.pause.organize")!.click());
    await expect.poll(() => application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("desktop.pause.organize")!.enabled)).toBe(false);
    release = setTimeout(() => { if (matches(identity, identity.command)) process.kill(identity.pid, "SIGCONT"); }, 500);
    await application.close(); await expect.poll(() => matches(identity, identity.command)).toBe(false);
    for (const parser of parsers) await expect.poll(() => matches(parser, parser.command)).toBe(false);
    await writeFile(resolve("test-results/desktop/native-pause-stop.json"), JSON.stringify({ exitWhileControlPending: true, stoppedOwnedCoreResumedAfterMs: 500, oldCoreStopped: true, parserStopped: true, nativeOsQuitClick: false, forcedKillOfUnresponsiveCore: false }));
  } finally { if (release) clearTimeout(release); if (matches(identity, identity.command)) process.kill(identity.pid, "SIGCONT"); }
});
