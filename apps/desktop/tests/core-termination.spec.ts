import { test, expect, _electron, type ElectronApplication } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const { identify, matches, children, stopVerified } = createRequire(resolve("package.json"))(resolve("tools/desktop-sidecars/process-identity.cjs"));
test.skip(process.platform !== "darwin", "永久冻结与进程信号在本轮 Mac 验收");
let application: ElectronApplication, directory: string;
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marshal-core-termination-"));
  const env: Record<string, string> = {}; for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ ...(process.env.MARSHAL_EXECUTABLE ? { executablePath: process.env.MARSHAL_APP_PATH } : {}), args: [...(process.env.MARSHAL_EXECUTABLE ? [] : [resolve("apps/desktop")]), `--user-data-dir=${join(directory, "data")}`], env });
});
test.afterEach(async () => { await application?.close().catch(() => {}); if (directory) await rm(directory, { recursive: true, force: true }); });

test("永久冻结的自有核心在显式退出期限后被回收，解析器退出且不靠恢复核心", async () => {
  test.setTimeout(40000);
  const page = await application.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  const owner = await application.evaluate(({ app }) => ({ main: process.pid, core: app.getAppMetrics().find(row => row.name === "Media Marshal Core")!.pid }));
  const core = identify(owner.core), parsers = children(owner.core); expect(core?.parent).toBe(owner.main); expect(parsers).toHaveLength(1);
  expect(matches(core, core.command)).toBe(true);
  const started = Date.now(); let closing: Promise<void> | undefined, rescueRequired = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    process.kill(core.pid, "SIGSTOP");
    expect(execFileSync("/bin/ps", ["-p", String(core.pid), "-o", "stat="], { encoding: "utf8" }).trim()).toMatch(/^T/);
    closing = application.close();
    const exited = await Promise.race([closing.then(() => true), new Promise<false>(done => { deadline = setTimeout(() => done(false), 14000); })]);
    expect(exited, "退出不能依赖测试恢复冻结 Core").toBe(true);
    expect(matches(core, core.command)).toBe(false);
    for (const parser of parsers) await expect.poll(() => matches(parser, parser.command), { timeout: 5000 }).toBe(false);
    await writeFile(resolve("test-results/desktop/core-termination-exit.json"), JSON.stringify({ stoppedStateVerifiedByOS: true, exitedBeforeRescue: exited, elapsedMs: Date.now() - started, coreStopped: true, parserStopped: true, resumedCoreForSuccess: false, nativeOsQuitClick: false }));
  } finally {
    if (deadline) clearTimeout(deadline);
    // 失败时仅清理本次取得并复核身份的进程，不把救援动作记作通过。
    if (matches(core, core.command)) { rescueRequired = true; stopVerified(core, core.command); }
    await closing;
    for (const parser of parsers) if (matches(parser, parser.command)) stopVerified(parser, parser.command);
    if (rescueRequired) console.info("冻结 Core 退出检查失败，已强制清理本次隔离进程。");
  }
});

test("永久冻结核心后显式重启先回收旧写入者，再恢复同一持久草稿和独立暂停状态", async () => {
  test.setTimeout(45000);
  const page = await application.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  const source = join(directory, "隔离来源"), target = join(directory, "隔离媒体库"); await mkdir(source); await mkdir(target);
  const draft = await page.evaluate(async ({ source, target }) => {
    await window.desktopApi.setOrganizePause({ paused: true, requestKey: crypto.randomUUID() });
    await window.desktopApi.setCloudDownloadPause({ paused: false, requestKey: crypto.randomUUID() });
    return window.desktopApi.configureSourceRule({ id: crypto.randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: crypto.randomUUID(), configuration: { type: "local", name: "冻结核心恢复草稿", sourcePath: source, organization: { targetPath: target } } });
  }, { source, target });
  const owner = await application.evaluate(({ app }) => ({ main: process.pid, core: app.getAppMetrics().find(row => row.name === "Media Marshal Core")!.pid })), core = identify(owner.core), parsers = children(owner.core);
  expect(core?.parent).toBe(owner.main); expect(parsers).toHaveLength(1); expect(matches(core, core.command)).toBe(true);
  const started = Date.now();
  await application.evaluate(({ app }) => {
    const events: { event: string; elapsedMs: number }[] = [], start = Date.now();
    Reflect.set(globalThis, "marshalTerminationTrace", events);
    app.on("before-quit", () => events.push({ event: "before-quit", elapsedMs: Date.now() - start }));
    app.on("will-quit", () => events.push({ event: "will-quit", elapsedMs: Date.now() - start }));
  });
  try {
    process.kill(core.pid, "SIGSTOP");
    expect(execFileSync("/bin/ps", ["-p", String(core.pid), "-o", "stat="], { encoding: "utf8" }).trim()).toMatch(/^T/);
    try { await page.evaluate(() => window.desktopApi.restartCore()); }
    catch (error) {
      const events = await application.evaluate(() => Reflect.get(globalThis, "marshalTerminationTrace")).catch(() => null);
      let oldCoreStillOwned: boolean | null = null; try { oldCoreStillOwned = matches(core, core.command); } catch { /* 诊断失败不能覆盖原重启错误。 */ }
      await writeFile(test.info().outputPath("restart-failure.json"), JSON.stringify({ phase: "restart", elapsedMs: Date.now() - started, applicationEvents: events, oldCoreStillOwned })).catch(() => {});
      throw error;
    }
    expect(matches(core, core.command)).toBe(false);
    for (const parser of parsers) await expect.poll(() => matches(parser, parser.command), { timeout: 5000 }).toBe(false);
    await expect.poll(async () => { try { return (await page.evaluate(() => window.desktopApi.getRuntime())).status?.parser; } catch { return "waiting"; } }).toBe("ready");
    const replacement = await application.evaluate(({ app }) => ({ main: process.pid, core: app.getAppMetrics().find(row => row.name === "Media Marshal Core")!.pid }));
    expect(replacement.main).toBe(owner.main); expect(replacement.core).not.toBe(owner.core); expect(identify(replacement.core)?.parent).toBe(owner.main);
    expect(await page.evaluate(id => window.desktopApi.getSourceRule(id), draft.id)).toMatchObject({ id: draft.id, version: 0, draftRevision: 1, configuration: null, draft: { name: "冻结核心恢复草稿" } });
    expect(await page.evaluate(() => window.desktopApi.getOrganizePause())).toEqual({ paused: true }); expect(await page.evaluate(() => window.desktopApi.getCloudDownloadPause())).toMatchObject({ paused: false });
    expect(await page.evaluate(() => window.desktopApi.listJobs())).toEqual([]); expect(await page.evaluate(() => window.desktopApi.listSources())).toEqual([]);
    const applicationEvents = await application.evaluate(() => Reflect.get(globalThis, "marshalTerminationTrace")); expect(applicationEvents).toEqual([]);
    await writeFile(resolve("test-results/desktop/core-termination-restart.json"), JSON.stringify({ stoppedStateVerifiedByOS: true, resumedCoreForSuccess: false, elapsedMs: Date.now() - started, oldCoreStopped: true, oldParserStopped: true, sameMain: true, newCore: true, replacementParserReady: true, persistedDraftId: draft.id, draftRevision: 1, draftNotActivated: true, organizePaused: true, downloadsPaused: false, fileJobs: 0, applicationEvents }));
  } finally { if (matches(core, core.command)) stopVerified(core, core.command); }
});
