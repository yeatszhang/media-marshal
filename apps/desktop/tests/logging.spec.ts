import { expect, test, _electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

let application: ElectronApplication | undefined;
let directory: string;
test.afterEach(async () => {
  await application?.close().catch(() => {});
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("统一日志把 Main、Core 和沙盒页面同时写入控制台及本地，并在退出时落盘", async () => {
  directory = await mkdtemp(join(tmpdir(), "marshal-logging-e2e-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.ELECTRON_RUN_AS_NODE;
  env.MARSHAL_LOG_LEVEL = "debug";
  env.FORCE_COLOR = "1";
  delete env.NO_COLOR;
  application = await _electron.launch({
    ...(process.env.MARSHAL_EXECUTABLE ? { executablePath: process.env.MARSHAL_APP_PATH } : {}),
    args: [...(process.env.MARSHAL_EXECUTABLE ? [] : [resolve("apps/desktop")]), `--user-data-dir=${join(directory, "data")}`], env,
  });
  let consoleOutput = "";
  let rawConsoleOutput = "";
  application.process().stdout?.on("data", (bytes) => {
    rawConsoleOutput += bytes.toString();
    consoleOutput = stripVTControlCharacters(rawConsoleOutput);
  });
  const page = await application.firstWindow();
  await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  const path = join(directory, "data/logs/desktop.log");
  await expect.poll(async () => readFile(path, "utf8")).toContain('"event":"renderer.ready"');
  let content = await readFile(path, "utf8");
  expect(content).toContain('"event":"app.start"');
  expect(content).toContain('"event":"core.ready"');
  expect(content).toContain('"process":"renderer"');

  // 未标记控制台不采集；结构化日志在进入 Main 时再次脱敏。
  await page.evaluate(() => {
    console.error("未经标记的原始秘密");
    console.info('[media-marshal] ' + JSON.stringify({ level: 30, msg: "页面日志探针", event: "renderer.probe", error: { token: "页面令牌秘密" } }));
    console.error('[media-marshal] ' + JSON.stringify({ level: 50, msg: "页面异常探针", error: { type: "TypeError", code: "PROBE", stack: "    at rendererProbe (probe.ts:1:1)\n    at rendererCaller (probe.ts:2:1)" } }));
  });
  await page.evaluate(() => window.desktopApi.listSyncSources());
  const sourceId = "11111111-1111-4111-8111-111111111111";
  await page.evaluate(async (id) => {
    try { await window.desktopApi.previewSyncSource({ id, expectedVersion: 0, expectedDraftRevision: 0, expectedLifecycleRevision: 0, requestKey: crypto.randomUUID() }); }
    catch { /* 通过不存在的来源验证真实 Core 业务日志，不创建媒体任务。 */ }
  }, sourceId);
  await expect.poll(() => consoleOutput).toContain("页面日志探针");
  await expect.poll(() => consoleOutput).toContain("action=sync.list");
  await expect.poll(() => consoleOutput).toContain("at rendererCaller (probe.ts:2:1)");
  expect(consoleOutput).toContain("INFO:");
  expect(consoleOutput).toContain("[renderer] 页面日志探针 event=renderer.probe");
  expect(consoleOutput).not.toContain('"level":');
  expect(consoleOutput).toMatch(/error: type=TypeError code=PROBE\n\s+at rendererProbe \(probe.ts:1:1\)\n\s+at rendererCaller/);
  expect(rawConsoleOutput).toContain("\u001b[32mINFO");
  expect(rawConsoleOutput).toContain("\u001b[31mERROR");
  await application.close(); application = undefined;
  content = await readFile(path, "utf8");
  expect(content).toContain("页面日志探针");
  expect(content).toContain('"event":"core.stopped"');
  expect(content).toContain('"event":"app.stopped"');
  const failure = content.trim().split("\n").map((line) => JSON.parse(line)).find((record) => record.event === "sync.preview.failed");
  expect(failure).toMatchObject({ process: "core", scope: "sync", sourceId, sourcePid: expect.any(Number), error: { code: "CONFLICT" } });
  expect(content).not.toContain("页面令牌秘密");
  expect(content).not.toContain("未经标记的原始秘密");
  expect(content).not.toContain("\u001b[");
  for (const line of content.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
});
