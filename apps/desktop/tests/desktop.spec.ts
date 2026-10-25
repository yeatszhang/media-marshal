import {
  test,
  expect,
  _electron,
  type Page, type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, readdir, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { resolve, join, dirname } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
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
async function completedCorrectionFixture(mediaType: "MOVIE" | "TV_SHOW" = "MOVIE") {
  let window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const canonical = await realpath(directory), source = join(canonical, "修正来源 中文"), target = join(canonical, "媒体目标 中文"), fileName = mediaType === "TV_SHOW" ? "宿主原片.S01E01.mkv" : "宿主原片.mkv", bytes = Buffer.from("原下载文件保持不变，媒体目标只按确认计划改名。".repeat(200)); await mkdir(source); await mkdir(target); await writeFile(join(source, fileName), bytes); await writeFile(join(source, fileName.replace(/\.mkv$/, ".zh.srt")), "字幕夹具"); if (mediaType === "TV_SHOW") await writeFile(join(source, "宿主原片.S01E02.mkv"), bytes); await writeFile(join(source, "poster.jpg"), "通用封面夹具");
  await application.evaluate(({ dialog }, paths) => { let index = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog; }, [source, target]);
  const row = await window.evaluate(async ({ source, target }) => {
    await window.desktopApi.chooseDirectory("source"); await window.desktopApi.chooseDirectory("target"); await window.desktopApi.saveCredential("tmdb", "isolated-native-host-fixture");
    const draft = await window.desktopApi.configureSourceRule({ id: crypto.randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: crypto.randomUUID(), configuration: { type: "local", name: "原生修正验收", client: "custom", sourcePath: source, organization: { targetPath: target } } }); const preview = await window.desktopApi.previewSourceRule({ id: draft.id, expectedVersion: 0, expectedDraftRevision: 1, requestKey: crypto.randomUUID() }); return window.desktopApi.applySourceRule({ previewId: preview.id, requestKey: crypto.randomUUID() });
  }, { source, target });
  await application.close(); const config = join(canonical, "seed-correction.json"); await writeFile(config, JSON.stringify({ database: join(directory, "data/desktop.sqlite3"), sourceId: row.localSourceId ?? row.ingestionSourceId, sourcePath: source, targetPath: target, fileName, mediaType }));
  const seeded = await new Promise<{ stdout: string }>((done, fail) => execFile(createRequire(resolve("package.json"))("electron") as string, [resolve("tools/desktop-files/seed-host-correction.mjs"), config], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20000 }, (error, stdout) => error ? fail(error) : done({ stdout }))), original = JSON.parse(seeded.stdout.trim()) as { taskId: string; targetPath: string; inode: string };
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; application = await _electron.launch({ executablePath: process.env.MARSHAL_EXECUTABLE ? process.env.MARSHAL_APP_PATH : undefined, args: [...(process.env.MARSHAL_EXECUTABLE ? [] : [process.env.MARSHAL_APP_PATH ?? resolve("apps/desktop")]), `--user-data-dir=${join(directory, "data")}`], env }); window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  return { window, canonical, source, target, fileName, bytes, original };
}
test("修正原生组件经 Main 私有资源、Utility Process 与固定 Preload 完成真实文件和历史变更", async () => {
  test.skip(process.platform !== "darwin"); test.setTimeout(60000);
  const { window, source, fileName, bytes, original } = await completedCorrectionFixture();
  expect((await window.evaluate((taskId) => window.desktopApi.getCorrectionTask(taskId), original.taskId)).available).toBe(true);
  const pending = await window.evaluate((taskId) => window.desktopApi.previewCorrection({ taskId, requestKey: crypto.randomUUID(), selection: { tmdbId: 2, mediaType: "MOVIE" } }), original.taskId); expect(pending.state).toBe("PENDING");
  await expect.poll(async () => (await window.evaluate((id) => window.desktopApi.getCorrectionPreparation(id), pending.id)).state).toBe("READY"); const ready = await window.evaluate((id) => window.desktopApi.getCorrectionPreparation(id), pending.id), preview = await window.evaluate((id) => window.desktopApi.getCorrectionPreview(id), ready.previewId!);
  expect(preview.files.filter((file) => file.action === "MOVE")).toHaveLength(2); expect(preview.files.some((file) => file.action === "KEEP" && file.fromPath.endsWith("poster.jpg"))).toBe(true); expect(await readFile(original.targetPath)).toEqual(bytes);
  const confirmation = await window.evaluate((previewId) => window.desktopApi.confirmCorrection({ previewId, requestKey: crypto.randomUUID(), filesComplete: true }), preview.id); await expect.poll(async () => (await window.evaluate((id) => window.desktopApi.getCorrectionPreparation(id), confirmation.id)).state).toBe("READY"); const receipt = await window.evaluate((id) => window.desktopApi.getCorrectionPreparation(id), confirmation.id), id = receipt.operationId!;
  await expect.poll(async () => (await window.evaluate((id) => window.desktopApi.getCorrection(id), id)).operation.state).toBe("RECORDED"); const operation = (await window.evaluate((id) => window.desktopApi.getCorrection(id), id)).operation;
  expect(await readFile(preview.targetPath)).toEqual(bytes); expect(String((await stat(preview.targetPath, { bigint: true })).ino)).toBe(original.inode); await expect(stat(original.targetPath)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(preview.targetPath.replace(/\.mkv$/, ".zh.srt"), "utf8")).toBe("字幕夹具"); expect(await readFile(join(source, fileName))).toEqual(bytes);
  await window.reload(); await window.evaluate(() => window.desktopApi.restartCore()); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); expect((await window.evaluate((taskId) => window.desktopApi.getCorrectionTask(taskId), original.taskId))).toMatchObject({ status: "CORRECTED", nextTaskId: operation.newTaskId, available: true }); expect((await window.evaluate((taskId) => window.desktopApi.getCorrectionTask(taskId), operation.newTaskId))).toMatchObject({ status: "DONE", previousTaskId: original.taskId }); expect(await window.evaluate(() => window.desktopApi.listCorrections({}))).toMatchObject({ total: 1, items: [{ id, state: "RECORDED" }] }); expect(await readFile(join(source, fileName))).toEqual(bytes);
});
test("同季批量修正经固定 Preload 返回批次编号并完成两成员，重启保留原作业与历史", async () => {
  test.skip(process.platform !== "darwin"); test.setTimeout(60000);
  const { window, original, source, fileName, bytes } = await completedCorrectionFixture("TV_SHOW");
  expect(await window.evaluate(() => window.desktopApi.listCorrectionBatches({}))).toEqual({ items: [], total: 0 });
  const batch = await window.evaluate((taskId) => window.desktopApi.previewCorrectionBatch({ taskId, requestKey: crypto.randomUUID(), scope: "SAME_SEASON", tmdbId: 2 }), original.taskId); expect(batch).toMatchObject({ state: "PREVIEWING", total: 2, submitted: 0 });
  const details = () => window.evaluate((id) => window.desktopApi.getCorrectionBatch({ id }), batch.id); await expect.poll(async () => (await details()).batch.state).toBe("READY");
  const ready = await details(); expect(ready.items.every((item) => item.previewId && !item.operation)).toBe(true);
  for (const member of ready.items) { const preview = await window.evaluate((id) => window.desktopApi.getCorrectionPreview(id), member.previewId!); expect(preview.selection).toMatchObject({ tmdbId: 2, mediaType: "TV_SHOW", season: 1 }); expect(await readFile(member.targetPath!)).toEqual(bytes); }
  const confirmation = await window.evaluate(({ id, fingerprint }) => window.desktopApi.confirmCorrectionBatch({ id, fingerprint, requestKey: crypto.randomUUID(), filesComplete: true }), batch); expect(confirmation.state).toBe("CONFIRMING");
  await expect.poll(async () => (await details()).batch.state, { timeout: 15000 }).toBe("DONE"); const done = await details(); expect(done.batch).toMatchObject({ submitted: 2, done: 2, failed: 0 });
  for (const member of done.items) { const task = await window.evaluate((id) => window.desktopApi.getCorrectionTask(id), member.operation!.newTaskId); expect(task).toMatchObject({ status: "DONE", previousTaskId: member.taskId }); expect(await readFile(task.targetPath!)).toEqual(bytes); }
  await window.reload(); await window.evaluate(() => window.desktopApi.restartCore()); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); expect((await details()).items.map((item) => item.operation?.id)).toEqual(done.items.map((item) => item.operation?.id)); expect((await details()).batch.state).toBe("DONE"); expect(await readFile(join(source, fileName))).toEqual(bytes); expect(await readFile(join(source, "宿主原片.S01E02.mkv"))).toEqual(bytes);
});
async function openBatchDraft(window: Page, fileName: string) {
  await window.getByRole("link", { name: "任务", exact: true }).click(); await window.getByRole("row").filter({ hasText: fileName }).getByRole("button", { name: "修正", exact: true }).click(); await window.getByRole("link", { name: "同季／同剧批量修正", exact: true }).click(); await expect(window.getByRole("region", { name: "批量修正完整范围", exact: true })).toContainText("范围共 2 项"); await window.getByLabel("批量修正 TMDB ID", { exact: true }).fill("2");
}
async function reviewBatchMembers(window: Page) {
  for (const episode of [1, 2]) {
    const label = `S1 E${episode}`; await window.getByRole("button", { name: `展开 ${label} 完整清单`, exact: true }).click(); const checkbox = window.getByRole("checkbox", { name: `已核对 ${label} 完整清单`, exact: true }); await expect(checkbox).toBeEnabled(); await checkbox.focus(); await window.keyboard.press("Space"); await expect(checkbox).toBeChecked();
  }
  await window.getByRole("checkbox", { name: "已核对整批并理解可能部分成功", exact: true }).check();
}
test("批量修正页面完整范围、参数恢复、过期重做、整批确认及历史导航", async () => {
  test.skip(process.platform !== "darwin"); test.setTimeout(100000);
  const { window, fileName, source, bytes, original } = await completedCorrectionFixture("TV_SHOW"); await openBatchDraft(window, fileName); await window.getByLabel("批量修正范围", { exact: true }).selectOption("SAME_SERIES"); await expect(window.getByRole("region", { name: "批量修正完整范围", exact: true })).toContainText("同剧范围共 2 项");
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640)); expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); const scopeCheckbox = window.getByRole("checkbox", { name: "选择 S1 E1", exact: true }); expect(await scopeCheckbox.evaluate((input) => { const box = input.getBoundingClientRect(), text = input.parentElement!.querySelector("span")!.getBoundingClientRect(); return box.width >= 16 && box.width <= 20 && text.left - box.right >= 8 && text.left - box.right <= 16; })).toBe(true); await window.evaluate(() => scrollTo(0, 0)); await window.screenshot({ path: "test-results/desktop/correction-batch-draft-minimum.png", fullPage: true });
  expect((await window.evaluate(() => window.desktopApi.listCorrectionBatches({}))).total).toBe(0); await window.getByRole("button", { name: "核验并生成批量预览", exact: true }).click(); const summary = window.getByRole("region", { name: "批量修正概况", exact: true }); await expect(summary).toContainText("等待完整清单确认");
  const old = (await window.evaluate(() => window.desktopApi.listCorrectionBatches({}))).items[0]!; expect(old.scope).toBe("SAME_SERIES"); const before = await window.evaluate((taskId) => window.desktopApi.getCorrectionScope({ taskId, scope: "SAME_SERIES" }), original.taskId); expect(before.total).toBe(2);
  await expect(window.getByRole("button", { name: "确认并开始整批修正", exact: true })).toBeDisabled(); await window.getByRole("link", { name: "调整范围或参数并重新预览", exact: true }).click(); await expect(window.getByLabel("批量修正 TMDB ID", { exact: true })).toHaveValue("2"); await expect(window.getByLabel("批量修正范围", { exact: true })).toHaveValue("SAME_SERIES"); await window.getByLabel("批量修正 TMDB ID", { exact: true }).fill("1"); expect((await window.evaluate(() => window.desktopApi.listCorrectionBatches({}))).total).toBe(1); expect(await readFile(original.targetPath)).toEqual(bytes);
  await window.getByRole("link", { name: "批量修正记录", exact: true }).click(); await window.getByRole("link", { name: "查看批次与逐项结果", exact: true }).click(); await window.reload(); await expect(summary).toContainText("等待完整清单确认"); await expect(window.getByRole("button", { name: "确认并开始整批修正", exact: true })).toBeDisabled();
  await window.evaluate(() => window.desktopApi.restartCore()); await expect(summary).toContainText("预览已过期或核心已重启"); await window.getByRole("link", { name: "调整范围或参数并重新预览", exact: true }).click(); await expect(window.getByLabel("批量修正 TMDB ID", { exact: true })).toHaveValue("2"); await window.getByRole("button", { name: "核验并生成批量预览", exact: true }).click(); await expect(summary).toContainText("等待完整清单确认");
  await reviewBatchMembers(window); await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640)); expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(await window.locator(".correction-page .page-heading").evaluate((header) => header.scrollWidth <= header.clientWidth && header.querySelector("a")!.getBoundingClientRect().right <= innerWidth)).toBe(true); await window.evaluate(() => scrollTo(0, 0)); await expect.poll(() => window.evaluate(() => scrollY)).toBe(0); await window.screenshot({ path: "test-results/desktop/correction-batch-preview-minimum.png", fullPage: true });
  await window.getByRole("button", { name: "确认并开始整批修正", exact: true }).click(); await expect(summary).toContainText("选中成员的文件与历史已完成"); const done = (await window.evaluate(() => window.desktopApi.listCorrectionBatches({}))).items.find((item) => item.state === "DONE")!; expect(done).toMatchObject({ selected: 2, done: 2, failed: 0 }); const details = await window.evaluate((id) => window.desktopApi.getCorrectionBatch({ id }), done.id);
  for (const member of details.items) { const task = await window.evaluate((id) => window.desktopApi.getCorrectionTask(id), member.operation!.newTaskId); expect(task).toMatchObject({ status: "DONE", previousTaskId: member.taskId }); expect(await readFile(task.targetPath!)).toEqual(bytes); } expect((await window.evaluate(() => window.desktopApi.listCorrections({}))).total).toBe(2); expect(await readFile(join(source, fileName))).toEqual(bytes); expect(await readFile(join(source, "宿主原片.S01E02.mkv"))).toEqual(bytes);
  await window.reload(); await expect(summary).toContainText("选中成员的文件与历史已完成"); const after = await window.evaluate((id) => window.desktopApi.getCorrectionBatch({ id }), done.id); expect(after.items.map((item) => item.operation!.id)).toEqual(details.items.map((item) => item.operation!.id)); await window.getByRole("link", { name: "修正后的任务与历史", exact: true }).first().click(); await expect(window.getByLabel("当前媒体与历史", { exact: true })).toBeVisible(); await expect(window.getByRole("link", { name: "查看前一条历史", exact: true })).toBeVisible();
});
test("批量修正页面字幕冲突、Core 重启和原成员独立重试不重做其他成员", async () => {
  test.skip(process.platform !== "darwin"); test.setTimeout(90000);
  const { window, source, fileName, bytes } = await completedCorrectionFixture("TV_SHOW"); await openBatchDraft(window, fileName); await window.getByRole("button", { name: "核验并生成批量预览", exact: true }).click(); const summary = window.getByRole("region", { name: "批量修正概况", exact: true }); await expect(summary).toContainText("等待完整清单确认"); const batch = (await window.evaluate(() => window.desktopApi.listCorrectionBatches({}))).items[0]!, previewed = await window.evaluate((id) => window.desktopApi.getCorrectionBatch({ id }), batch.id), member = previewed.items.find((item) => item.selection.episode === 1)!, preview = await window.evaluate((id) => window.desktopApi.getCorrectionPreview(id), member.previewId!), subtitle = preview.files.find((file) => file.toPath.endsWith(".srt") && file.action === "MOVE")!;
  await window.evaluate(() => window.desktopApi.setOrganizePause({ paused: true, requestKey: crypto.randomUUID() })); await reviewBatchMembers(window); await window.getByRole("button", { name: "确认并开始整批修正", exact: true }).click(); await expect.poll(async () => (await window.evaluate((id) => window.desktopApi.getCorrectionBatch({ id }), batch.id)).batch.submitted).toBe(2); const accepted = await window.evaluate((id) => window.desktopApi.getCorrectionBatch({ id }), batch.id);
  await mkdir(dirname(subtitle.toPath), { recursive: true }); await writeFile(subtitle.toPath, "外部字幕不能覆盖"); await window.evaluate(() => window.desktopApi.setOrganizePause({ paused: false, requestKey: crypto.randomUUID() })); await expect(summary).toContainText("完成 1 项，需处理 1 项"); await expect(window.getByRole("region", { name: "批量修正成员", exact: true })).toContainText("新位置被不属于本次执行的文件或目录占用"); expect(await readFile(subtitle.toPath, "utf8")).toBe("外部字幕不能覆盖");
  const second = accepted.items.find((item) => item.selection.episode === 2)!, secondTask = await window.evaluate((id) => window.desktopApi.getCorrectionTask(id), second.operation!.newTaskId), inode = (await stat(secondTask.targetPath!, { bigint: true })).ino;
  await window.evaluate(() => window.desktopApi.restartCore()); await window.reload(); await expect(summary).toContainText("部分失败，需处理"); await window.getByRole("button", { name: "展开 S1 E1 完整清单", exact: true }).click(); await expect(window.getByRole("region", { name: "批量修正成员", exact: true })).toContainText("查看恢复核对位置"); await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640)); expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await window.evaluate(() => scrollTo(0, 0)); await expect.poll(() => window.evaluate(() => scrollY)).toBe(0); await window.screenshot({ path: "test-results/desktop/correction-batch-conflict-minimum.png", fullPage: true });
  await rename(subtitle.toPath, subtitle.toPath + ".保留"); await window.getByRole("button", { name: "重试 S1 E1 原成员作业", exact: true }).click(); await expect(summary).toContainText("选中成员的文件与历史已完成"); const after = await window.evaluate((id) => window.desktopApi.getCorrectionBatch({ id }), batch.id); expect(after.items.map((item) => item.operation!.id)).toEqual(accepted.items.map((item) => item.operation!.id)); expect(after.items.map((item) => item.operation!.newTaskId)).toEqual(accepted.items.map((item) => item.operation!.newTaskId)); expect((await stat(secondTask.targetPath!, { bigint: true })).ino).toBe(inode); expect(await readFile(subtitle.toPath + ".保留", "utf8")).toBe("外部字幕不能覆盖"); expect(await readFile(join(source, fileName))).toEqual(bytes); expect((await window.evaluate(() => window.desktopApi.listCorrections({}))).total).toBe(2); await window.evaluate(() => scrollTo(0, 0)); await expect.poll(() => window.evaluate(() => scrollY)).toBe(0); await window.screenshot({ path: "test-results/desktop/correction-batch-recovered-minimum.png", fullPage: true });
});
test("单条修正页面完整预览、重载、过期重做、确认和历史导航", async () => {
  test.skip(process.platform !== "darwin"); test.setTimeout(70000);
  const { window, original, bytes, source, fileName } = await completedCorrectionFixture(); await window.getByRole("link", { name: "任务", exact: true }).click(); await window.getByRole("button", { name: "修正", exact: true }).click();
  await expect(window.getByRole("heading", { name: "修正已整理媒体", exact: true })).toBeVisible(); await window.getByLabel("修正 TMDB ID", { exact: true }).fill("2"); await window.getByRole("button", { name: "核验并预览修正", exact: true }).click(); const panel = window.getByRole("region", { name: "修正预览", exact: true }); await expect(panel).toContainText("宿主修正作品"); await expect(panel.getByRole("button", { name: "确认并开始修正", exact: true })).toBeDisabled();
  await window.getByLabel("修正 TMDB ID", { exact: true }).fill("1"); await expect(panel).toHaveCount(0); expect(await window.evaluate(() => window.desktopApi.listCorrections({}))).toMatchObject({ total: 0 }); await window.getByLabel("修正 TMDB ID", { exact: true }).fill("2"); await window.getByRole("button", { name: "核验并预览修正", exact: true }).click(); await expect(panel).toContainText("宿主修正作品");
  await window.reload(); await expect(panel).toContainText("宿主修正作品"); await expect(window.getByLabel("修正 TMDB ID", { exact: true })).toHaveValue("2"); await window.evaluate(() => window.desktopApi.restartCore()); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); await expect(panel).toContainText("预览已过期或核心已重启"); await window.getByRole("button", { name: "核验并预览修正", exact: true }).click(); await expect(panel.getByRole("checkbox", { name: "已核对完整修正文件清单", exact: true })).toBeVisible();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640)); expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(await window.locator(".correction-page .page-heading").evaluate((header) => { const link = header.querySelector("a")!.getBoundingClientRect(); return header.scrollWidth <= header.clientWidth && link.left >= 0 && link.right <= innerWidth; })).toBe(true); await window.screenshot({ path: "test-results/desktop/correction-preview-minimum.png", fullPage: true });
  const descriptor = await window.evaluate((taskId) => window.desktopApi.getCorrectionTask(taskId), original.taskId), preview = await window.evaluate((id) => window.desktopApi.getCorrectionPreview(id), descriptor.preparation!.previewId!); await panel.getByRole("checkbox", { name: "已核对完整修正文件清单", exact: true }).focus(); await window.keyboard.press("Space"); await expect(panel.getByRole("checkbox", { name: "已核对完整修正文件清单", exact: true })).toBeChecked(); await panel.getByRole("button", { name: "确认并开始修正", exact: true }).click(); const result = window.getByRole("region", { name: "修正作业详情", exact: true }); await expect(result).toContainText("媒体文件与历史已完成");
  expect(await readFile(preview.targetPath)).toEqual(bytes); expect(String((await stat(preview.targetPath, { bigint: true })).ino)).toBe(original.inode); expect(await readFile(join(source, fileName))).toEqual(bytes); expect((await window.evaluate(() => window.desktopApi.listCorrections({}))).total).toBe(1);
  await window.getByRole("link", { name: "查看修正后的任务", exact: true }).click(); await expect(window.getByLabel("单条修正参数", { exact: true })).toBeVisible(); await expect(window.getByLabel("修正 TMDB ID", { exact: true })).toHaveValue("2"); await window.getByRole("link", { name: "查看前一条历史", exact: true }).click(); await expect(window.getByText("此任务已修正，以上路径是历史记录。请查看修正后的任务，不会按旧路径重放整理。", { exact: true })).toBeVisible(); await window.getByRole("link", { name: "全部修正作业", exact: true }).click(); await expect(window.getByRole("region", { name: "修正作业列表", exact: true })).toContainText("宿主修正作品");
});
test("单条修正页面定位字幕冲突，Core 重启后修复并沿同一作业重试", async () => {
  test.skip(process.platform !== "darwin"); test.setTimeout(80000);
  const { window, original, source, fileName, bytes } = await completedCorrectionFixture(); await window.getByRole("link", { name: "任务", exact: true }).click(); await window.getByRole("button", { name: "修正", exact: true }).click(); await window.getByLabel("修正 TMDB ID", { exact: true }).fill("2"); await window.getByRole("button", { name: "核验并预览修正", exact: true }).click(); const panel = window.getByRole("region", { name: "修正预览", exact: true }); await expect(panel).toContainText("宿主修正作品");
  const task = await window.evaluate((taskId) => window.desktopApi.getCorrectionTask(taskId), original.taskId), preview = await window.evaluate((id) => window.desktopApi.getCorrectionPreview(id), task.preparation!.previewId!), subtitle = preview.files.find((file) => file.action === "MOVE" && file.toPath.endsWith(".srt"))!; await window.evaluate(() => window.desktopApi.setOrganizePause({ paused: true, requestKey: crypto.randomUUID() })); await panel.getByRole("checkbox", { name: "已核对完整修正文件清单", exact: true }).check(); await panel.getByRole("button", { name: "确认并开始修正", exact: true }).click(); await expect.poll(async () => (await window.evaluate(() => window.desktopApi.listCorrections({}))).total).toBe(1);
  const before = (await window.evaluate(() => window.desktopApi.listCorrections({}))).items[0]!; await mkdir(dirname(subtitle.toPath), { recursive: true }); await writeFile(subtitle.toPath, "不能覆盖的外部字幕"); await window.evaluate(() => window.desktopApi.setOrganizePause({ paused: false, requestKey: crypto.randomUUID() })); const result = window.getByRole("region", { name: "修正作业详情", exact: true }); await expect(result).toContainText("1/2 项文件完成"); await expect(result.locator(".is-failed")).toContainText(".zh.srt"); await expect(result).toContainText("新位置被不属于本次执行的文件或目录占用"); expect(await readFile(subtitle.toPath, "utf8")).toBe("不能覆盖的外部字幕");
  const inode = (await stat(preview.targetPath, { bigint: true })).ino; await window.evaluate(() => window.desktopApi.restartCore()); await window.reload(); await expect(result).toContainText("需要处理"); await expect(result.getByRole("button", { name: "核对并重试原修正", exact: true })).toBeEnabled(); await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640)); expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(await window.locator(".correction-page .page-heading").evaluate((header) => { const link = header.querySelector("a")!.getBoundingClientRect(); return header.scrollWidth <= header.clientWidth && link.left >= 0 && link.right <= innerWidth; })).toBe(true); await window.screenshot({ path: "test-results/desktop/correction-subtitle-conflict-minimum.png", fullPage: true });
  await rename(subtitle.toPath, subtitle.toPath + ".保留"); await result.getByRole("button", { name: "核对并重试原修正", exact: true }).click(); await expect(result).toContainText("媒体文件与历史已完成"); const after = (await window.evaluate(() => window.desktopApi.listCorrections({}))).items; expect(after).toHaveLength(1); expect(after[0]).toMatchObject({ id: before.id, newTaskId: before.newTaskId, state: "RECORDED" }); expect((await stat(preview.targetPath, { bigint: true })).ino).toBe(inode); expect(await readFile(preview.targetPath)).toEqual(bytes); expect(await readFile(subtitle.toPath, "utf8")).toBe("字幕夹具"); expect(await readFile(subtitle.toPath + ".保留", "utf8")).toBe("不能覆盖的外部字幕"); expect(await readFile(join(source, fileName))).toEqual(bytes); await window.screenshot({ path: "test-results/desktop/correction-recovered-minimum.png", fullPage: true });
});
test("目录批量识别经真实稳定窗口与 IPC 提交，重启保留逐项匹配失败且不复制文件", async () => {
  test.skip(process.platform !== "darwin"); test.setTimeout(230000);
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const canonical = await realpath(directory), source = join(canonical, "中文批量识别来源"), target = join(canonical, "独立媒体目标"); await mkdir(source); await mkdir(target);
  for (const episode of [1, 2]) await writeFile(join(source, `测试作品.S01E0${episode}.mp4`), `第 ${episode} 个原视频保留`);
  await application.evaluate(({ dialog }, paths) => { let index = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog; }, [source, target]);
  await window.evaluate(async ({ source, target }) => {
    await window.desktopApi.chooseDirectory("source"); await window.desktopApi.chooseDirectory("target"); const draft = await window.desktopApi.configureSourceRule({ id: crypto.randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: crypto.randomUUID(), configuration: { type: "local", name: "本地批量识别验收", client: "custom", sourcePath: source, organization: { targetPath: target } } }); const p = await window.desktopApi.previewSourceRule({ id: draft.id, expectedVersion: 0, expectedDraftRevision: 1, requestKey: crypto.randomUUID() }); await window.desktopApi.applySourceRule({ previewId: p.id, requestKey: crypto.randomUUID() });
  }, { source, target });
  // 使用真实单调时钟等待生产稳定窗口，不注入 READY 或替换观察结果。
  await expect.poll(async () => { const result = await window.evaluate(() => window.desktopApi.listIngestionCandidates({})); return result.items.length === 2 && result.items.every((item) => item.state === "READY"); }, { timeout: 160000, intervals: [1000, 5000] }).toBe(true);
  expect(await window.evaluate(() => window.desktopApi.listTasks({}))).toMatchObject({ total: 0 }); await window.getByRole("link", { name: "待处理", exact: true }).click(); await window.getByRole("button", { name: "按目录查看", exact: true }).click(); await window.getByRole("button", { name: "查看目录文件", exact: true }).click();
  const panel = window.getByRole("region", { name: "目录文件与候选摘要", exact: true }); await expect(panel).toContainText("整组 2 项"); await panel.getByRole("button", { name: "选择本页可处理文件", exact: true }).click(); await panel.getByRole("button", { name: "提交所选文件识别（2）", exact: true }).click();
  await expect.poll(async () => (await window.evaluate(() => window.desktopApi.listRecognitionBatches({}))).items[0]?.submitted, { timeout: 20000 }).toBe(2);
  await expect.poll(async () => (await window.evaluate(() => window.desktopApi.listRecognitionBatches({}))).items[0]?.recognitionFailed, { timeout: 30000 }).toBe(2);
  const before = (await window.evaluate(() => window.desktopApi.listRecognitionBatches({}))).items[0]!; expect(before).toMatchObject({ failed: 0, submitted: 2, pending: 0, recognitionFailed: 2 }); await expect(window.getByLabel("批量识别逐项结果")).toContainText("TMDB");
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640)); await expect.poll(() => window.evaluate(() => innerWidth)).toBe(920); expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await window.screenshot({ path: "test-results/desktop/directory-batch-recognition.png", fullPage: true });
  const tasks = (await window.evaluate(() => window.desktopApi.listTasks({}))).items; expect(tasks).toHaveLength(2); await window.reload(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); await window.evaluate(() => window.desktopApi.restartCore()); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  expect((await window.evaluate(() => window.desktopApi.listRecognitionBatches({}))).items[0]).toMatchObject({ id: before.id, submitted: 2, recognitionFailed: 2 }); expect((await window.evaluate(() => window.desktopApi.listTasks({}))).items.map((row) => row.id).sort()).toEqual(tasks.map((row) => row.id).sort()); expect(await window.evaluate(() => window.desktopApi.listJobs())).toEqual([]);
  for (const episode of [1, 2]) expect(await readFile(join(source, `测试作品.S01E0${episode}.mp4`), "utf8")).toBe(`第 ${episode} 个原视频保留`); expect((await readdir(target)).filter((name) => name !== ".media-marshal")).toEqual([]);
});
test("来源删除确认、只读历史与恢复暂停经真实 IPC 保留，重载不重放", async () => {
  test.skip(process.platform !== "darwin");
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const canonical = await realpath(directory), source = join(canonical, "保留来源中文_".repeat(10)), target = join(canonical, "保留媒体库_".repeat(10)); await mkdir(source); await mkdir(target); await writeFile(join(source, "保留.mp4"), "原文件内容不能变化");
  await application.evaluate(({ dialog }, paths) => { let index = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog; }, [source, target]);
  const row = await window.evaluate(async ({ source, target }) => {
    await window.desktopApi.chooseDirectory("source"); await window.desktopApi.chooseDirectory("target");
    const draft = await window.desktopApi.configureSourceRule({ id: crypto.randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: crypto.randomUUID(), configuration: { type: "local", name: "来源删除与恢复中文名称_".repeat(5), client: "custom", sourcePath: source, organization: { targetPath: target } } });
    const p = await window.desktopApi.previewSourceRule({ id: draft.id, expectedVersion: 0, expectedDraftRevision: 1, requestKey: crypto.randomUUID() });
    return window.desktopApi.applySourceRule({ previewId: p.id, requestKey: crypto.randomUUID() });
  }, { source, target });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640));
  await window.getByRole("link", { name: "来源", exact: true }).click();
  const card = window.getByRole("article", { name: `来源 ${row.draft.name}`, exact: true }); await card.getByRole("button", { name: "删除来源…", exact: true }).click();
  const dialog = window.getByRole("dialog", { name: "删除来源？", exact: true }); await expect(dialog).toBeVisible(); await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await window.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(card.getByRole("button", { name: "删除来源…", exact: true })).toBeFocused(); expect((await window.evaluate((id) => window.desktopApi.getSourceRule(id), row.id))?.deletedAt).toBeNull();
  await card.getByRole("button", { name: "删除来源…", exact: true }).click(); expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0); await expect(dialog.getByRole("heading", { name: "删除来源？", exact: true })).toBeInViewport(); await dialog.screenshot({ path: "test-results/desktop/source-remove-confirmation.png" });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true); await dialog.getByRole("button", { name: "确认删除来源", exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(window.getByRole("button", { name: "添加来源", exact: true })).toBeFocused();
  expect(await window.evaluate(() => window.desktopApi.listSourceRules())).toEqual([]); await window.reload(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); await window.getByRole("link", { name: "来源", exact: true }).click(); await window.getByText("已删除来源（1）", { exact: true }).click();
  await window.getByRole("button", { name: "查看保留配置", exact: true }).click(); await expect(window.getByLabel("来源名称", { exact: true })).toBeDisabled(); await window.getByRole("button", { name: "关闭配置查看", exact: true }).click();
  await window.getByRole("button", { name: "恢复已删除来源…", exact: true }).click(); const restore = window.getByRole("dialog", { name: "恢复已删除来源？", exact: true }); await restore.getByRole("button", { name: "确认恢复来源", exact: true }).click(); await expect(restore).toHaveCount(0);
  const restored = await window.evaluate((id) => window.desktopApi.getSourceRule(id), row.id); expect(restored).toMatchObject({ id: row.id, version: 1, draftRevision: 1, lifecycleRevision: 2, deletedAt: null, paused: true });
  expect(await readFile(join(source, "保留.mp4"), "utf8")).toBe("原文件内容不能变化"); expect(await window.evaluate(() => window.desktopApi.listTasks({}))).toMatchObject({ total: 0 }); expect(await window.evaluate(() => window.desktopApi.listDownloads({}))).toMatchObject({ total: 0 });
  await window.reload(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); expect((await window.evaluate((id) => window.desktopApi.getSourceRule(id), row.id))?.paused).toBe(true);
});
test("全量内容复核经实际 IPC 保存逐项失败，重载和 Core 重启只恢复记录且不整理", async () => {
  test.skip(process.platform !== "darwin");
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const canonical = await realpath(directory), source = join(canonical, "内容复核 中文输入"), target = join(canonical, "独立媒体库"); await mkdir(source); await mkdir(target);
  const present = join(source, "中文长电影名称_".repeat(8) + ".mp4"), missing = join(source, "已知但暂时缺失.mp4"); await writeFile(present, "原始视频保留"); await writeFile(missing, "另一份视频");
  await application.evaluate(({ dialog }, paths) => { let index = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog; }, [source, target]);
  const applied = await window.evaluate(async ({ source, target }) => {
    await window.desktopApi.chooseDirectory("source"); await window.desktopApi.chooseDirectory("target");
    const draft = await window.desktopApi.configureSourceRule({ id: crypto.randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: crypto.randomUUID(), configuration: { type: "local", name: "本地内容复核验收", sourcePath: source, organization: { targetPath: target } } });
    const preview = await window.desktopApi.previewSourceRule({ id: draft.id, expectedVersion: 0, expectedDraftRevision: draft.draftRevision, requestKey: crypto.randomUUID() });
    return window.desktopApi.applySourceRule({ previewId: preview.id, requestKey: crypto.randomUUID() });
  }, { source, target });
  await window.evaluate((id) => window.desktopApi.scanIngestion(id), applied.id); await rename(missing, missing + ".保留"); const targetBefore = await readdir(target);
  await window.getByRole("link", { name: "待处理", exact: true }).click();
  const panel = window.getByRole("region", { name: "全量内容复核", exact: true }); await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "开始全量内容复核", exact: true }).click();
  await expect.poll(() => window.evaluate(() => window.desktopApi.listContentReviews({}))).toMatchObject({ total: 1, items: [{ state: "PARTIAL_FAILED", total: 2, checked: 2, failed: 1, baselined: 1 }] });
  const firstId = (await window.evaluate(() => window.desktopApi.listContentReviews({}))).items[0]!.id;
  await expect(panel).toContainText("部分文件未完成"); await panel.getByRole("button", { name: "查看逐项结果", exact: true }).click();
  await expect(panel.getByRole("region", { name: "内容复核逐项结果", exact: true })).toContainText("已知但暂时缺失.mp4"); await expect(panel).toContainText("未能复核");
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640)); expect(await window.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await panel.screenshot({ path: "test-results/desktop/content-review-partial-minimum.png" });
  await window.reload(); await expect(panel).toContainText("部分文件未完成"); expect((await window.evaluate(() => window.desktopApi.listContentReviews({}))).items[0]!.id).toBe(firstId);
  await rename(missing + ".保留", missing); await panel.getByRole("button", { name: "开始全量内容复核", exact: true }).click();
  await expect.poll(() => window.evaluate(() => window.desktopApi.listContentReviews({}))).toMatchObject({ total: 2, items: [{ state: "COMPLETED", checked: 2, failed: 0, changed: 0 }, { id: firstId, state: "PARTIAL_FAILED" }] });
  await window.evaluate(() => window.desktopApi.restartCore()); await expect.poll(() => window.evaluate(() => window.desktopApi.listContentReviews({}))).toMatchObject({ total: 2, items: [{ state: "COMPLETED" }, { id: firstId, state: "PARTIAL_FAILED" }] });
  expect(await window.evaluate(() => window.desktopApi.listTasks({}))).toMatchObject({ total: 0 }); expect(await readdir(target)).toEqual(targetBefore); expect(await readFile(present, "utf8")).toBe("原始视频保留"); expect(await readFile(missing, "utf8")).toBe("另一份视频");
});

test("来源表单按文件去向分组，长路径与最小窗口下开关文字保持相邻", async () => {
  test.skip(process.platform !== "darwin");
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const canonical = await realpath(directory), download = join(canonical, "中文下载目录_".repeat(9)), target = join(canonical, "中文媒体库目录_".repeat(8));
  await mkdir(download); await mkdir(target);
  await application.evaluate(({ dialog }, paths) => { let index = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog; }, [download, target]);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 900));
  await window.getByRole("link", { name: "来源", exact: true }).click(); await window.getByRole("button", { name: "添加来源", exact: true }).click();
  const form = window.getByRole("form", { name: "来源配置草稿" });
  await window.getByLabel("来源名称", { exact: true }).fill("追剧下载与媒体库整理"); await window.getByRole("button", { name: "选择下载目录", exact: true }).click();
  await expect(form.getByRole("region")).toHaveCount(4); await expect(window.getByLabel("文件处理流程")).toContainText(download);
  await expect(window.getByLabel("文件处理流程")).toContainText("未开启，仅保存下载文件");
  await expect(window.getByLabel("扫描间隔", { exact: true })).toHaveCount(0); await expect(window.getByLabel("媒体类型", { exact: true })).toHaveCount(0);
  await form.screenshot({ path: "test-results/desktop/source-form-cloud-download.png" });
  const periodic = window.getByRole("checkbox", { name: "定期检查网盘目录", exact: true }), organize = window.getByRole("checkbox", { name: "下载后整理到媒体库", exact: true });
  await periodic.focus(); await window.keyboard.press("Space"); await expect(periodic).toBeChecked(); await expect(window.getByLabel("扫描间隔", { exact: true })).toBeVisible();
  await organize.locator("..").click(); await expect(organize).toBeChecked(); await window.getByRole("button", { name: "选择整理目标目录", exact: true }).click();
  await expect(window.getByLabel("文件处理流程")).toContainText(target);
  for (const width of [1280, 920]) {
    await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 900), width);
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect.poll(() => window.getByLabel("文件处理流程").evaluate((flow) => getComputedStyle(flow).gridTemplateColumns.split(" ").length)).toBe(width === 920 ? 1 : 3);
    for (const checkbox of [periodic, organize]) {
      const geometry = await checkbox.evaluate((input) => { const box = input.getBoundingClientRect(), title = input.parentElement!.querySelector("strong")!.getBoundingClientRect(); return { boxWidth: box.width, titleWidth: title.width, gap: title.left - box.right, topDifference: Math.abs(title.top - box.top) }; });
      expect(geometry.boxWidth).toBeLessThanOrEqual(20); expect(geometry.boxWidth).toBeGreaterThanOrEqual(16); expect(geometry.titleWidth).toBeGreaterThan(100); expect(geometry.gap).toBeGreaterThanOrEqual(8); expect(geometry.gap).toBeLessThanOrEqual(16); expect(geometry.topDifference).toBeLessThan(8);
    }
  }
  await form.screenshot({ path: "test-results/desktop/source-form-cloud-organize-minimum.png" });
  await window.getByLabel("来源类型", { exact: true }).selectOption("local"); await expect(form.getByRole("region")).toHaveCount(3);
  await expect(periodic).toHaveCount(0); await expect(organize).toHaveCount(0); await expect(window.getByRole("button", { name: "选择本地输入目录", exact: true })).toBeVisible();
  await form.screenshot({ path: "test-results/desktop/source-form-local-minimum.png" });
  expect(await window.evaluate(() => window.desktopApi.listSourceRules())).toEqual([]); expect(await window.evaluate(() => window.desktopApi.listDownloads({}))).toMatchObject({ total: 0 }); expect(await window.evaluate(() => window.desktopApi.listTasks({}))).toMatchObject({ total: 0 });
});

test("统一来源草稿、原生授权确认及 Core 重启保留同一配置版本", async () => {
  test.skip(process.platform !== "darwin");
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const sourcePath = join(directory, "统一 中文来源"), targetPath = join(directory, "统一 中文目标"); await mkdir(sourcePath); await mkdir(targetPath);
  const source = await realpath(sourcePath), target = await realpath(targetPath);
  const unsupportedClient = await window.evaluate(async ({ source, target }) => {
    try { await window.desktopApi.configureSourceRule({ id: crypto.randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: crypto.randomUUID(), configuration: { type: "local", name: "未开放标签", client: "baidu", sourcePath: source, organization: { targetPath: target } } }); return null; }
    catch (error) { return (error as Error).message; }
  }, { source, target });
  expect(unsupportedClient).toContain("新建本地来源仅提供夸克客户端或自定义目录");
  const state = await window.evaluate(async ({ source, target }) => {
    const draft = await window.desktopApi.configureSourceRule({ id: crypto.randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: crypto.randomUUID(), configuration: { type: "local", name: "统一来源测试", client: "quark", sourcePath: source, ignoredFilePatterns: [], organization: { targetPath: target } } });
    const preview = await window.desktopApi.previewSourceRule({ id: draft.id, expectedVersion: draft.version, expectedDraftRevision: draft.draftRevision, requestKey: crypto.randomUUID() });
    return { draft, preview, requestKey: crypto.randomUUID() };
  }, { source, target });
  expect(state.draft).toMatchObject({ version: 0, draftRevision: 1, paused: true, configuration: null });
  expect(await window.evaluate(() => window.desktopApi.listSources())).toEqual([]);
  const refused = await window.evaluate(async ({ previewId, requestKey }) => { try { await window.desktopApi.applySourceRule({ previewId, requestKey }); return null; } catch (error) { return (error as Error).message; } }, { previewId: state.preview.id, requestKey: state.requestKey });
  expect(refused).toContain("系统对话框");
  await application.evaluate(({ dialog }, paths) => {
    let index = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog;
  }, [source, target]);
  await window.evaluate(async () => { await window.desktopApi.chooseDirectory("source"); await window.desktopApi.chooseDirectory("target"); });
  const applied = await window.evaluate(async ({ previewId, requestKey }) => Promise.all([window.desktopApi.applySourceRule({ previewId, requestKey }), window.desktopApi.applySourceRule({ previewId, requestKey })]), { previewId: state.preview.id, requestKey: state.requestKey });
  expect(applied[0]).toEqual(applied[1]); expect(applied[0]).toMatchObject({ id: state.draft.id, version: 1, localSourceId: state.draft.id });
  await window.evaluate(async (id) => {
    await window.desktopApi.controlSourceRule({ id, expectedVersion: 1, operation: "pause", requestKey: crypto.randomUUID() });
    await window.desktopApi.setOrganizePause({ paused: true, requestKey: crypto.randomUUID() });
    await window.desktopApi.setCloudDownloadPause({ paused: true, requestKey: crypto.randomUUID() });
  }, state.draft.id);
  await window.reload();
  expect(await window.evaluate((id) => window.desktopApi.getSourceRule(id), state.draft.id)).toMatchObject({ version: 1, configuration: { sourcePath: source, ignoredFilePatterns: [], organization: { targetPath: target } } });
  await window.evaluate(() => window.desktopApi.restartCore());
  await expect.poll(() => window.evaluate((id) => window.desktopApi.getSourceRule(id), state.draft.id)).toMatchObject({ id: state.draft.id, version: 1, localSourceId: state.draft.id });
  await expect.poll(() => window.evaluate(() => window.desktopApi.listSources())).toMatchObject([{ id: state.draft.id, health: "available" }]);
  expect(await window.evaluate(() => window.desktopApi.listSourceRules())).toHaveLength(1);
  expect(await window.evaluate((id) => window.desktopApi.getSourceRule(id), state.draft.id)).toMatchObject({ paused: true });
  expect(await window.evaluate(() => window.desktopApi.getOrganizePause())).toEqual({ paused: true });
  await window.evaluate((id) => window.desktopApi.controlSourceRule({ id, expectedVersion: 1, operation: "resume", requestKey: crypto.randomUUID() }), state.draft.id);
  expect(await window.evaluate(() => window.desktopApi.getOrganizePause())).toEqual({ paused: true });
  expect(await window.evaluate(() => window.desktopApi.getCloudDownloadPause())).toMatchObject({ paused: true });
  expect(await window.evaluate((id) => window.desktopApi.resolveSourceLegacy({ kind: "local-source", id }), state.draft.id)).toMatchObject({ sourceId: state.draft.id, status: "MAPPED" });
  expect(await window.evaluate(() => window.desktopApi.listTasks({}))).toMatchObject({ total: 0 });
});

test("本地来源重叠在界面定位原规则，改选独立目录后可重新预览确认", async () => {
  test.skip(process.platform !== "darwin");
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const canonical = await realpath(directory), source = join(canonical, "边界原输入"), target = join(canonical, "边界原媒体库"), independentSource = join(canonical, "独立输入"), independentTarget = join(canonical, "独立媒体库");
  for (const path of [source, target, independentSource, independentTarget]) await mkdir(path);
  await writeFile(join(source, "保留.mp4"), "original-media");
  await application.evaluate(({ dialog }, paths) => { let index = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog; }, [source, target, source, independentTarget, independentSource]);
  const original = await window.evaluate(async ({ source, target }) => {
    await window.desktopApi.chooseDirectory("source"); await window.desktopApi.chooseDirectory("target");
    const draft = await window.desktopApi.configureSourceRule({ id: crypto.randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: crypto.randomUUID(), configuration: { type: "local", name: "边界原来源_" + "A".repeat(80), sourcePath: source, organization: { targetPath: target } } });
    const preview = await window.desktopApi.previewSourceRule({ id: draft.id, expectedVersion: draft.version, expectedDraftRevision: draft.draftRevision, requestKey: crypto.randomUUID() });
    return window.desktopApi.applySourceRule({ previewId: preview.id, requestKey: crypto.randomUUID() });
  }, { source, target });
  await window.getByRole("link", { name: "来源", exact: true }).click(); await window.getByRole("button", { name: "添加来源", exact: true }).click();
  await window.getByLabel("来源类型", { exact: true }).selectOption("local"); await window.getByLabel("来源名称").fill("待修复来源");
  await window.getByRole("button", { name: "选择本地输入目录", exact: true }).click(); await window.getByRole("button", { name: "选择整理目标目录", exact: true }).click();
  await window.getByRole("button", { name: "预览配置", exact: true }).click(); await window.getByRole("button", { name: "确认配置生效", exact: true }).click();
  await expect(window.getByRole("alert")).toContainText("边界原来源"); await expect(window.getByRole("alert")).toContainText(original.id); await expect(window.getByRole("alert")).toContainText("选择独立目录");
  expect((await window.evaluate(() => window.desktopApi.listSources())).length).toBe(1); expect(await readdir(independentTarget)).toEqual([]);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640));
  expect(await window.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await window.getByRole("alert").scrollIntoViewIfNeeded(); await window.screenshot({ path: "test-results/desktop/source-overlap-recovery.png" });
  await window.getByRole("button", { name: "选择本地输入目录", exact: true }).click(); await expect(window.getByRole("alert")).toHaveCount(0);
  await window.getByRole("button", { name: "预览配置", exact: true }).click(); await window.getByRole("button", { name: "确认配置生效", exact: true }).click();
  await expect.poll(() => window.evaluate(() => window.desktopApi.listSources())).toHaveLength(2); expect(await readFile(join(source, "保留.mp4"), "utf8")).toBe("original-media");
  expect(await window.evaluate(() => window.desktopApi.listTasks({}))).toMatchObject({ total: 0 });
});

test("旧 schema 来源迁入统一页面，订阅旧链接定位原身份且重启不生成下载", async () => {
  const initialWindow = await application.firstWindow();
  await expect(initialWindow.getByText("核心已连接", { exact: true })).toBeVisible();
  await application.close();
  const profile = join(directory, "legacy-data"), seed = join(directory, "seed-legacy.mjs");
  await writeFile(seed, `
import { CoreDatabase, migrations } from ${JSON.stringify(pathToFileURL(resolve("packages/media-core/dist/infrastructure/database.js")).href)};
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const db = await CoreDatabase.open(join(process.argv[2], 'desktop.sqlite3'), migrations.slice(0, 8));
const sql = db.connection, stamp = '2026-10-20T01:00:00.000Z';
const localId = randomUUID(), subscriptionId = randomUUID(), account = randomUUID(), remote = randomUUID(), root = randomUUID(), preview = randomUUID();
sql.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,version,paused,created_at) VALUES(?,'升级前中文来源','baidu',?,?,'MOVIE','COPY',4,1,?)").run(localId, join(process.argv[2], '原输入'), join(process.argv[2], '原电影目标'), stamp);
const volume = {volumeId:randomUUID(),rootInode:'1',rootBirthtimeNs:'1',observedDevice:'1',fsTypeCode:'1',fsType:'fixture',caseSensitive:true,unicodeEquivalent:true,pathMaxBytes:4096};
sql.prepare("INSERT INTO managed_download_root VALUES(?,?,?,?,'UNAVAILABLE',?)").run(root,root,join(process.argv[2],'原下载目录'),JSON.stringify(volume),stamp);
sql.prepare("INSERT INTO cloud_account(id,name,provider_kind,status,created_at,updated_at) VALUES(?,'升级前账号','quark','AUTH_REQUIRED',?,?)").run(account,stamp,stamp);
sql.prepare("INSERT INTO remote_entry(id,account_id,name,type,observed_at) VALUES(?,?,'旧中文远端目录','directory',?)").run(remote,account,stamp);
const filters={extensions:['mp4'],names:['已授权单片.mp4']};
sql.prepare("INSERT INTO cloud_preview(id,account_id,remote_root_ref,target_root_id,request_key,snapshot_json,state,configuration_version,created_at,expires_at) VALUES(?,?,?,?,?,?,'CONFIRMED',5,?,?)").run(preview,account,remote,root,randomUUID(),JSON.stringify({layout:'drive',complete:true,filters,items:[],name:'旧中文远端目录'}),stamp,'2026-10-20T01:15:00.000Z');
sql.prepare("INSERT INTO cloud_subscription(id,account_id,remote_root_ref,target_root_id,filters_json,interval_seconds,enabled,configuration_version,confirmed_preview_id,created_at,updated_at) VALUES(?,?,?,?,?,900,0,5,?,?,?)").run(subscriptionId,account,remote,root,JSON.stringify(filters),preview,stamp,stamp);
sql.prepare("INSERT INTO cloud_subscription_runtime(subscription_id,state) VALUES(?,'PAUSED')").run(subscriptionId);
db.close(); console.log(JSON.stringify({localId,subscriptionId}));
`);
  const ids = await new Promise<{ localId: string; subscriptionId: string }>((resolveSeed, reject) => {
    execFile(createRequire(resolve("package.json"))("electron") as string, [seed, profile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (error, stdout) => {
      if (error) reject(error); else { try { resolveSeed(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
  });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: process.env.MARSHAL_EXECUTABLE ? process.env.MARSHAL_APP_PATH : undefined,
    args: [...(process.env.MARSHAL_EXECUTABLE ? [] : [process.env.MARSHAL_APP_PATH ?? resolve("apps/desktop")]), `--user-data-dir=${profile}`], env });
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const rules = await window.evaluate(() => window.desktopApi.listSourceRules());
  expect(rules).toHaveLength(2);
  expect(rules.find((rule) => rule.id === ids.localId)).toMatchObject({ version: 4, paused: true, reviewRequired: true, localSourceId: ids.localId, configuration: { type: "local", client: "baidu" } });
  expect(rules.find((rule) => rule.id === ids.subscriptionId)).toMatchObject({ version: 5, paused: true, subscriptionId: ids.subscriptionId,
    configuration: { filters: { extensions: ["mp4"], names: ["已授权单片.mp4"] }, periodic: { enabled: true, intervalSeconds: 900 }, organization: null } });
  await window.evaluate((id) => { location.hash = `/subscriptions/${id}`; }, ids.subscriptionId);
  await expect(window.getByRole("heading", { name: "来源配置", exact: true })).toBeVisible();
  await expect(window.getByLabel("扩展名过滤", { exact: true })).toHaveValue("mp4");
  await expect(window.getByLabel("精确文件名过滤", { exact: true })).toHaveValue("已授权单片.mp4");
  await expect(window.getByRole("checkbox", { name: "定期检查网盘目录", exact: true })).toBeChecked();
  await expect(window.getByRole("button", { name: "确认启用并扫描", exact: true })).toHaveCount(0);
  await window.screenshot({ path: "test-results/desktop/legacy-source-migration.png", fullPage: true });
  await window.reload(); await window.evaluate(() => window.desktopApi.restartCore());
  await expect.poll(() => window.evaluate(() => window.desktopApi.listSourceRules())).toHaveLength(2);
  expect(await window.evaluate(() => window.desktopApi.listDownloads({}))).toMatchObject({ total: 0 });
  expect(await window.evaluate(() => window.desktopApi.listTasks({}))).toMatchObject({ total: 0 });
  expect(await window.evaluate((id) => window.desktopApi.resolveSourceLegacy({ kind: "subscription", id }), ids.subscriptionId)).toMatchObject({ sourceId: ids.subscriptionId, status: "MAPPED" });
  await expect(stat(join(profile, `desktop.sqlite3.before-v${CORE_DATA_SCHEMA_VERSION}.bak`))).resolves.toMatchObject({ size: expect.any(Number) });
});
test("服务密钥经系统保险箱注入，窗口／核心／整应用重启后恢复且查询与命令行不回显", async () => {
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
    let window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
    const address = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    await window.evaluate(async ({ address, secret }) => { await window.desktopApi.saveSettings({ language: "zh-CN", embyUrl: address, tmdbProxy: "" }); await window.desktopApi.saveCredential("emby", secret); }, { address, secret });
    const read = () => window.evaluate(async () => { try { return (await window.desktopApi.listEmbyLibraries()).serverId; } catch { return "pending"; } });
    await expect.poll(read).toBe("fixture-server");
    await window.reload(); await expect.poll(read).toBe("fixture-server");
    await window.evaluate(() => window.desktopApi.restartCore()); await expect.poll(read).toBe("fixture-server");
    await application.close();
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ ...(process.env.MARSHAL_EXECUTABLE ? { executablePath: process.env.MARSHAL_APP_PATH } : {}), args: [...(process.env.MARSHAL_EXECUTABLE ? [] : [process.env.MARSHAL_APP_PATH ?? resolve("apps/desktop")]), `--user-data-dir=${join(directory, "data")}`], env });
    window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); await expect.poll(read).toBe("fixture-server");
    const credentialFile = join(directory, "data", "credentials.json"), values = JSON.parse(await readFile(credentialFile, "utf8")); values.tmdb = Buffer.from("损坏的测试服务密文").toString("base64"); await writeFile(credentialFile, JSON.stringify(values));
    await window.evaluate(() => window.desktopApi.restartCore()); await expect.poll(read).toBe("fixture-server");
    await expect(window.getByRole("alert")).toContainText("TMDB 的本机凭据无法解密");
    expect(JSON.parse(await readFile(credentialFile, "utf8")).tmdb).toBe(values.tmdb);
    await window.evaluate(() => window.desktopApi.saveCredential("tmdb", "fixture-repaired-tmdb")); await expect.poll(async () => (await window.evaluate(() => window.desktopApi.getRuntime())).detail).toBeNull();
    const settings = await window.evaluate(() => window.desktopApi.getSettings()); expect(settings.embyKeyConfigured).toBe(true); expect(JSON.stringify(settings)).not.toContain(secret);
    for (const name of ["desktop.sqlite3", "desktop.sqlite3-wal", "credentials.json"]) { const bytes = await readFile(join(directory, "data", name)).catch(() => Buffer.alloc(0)); expect(bytes.includes(Buffer.from(secret)), name).toBe(false); }
    const pids = await application.evaluate(({ app }) => [process.pid, ...app.getAppMetrics().filter((row) => row.name === "Media Marshal Core").map((row) => row.pid)]);
    expect(pids.length).toBeGreaterThan(1); for (const pid of pids) { const processIdentity = identify(pid); expect(processIdentity).toBeTruthy(); expect(processIdentity.command).not.toContain(secret); }
    expect(requests.length).toBeGreaterThanOrEqual(6); expect(requests.every((value) => value === secret)).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
test("仅电影目标绑定已有非空媒体库，Core 重启复核结果自动更新到设置页", async () => {
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const folder = join(directory, "中文媒体库"); await mkdir(folder); const target = await realpath(folder);
  const retained = join(target, "原有媒体.mp4"); await writeFile(retained, "原有媒体不得随绑定移动或改写");
  let holdInfo = false, refreshes = 0, serviceStatus = 200;
  const waiting = new Set<import("node:http").ServerResponse>();
  const info = { Id: "existing-server-fixture", Version: "4.9-fixture" };
  const server = createHttpServer((req, res) => {
    if (req.headers["x-emby-token"] !== "existing-server-test-key") { res.writeHead(401).end(); return; }
    if (serviceStatus !== 200) { res.writeHead(serviceStatus).end("fixture-private-server-error"); return; }
    const url = new URL(req.url!, "http://localhost"); res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/System/Info") {
      if (holdInfo) { waiting.add(res); res.once("close", () => waiting.delete(res)); return; }
      res.end(JSON.stringify(info));
    } else if (url.pathname === "/Library/VirtualFolders/Query") res.end(JSON.stringify({ Items: [{ ItemId: "movie-library", Name: "已有电影库", Locations: [target], CollectionType: "movies" }], TotalRecordCount: 1 }));
    else if (url.pathname === "/Items") res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
    else if (url.pathname === "/Library/Refresh") { refreshes++; res.writeHead(204).end(); }
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    await window.evaluate(async (address) => { await window.desktopApi.saveSettings({ language: "zh-CN", embyUrl: address, tmdbProxy: "" }); await window.desktopApi.saveCredential("emby", "existing-server-test-key"); }, address);
    await application.evaluate(({ dialog }, target) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [target] })) as typeof dialog.showOpenDialog; }, target);
    await window.getByRole("link", { name: "设置", exact: true }).click();
    await window.getByRole("button", { name: "选择电影目录", exact: true }).click();
    await expect.poll(() => window.evaluate(() => window.desktopApi.listMediaLibraries())).toMatchObject([{ mediaType: "MOVIE", path: target, available: true }]);
    await window.getByRole("button", { name: "读取 Emby 媒体库", exact: true }).click();
    await window.getByRole("combobox", { name: `选择服务端媒体库目录 · ${target}`, exact: true }).selectOption(JSON.stringify(["movie-library", target]));
    await window.getByRole("button", { name: "验证并保存（触发扫描）", exact: true }).click();
    await expect(window.getByText("连接已验证", { exact: true })).toBeVisible();
    const configured = await window.evaluate(() => window.desktopApi.getEmbyConfiguration());
    expect(configured?.libraries).toHaveLength(1);
    holdInfo = true; await window.evaluate(() => window.desktopApi.restartCore());
    await expect(window.getByText("连接尚未验证", { exact: true })).toBeVisible();
    await expect.poll(() => waiting.size).toBe(1);
    holdInfo = false; for (const response of waiting) response.end(JSON.stringify(info)); waiting.clear();
    await expect(window.getByText("连接已验证", { exact: true })).toBeVisible();
    expect(await window.evaluate(() => window.desktopApi.getEmbyConfiguration())).toEqual(configured);
    expect(await readFile(retained, "utf8")).toBe("原有媒体不得随绑定移动或改写");
    expect(await window.evaluate(() => window.desktopApi.listMediaLibraries())).toHaveLength(1);
    expect(await window.evaluate(() => window.desktopApi.listDownloads({}))).toMatchObject({ total: 0 });
    expect(await window.evaluate(() => window.desktopApi.listTasks({}))).toMatchObject({ total: 0 });
    expect(refreshes).toBe(2);
    await window.screenshot({ path: "test-results/desktop/emby-binding-revalidation.png", fullPage: true });
    serviceStatus = 503;
    await window.getByRole("button", { name: "读取 Emby 媒体库", exact: true }).click();
    await expect(window.getByText("暂时无法连接 Emby，请检查地址和服务状态后重试", { exact: true })).toBeVisible();
    expect(await readFile(retained, "utf8")).toBe("原有媒体不得随绑定移动或改写");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("任务分页筛选和 Core 重启／页面重载恢复持久状态，不提交新作业", async () => {
  test.skip(!!process.env.MARSHAL_EXECUTABLE, "当前 schema 的数据夹具使用工作区构建");
  const initial = await application.firstWindow(); await expect(initial.getByText("核心已连接", { exact: true })).toBeVisible(); await application.close();
  const profile = join(directory, "task-data"), seed = join(directory, "seed-tasks.mjs");
  await writeFile(seed, `
import { CoreDatabase } from ${JSON.stringify(pathToFileURL(resolve("packages/media-core/dist/infrastructure/database.js")).href)};
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const db=await CoreDatabase.open(join(process.argv[2],'desktop.sqlite3')), sql=db.connection, source=randomUUID(), stamp='2026-10-25T00:00:00.000Z';
sql.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'任务观测夹具','custom',?,?,'MOVIE','COPY',?)").run(source,join(process.argv[2],'来源'),join(process.argv[2],'目标'),stamp);
for(let index=0;index<36;index++) sql.prepare("INSERT INTO media_task(id,source_id,source_path,title,status,delivery_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(),source,join(process.argv[2],'中文长路径'.repeat(20),String(index)+'.mp4'),index===35?'失败作品中文长名称'.repeat(10):'持久任务 '+index,index===35?'FAILED':'DONE',index===35?'NOT_READY':'REFRESH_PENDING',stamp,stamp);
db.close();
`);
  await new Promise<void>((done, fail) => execFile(createRequire(resolve("package.json"))("electron") as string, [seed, profile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (error) => error ? fail(error) : done()));
  application = await _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${profile}`] });
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await window.getByRole("link", { name: "任务", exact: true }).click();
  await expect(window.locator("tbody tr")).toHaveCount(25);
  await window.getByRole("button", { name: "下一页", exact: true }).click(); await expect(window.locator("tbody tr")).toHaveCount(11);
  await window.getByRole("combobox", { name: "筛选任务状态", exact: true }).selectOption("FAILED"); await expect(window.locator("tbody tr")).toHaveCount(1);
  await expect(window.locator("tbody")).toContainText("失败作品中文长名称");
  await application.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
  await expect(window.locator("tbody tr")).toHaveCount(1);
  await window.evaluate(() => window.desktopApi.restartCore()); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await expect(window.locator("tbody tr")).toHaveCount(1); await expect(window.getByRole("combobox", { name: "筛选任务状态", exact: true })).toHaveValue("FAILED");
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640));
  expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await window.screenshot({ path: "test-results/desktop/tasks-filter-restored.png", fullPage: true });
  await window.reload(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); await expect(window.locator("tbody tr")).toHaveCount(25);
  expect(await window.evaluate(() => window.desktopApi.listTasks({}))).toMatchObject({ total: 36 });
  expect(await window.evaluate(() => window.desktopApi.listDownloads({}))).toMatchObject({ total: 0 });
});
test("单条与批量识别字段通过真实 IPC 预览保存，重载和 Core 重启不创建文件操作", async () => {
  test.skip(!!process.env.MARSHAL_EXECUTABLE, "识别字段夹具使用当前工作区构建");
  const initial = await application.firstWindow(); await expect(initial.getByText("核心已连接", { exact: true })).toBeVisible(); await application.close();
  const profile = join(directory, "recognition-data"), seed = join(directory, "seed-recognition.mjs");
  await writeFile(seed, `
import { CoreDatabase } from ${JSON.stringify(pathToFileURL(resolve("packages/media-core/dist/infrastructure/database.js")).href)};
import { normalizeParse } from ${JSON.stringify(pathToFileURL(resolve("packages/media-core/dist/domain/media.js")).href)};
import { randomUUID } from 'node:crypto'; import { mkdir,writeFile,lstat } from 'node:fs/promises'; import { join } from 'node:path';
const profile=process.argv[2], sourcePath=join(profile,'中文来源_'+ '长目录'.repeat(12)), targetPath=join(profile,'独立媒体库'); await mkdir(sourcePath,{recursive:true}); await mkdir(targetPath);
const db=await CoreDatabase.open(join(profile,'desktop.sqlite3')), sql=db.connection, source=randomUUID(), stamp=new Date().toISOString();
sql.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,paused,created_at) VALUES(?,'识别编辑夹具','custom',?,?,'AUTO','COPY',1,?)").run(source,sourcePath,targetPath,stamp);
for(const episode of [2,10]) {const id=randomUUID(), candidate=randomUUID(), name='中文作品.S01E'+episode+'.mp4', path=join(sourcePath,name); await writeFile(path,'保留原视频 '+episode); const info=await lstat(path,{bigint:true}), snapshot={device:String(info.dev),inode:String(info.ino),birthtimeNs:String(info.birthtimeNs),modifiedNs:String(info.mtimeNs),changedNs:String(info.ctimeNs),size:Number(info.size)}, parsed=normalizeParse({title:'原作品',type:'episode',season:1,episode,year:2026},name);
sql.prepare("INSERT INTO media_task(id,source_id,source_path,title,status,parsed_json,created_at,updated_at) VALUES(?,?,?,'原作品','AWAITING_CONFIRMATION',?,?,?)").run(id,source,path,JSON.stringify(parsed),stamp,stamp);
sql.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,attribute_key,is_current,snapshot_json,state,task_id,created_at,updated_at) VALUES(?,?,?,?,?,1,?,'QUEUED',?,?,?)").run(candidate,source,JSON.stringify([name]),id,id,JSON.stringify(snapshot),id,stamp,stamp); }
db.close();
`);
  await new Promise<void>((done, fail) => execFile(createRequire(resolve("package.json"))("electron") as string, [seed, profile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (error) => error ? fail(error) : done()));
  application = await _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${profile}`] }); const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); await window.getByRole("link", { name: "待处理", exact: true }).click();
  const tasks = (await window.evaluate(() => window.desktopApi.listTasks({}))).items; expect(tasks).toHaveLength(2);
  for (const name of ["中文作品.S01E2.mp4", "中文作品.S01E10.mp4"]) await window.getByRole("checkbox", { name: `选择识别任务 ${name}`, exact: true }).check();
  await window.getByRole("button", { name: "编辑选中识别（2）", exact: true }).click(); const editor = window.getByRole("region", { name: "编辑识别信息", exact: true });
  await editor.getByRole("checkbox", { name: "修改解析标题", exact: true }).check(); await editor.getByLabel("新解析标题", { exact: true }).fill("人工修订作品");
  expect((await window.evaluate(() => window.desktopApi.listTasks({}))).items.every((task) => task.title === "原作品")).toBe(true);
  await editor.getByRole("checkbox", { name: "按自然文件名生成集号", exact: true }).check(); await editor.getByLabel("顺序起始集号", { exact: true }).fill("5"); await editor.getByRole("button", { name: "预览识别字段变化", exact: true }).click(); await expect(editor).toContainText("S1 E5"); await expect(editor).toContainText("S1 E6");
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640)); await expect.poll(() => window.evaluate(() => innerWidth)).toBe(920); expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(await editor.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true); await editor.screenshot({ path: "test-results/desktop/recognition-edit-preview.png" });
  await editor.getByRole("button", { name: "仅保存识别信息", exact: true }).click(); await expect(editor).toContainText("已保存 2 项识别信息");
  const saved = await window.evaluate(async (ids) => Promise.all(ids.map((id) => window.desktopApi.getIngestionTask(id))), tasks.map((row) => row.id)); expect(saved.every((row) => row.revision === 1 && row.matchesStale && row.parsed?.title === "人工修订作品")).toBe(true); expect(saved.map((row) => row.parsed?.episode).sort()).toEqual([5, 6]);
  await window.reload(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); await window.evaluate(() => window.desktopApi.restartCore()); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  for (const task of tasks) { expect(await readFile(task.sourcePath, "utf8")).toMatch(/^保留原视频 /); expect(await window.evaluate((id) => window.desktopApi.getIngestionTask(id), task.id)).toMatchObject({ revision: 1, state: "AWAITING_CONFIRMATION", parsed: { title: "人工修订作品" } }); }
  expect(await window.evaluate(() => window.desktopApi.listJobs())).toEqual([]); expect(await readdir(join(profile, "独立媒体库"))).toEqual([]);
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
  if (process.platform === "darwin") expect(runtime.status?.correctionFiles).toBe("ready");
  expect(await window.evaluate(() => window.desktopApi.listCorrections({}))).toEqual({ items: [], total: 0 });
  const forbiddenCorrection = await window.evaluate(async () => { try { await window.desktopApi.previewCorrection({ taskId: crypto.randomUUID(), requestKey: crypto.randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, nativeFiles: { manifestPath: "/不允许提供的模块", manifestSha256: "a".repeat(64) } } as any); return null; } catch (error) { return { code: (error as { code: string }).code, message: (error as Error).message }; } });
  expect(forbiddenCorrection).toMatchObject({ message: "业务参数无效" });
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
  await expect(window.getByRole("link", { name: "目录订阅", exact: true })).toHaveCount(0);
  await window.evaluate(() => { location.hash = "/subscriptions"; });
  await expect(window.getByRole("heading", { name: "来源配置", exact: true })).toBeVisible();
  await expect(window.getByText(/目录订阅已并入来源配置/)).toBeVisible();
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
test("升级备份失败阻断接入和核心重试，修复私有目录后才能恢复", async () => {
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await window.evaluate(() => window.desktopApi.saveSettings({ language: "zh-CN", embyUrl: "", tmdbProxy: "http://127.0.0.1:8892" }));
  const profile = join(directory, "data"), runtimeFile = join(profile, "runtime-version.json"), backupRoot = join(profile, "private-backups");
  await expect.poll(async () => JSON.parse(await readFile(runtimeFile, "utf8")).schemaVersion).toBe(CORE_DATA_SCHEMA_VERSION);
  await application.close();
  const previous = JSON.parse(await readFile(runtimeFile, "utf8")); previous.appVersion = "升级前测试版本"; await writeFile(runtimeFile, JSON.stringify(previous));
  await rename(backupRoot, backupRoot + ".held"); await writeFile(backupRoot, "占用备份目录的测试文件", { flag: "wx", mode: 0o600 });
  const databaseBefore = await readFile(join(profile, "desktop.sqlite3"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ ...(process.env.MARSHAL_EXECUTABLE ? { executablePath: process.env.MARSHAL_APP_PATH } : {}), args: [...(process.env.MARSHAL_EXECUTABLE ? [] : [process.env.MARSHAL_APP_PATH ?? resolve("apps/desktop")]), `--user-data-dir=${profile}`], env });
  const failed = await application.firstWindow();
  await expect.poll(() => failed.evaluate(async () => (await window.desktopApi.getRuntime()).core)).toBe("failed");
  await expect(failed.evaluate(() => window.desktopApi.listSources())).rejects.toThrow();
  await expect(failed.evaluate(() => window.desktopApi.restartCore())).rejects.toThrow();
  expect((await failed.evaluate(() => window.desktopApi.getRuntime())).core).toBe("failed");
  expect((await readFile(join(profile, "desktop.sqlite3"))).equals(databaseBefore)).toBe(true);
  expect(await readFile(backupRoot, "utf8")).toBe("占用备份目录的测试文件");
  await expect(failed.getByText(/启动前检查未完成/)).toBeVisible(); await failed.screenshot({ path: "test-results/desktop/upgrade-backup-blocked.png" });
  await rm(backupRoot); await rename(backupRoot + ".held", backupRoot);
  await failed.evaluate(() => window.desktopApi.restartCore()); await expect(failed.getByText("核心已连接", { exact: true })).toBeVisible();
  expect((await failed.evaluate(() => window.desktopApi.getSettings())).tmdbProxy).toBe("http://127.0.0.1:8892");
  await expect.poll(async () => (await readdir(backupRoot)).filter((id) => /^[a-f0-9-]{36}$/.test(id)).length).toBe(1);
});
test("整包升级停写备份和原生恢复保留现存文件，重开核对数据", async () => {
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await application.evaluate(({ app, dialog }) => { const quit = app.quit.bind(app); app.quit = () => { app.quit = quit; }; dialog.showMessageBox = (async (options: any) => ({ response: options.title === "确认备份并退出" ? 1 : 0, checkboxChecked: false })) as typeof dialog.showMessageBox; });
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
  await window.getByRole("link", { name: "来源", exact: true }).click();
  await window.getByRole("button", { name: "添加来源", exact: true }).click();
  await window.getByRole("button", { name: "选择下载目录", exact: true }).click();
  await expect(window.getByLabel("本地下载目录", { exact: true })).toHaveValue("");
  await window.getByRole("button", { name: "选择下载目录", exact: true }).click();
  await expect.poll(async () => (await window.evaluate(() => window.desktopApi.listDownloadRoots())).length).toBe(1);
  await expect(window.getByLabel("本地下载目录", { exact: true })).toHaveValue((await window.evaluate(() => window.desktopApi.listDownloadRoots()))[0]!.id);
  const before = await window.evaluate(() => window.desktopApi.listDownloadRoots()); expect(before).toHaveLength(1); expect(before[0]?.state).toBe("AVAILABLE");
  await window.getByRole("button", { name: "选择下载目录", exact: true }).click();
  await expect.poll(async () => window.evaluate(() => window.desktopApi.listDownloadRoots())).toMatchObject([{ id: before[0]!.id, state: "AVAILABLE" }]);
  expect(await window.evaluate(() => window.desktopApi.listDownloadRoots())).toHaveLength(1);
  await window.evaluate(() => window.desktopApi.restartCore());
  await expect.poll(async () => (await window.evaluate(() => window.desktopApi.listDownloadRoots()))[0]?.state).toBe("AVAILABLE");
  expect((await window.evaluate(() => window.desktopApi.listDownloadRoots()))[0]?.id).toBe(before[0]?.id);
  await window.reload(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await window.getByRole("link", { name: "来源", exact: true }).click();
  await window.getByRole("button", { name: "添加来源", exact: true }).click(); await window.getByLabel("本地下载目录", { exact: true }).selectOption(before[0]!.id); await expect(window.getByLabel("本地下载目录", { exact: true })).toHaveValue(before[0]!.id);
  await window.screenshot({ path: "test-results/desktop/download-root.png" });
});
test("目录授权经实际 IPC 保留具体失败原因，未知管理标记不被认领", async () => {
  test.skip(process.platform !== "darwin");
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const selected = join(directory, "保留旧标记"), metadata = join(selected, ".media-marshal"); await mkdir(metadata, { recursive: true });
  const marker = JSON.stringify({ version: 1, grantId: "00000000-0000-4000-8000-000000000001", volumeId: "untrusted-fixture" });
  const { writeFile } = await import("node:fs/promises"); await writeFile(join(metadata, "owner.json"), marker); await writeFile(join(selected, "保留.mp4"), "preserved");
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog; }, selected);
  await window.getByRole("link", { name: "来源", exact: true }).click();
  await window.getByRole("button", { name: "添加来源", exact: true }).click();
  await window.getByRole("button", { name: "选择下载目录", exact: true }).click();
  await expect(window.getByRole("alert")).toContainText("目录管理标记无法与当前授权核对");
  await expect(window.getByRole("alert")).toContainText("不会自动接管或清理已有文件");
  expect(await window.evaluate(() => window.desktopApi.listDownloadRoots())).toEqual([]);
  expect(await readFile(join(metadata, "owner.json"), "utf8")).toBe(marker); expect(await readFile(join(selected, "保留.mp4"), "utf8")).toBe("preserved");
  await window.screenshot({ path: "test-results/desktop/download-root-ownership.png" });
  await application.evaluate(({ dialog, app }) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [app.getPath("userData")] })) as typeof dialog.showOpenDialog; });
  await window.getByRole("button", { name: "选择下载目录", exact: true }).click();
  await expect(window.getByRole("alert")).toContainText("应用安装或私有数据范围");
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog; }, join(directory, "missing"));
  await window.getByRole("button", { name: "选择下载目录", exact: true }).click();
  await expect(window.getByRole("alert")).toContainText("所选目录不可访问");
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog; });
  await window.getByRole("button", { name: "选择下载目录", exact: true }).click();
  expect(await window.evaluate(() => window.desktopApi.listDownloadRoots())).toEqual([]);
});
test("云端账号界面取消、无凭据回显与非法远端参数拒绝", async () => {
  const window = await application.firstWindow();
  await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  await window.getByRole("link", { name: "网盘账号", exact: true }).click();
  await expect(window.getByRole("heading", { name: "还没有云端账号" })).toBeVisible();
  await window.getByRole("button", { name: "连接夸克账号", exact: true }).click();
  await window.getByLabel("账号名称").fill("取消输入测试");
  await window.getByRole("button", { name: "手动 Cookie", exact: true }).click();
  await window.getByLabel("本人账号 Cookie").fill("fixture-cookie-never-submitted");
  await window.getByRole("button", { name: "取消", exact: true }).click();
  await window.getByRole("button", { name: "连接夸克账号", exact: true }).click();
  await window.getByRole("button", { name: "手动 Cookie", exact: true }).click();
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
  await window.getByRole("link", { name: "网盘账号", exact: true }).click();
  await window.getByRole("button", { name: "连接夸克账号", exact: true }).click();
  await window.getByLabel("账号名称").fill("失效授权测试");
  await window.getByRole("button", { name: "手动 Cookie", exact: true }).click();
  await window.getByLabel("本人账号 Cookie").fill("__pus=invalid; __puus=invalid");
  await window.getByRole("button", { name: "验证并连接", exact: true }).click();
  await expect(window.getByLabel("本人账号 Cookie")).toHaveCount(0);
  await expect.poll(async () => (await window.evaluate(() => window.desktopApi.listCloudAccounts()))[0]?.status, { timeout: 35000 }).toBe("AUTH_REQUIRED");
  const account = (await window.evaluate(() => window.desktopApi.listCloudAccounts()))[0]!;
  expect(account.rootRef).toBeNull(); expect(JSON.stringify(account)).not.toMatch(/cookie|credentialRef|bindingId|mount_path|raw_url/);
  await expect(window.getByRole("alert")).toBeVisible();
  await expect(window.getByRole("alert")).toContainText("账号需要重新授权");
  await window.getByRole("button", { name: "重新授权", exact: true }).click();
  await window.getByRole("button", { name: "手动 Cookie", exact: true }).click();
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
  await window.getByLabel("来源类型", { exact: true }).selectOption("local");
  await window.getByLabel("来源名称").fill("内测下载目录");
  await window.getByLabel("本地忽略规则", { exact: true }).selectOption("custom");
  await window.getByLabel("忽略文件名或目录", { exact: true }).fill("cache/\n*.tmp");
  await window.getByRole("button", { name: "选择本地输入目录", exact: true }).click();
  await window.getByRole("button", { name: "选择整理目标目录", exact: true }).click();
  await window.getByRole("link", { name: "网盘账号", exact: true }).click();
  await window.getByRole("link", { name: "来源", exact: true }).click();
  await expect(window.getByLabel("来源名称")).toHaveValue("内测下载目录");
  await expect(window.getByLabel("本地忽略规则", { exact: true })).toHaveValue("custom");
  await expect(window.getByLabel("忽略文件名或目录", { exact: true })).toHaveValue("cache/\n*.tmp");
  await window.getByRole("button", { name: "保存草稿", exact: true }).click();
  expect(await window.evaluate(() => window.desktopApi.listSources())).toEqual([]);
  await window.getByRole("button", { name: "预览配置", exact: true }).click();
  await window.getByRole("button", { name: "确认配置生效", exact: true }).click();
  await window.getByRole("button", { name: "取消编辑", exact: true }).click();
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
  const sourceRule = (await window.evaluate(() => window.desktopApi.listSourceRules()))[0]!;
  expect(sourceRule.configuration).toMatchObject({ type: "local", ignoredFilePatterns: ["cache/", "*.tmp"] });
  await window.getByRole("button", { name: "编辑并预览", exact: true }).click();
  await expect(window.getByLabel("本地忽略规则", { exact: true })).toHaveValue("custom");
  await expect(window.getByLabel("忽略文件名或目录", { exact: true })).toHaveValue("cache/\n*.tmp");
  expect(await window.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await window.getByLabel("本地忽略规则", { exact: true }).scrollIntoViewIfNeeded();
  await window.screenshot({ path: "test-results/desktop/sources-ignore-restored.png" });
});

test("启动后立即退出与加载窗口期间退出均不残留后启动的子进程", async () => {
  test.skip(!!process.env.MARSHAL_EXECUTABLE, "当前源码的启动竞态检查使用工作区构建");
  test.setTimeout(45000);
  for (const phase of ["立即退出", "窗口已创建"] as const) {
    const main = await application.evaluate(() => process.pid), owned = new Map<number, ReturnType<typeof identify>>();
    const observe = () => { for (const child of children(main)) { owned.set(child.pid, child); for (const nested of children(child.pid)) owned.set(nested.pid, nested); } };
    observe(); const timer = setInterval(observe, 25);
    try {
      if (phase === "窗口已创建") await application.firstWindow();
      await application.close();
      for (const identity of owned.values()) if (identity) await expect.poll(() => matches(identity, identity.command), { timeout: 5000 }).toBe(false);
    } finally {
      clearInterval(timer);
      for (const identity of owned.values()) if (identity && matches(identity, identity.command)) stopVerified(identity, identity.command);
    }
    if (phase === "立即退出") application = await _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${join(directory, "second-start")}`] });
  }
});

test("核心异常退出后恢复持久草稿并回收原解析器，不创建执行来源", async () => {
  const window = await application.firstWindow();
  await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const source = join(directory, "核心恢复来源"), target = join(directory, "核心恢复目标");
  await mkdir(source); await mkdir(target);
  const draft = await window.evaluate(({ source, target }) => window.desktopApi.configureSourceRule({
    id: crypto.randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: crypto.randomUUID(),
    configuration: { type: "local", name: "崩溃后保留草稿", sourcePath: source, organization: { targetPath: target } },
  }), { source, target });
  const before = await application.evaluate(({ app }) => {
    const path = process.getBuiltinModule("node:path"), fs = process.getBuiltinModule("node:fs");
    return { main: process.pid, core: app.getAppMetrics().find((row) => row.name === "Media Marshal Core")!.pid,
      parserRoot: fs.realpathSync(app.isPackaged ? path.join(process.resourcesPath, "parser") : path.join(app.getAppPath(), "resources/parser", `${process.platform}-${process.arch}`, "runtime")) };
  });
  const oldCore = identify(before.core); expect(oldCore?.parent).toBe(before.main);
  const parsers = children(before.core).filter((child: { command: string }) => child.command.includes(before.parserRoot));
  expect(parsers).toHaveLength(1);
  stopVerified(oldCore, oldCore.command);
  await expect.poll(() => matches(oldCore, oldCore.command)).toBe(false);
  for (const parser of parsers) await expect.poll(() => matches(parser, before.parserRoot), { timeout: 10000 }).toBe(false);
  await expect.poll(() => application.evaluate(({ app }, oldPid) => {
    const pid = app.getAppMetrics().find((row) => row.name === "Media Marshal Core")?.pid;
    return !!pid && pid !== oldPid;
  }, before.core)).toBe(true);
  await expect.poll(async () => {
    try { return (await window.evaluate(() => window.desktopApi.getRuntime())).status?.parser; } catch { return "pending"; }
  }).toBe("ready");
  expect(await window.evaluate((id) => window.desktopApi.getSourceRule(id), draft.id)).toMatchObject({ id: draft.id, version: 0, draftRevision: 1, configuration: null });
  expect(await window.evaluate(() => window.desktopApi.listSourceRules())).toHaveLength(1);
  expect(await window.evaluate(() => window.desktopApi.listSources())).toEqual([]);
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

test("季集分组跨目录选择、阻断重叠、模板预览与明确 COPY，重启保留原操作", async () => {
  test.skip(process.platform !== "darwin"); test.setTimeout(260000);
  let window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const canonical = await realpath(directory), source = join(canonical, "逐文件计划来源"), target = join(canonical, "逐文件计划媒体库"), profile = join(directory, "data"); await mkdir(source); await mkdir(target);
  for (const [n, parent] of [[1, "上半季"], [2, "下半季"]] as const) { await mkdir(join(source, parent)); await writeFile(join(source, parent, `作品.S01E0${n}.mkv`), `批量整理原内容 ${n}`); }
  await application.evaluate(({ dialog }, paths) => { let n = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[n++]!] })) as typeof dialog.showOpenDialog; }, [source, target]);
  await window.evaluate(async ({ source, target }) => {
    await window.desktopApi.chooseDirectory("source"); await window.desktopApi.chooseDirectory("target"); const draft = await window.desktopApi.configureSourceRule({ id: crypto.randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: crypto.randomUUID(), configuration: { type: "local", name: "批量整理窗口夹具", client: "custom", sourcePath: source, organization: { targetPath: target } } }); const preview = await window.desktopApi.previewSourceRule({ id: draft.id, expectedVersion: 0, expectedDraftRevision: 1, requestKey: crypto.randomUUID() }); await window.desktopApi.applySourceRule({ previewId: preview.id, requestKey: crypto.randomUUID() }); await window.desktopApi.saveCredential("tmdb", "isolated-cache-fixture-token");
  }, { source, target });
  await expect.poll(async () => (await window.evaluate(() => window.desktopApi.listIngestionCandidates({}))).total).toBe(2); await application.close();
  // 仅在隔离应用退出后准备待确认业务数据与有界 TMDB 缓存；文件观察、授权、预览和 COPY 仍使用当前生产代码。
  const seed = join(directory, "seed-organize.mjs"); await writeFile(seed, `
import { CoreDatabase } from ${JSON.stringify(pathToFileURL(resolve("packages/media-core/dist/infrastructure/database.js")).href)};
import { normalizeParse } from ${JSON.stringify(pathToFileURL(resolve("packages/media-core/dist/domain/media.js")).href)};
import { randomUUID,createHash } from 'node:crypto'; import { join } from 'node:path';
const db=await CoreDatabase.open(join(process.argv[2],'desktop.sqlite3')), sql=db.connection, stamp=new Date().toISOString();
for (const candidate of sql.prepare('SELECT * FROM ingestion_candidate ORDER BY relative_json').all()) { const name=JSON.parse(candidate.relative_json).at(-1), episode=Number(/E0?(\\d+)/.exec(name)[1]), id=randomUUID(), source=sql.prepare('SELECT source_path FROM desktop_source WHERE id=?').get(candidate.source_id).source_path;
sql.prepare("INSERT INTO media_task(id,source_id,source_path,title,status,parsed_json,created_at,updated_at) VALUES(?,?,?,'批量整理作品','AWAITING_CONFIRMATION',?,?,?)").run(id,candidate.source_id,join(source,...JSON.parse(candidate.relative_json)),JSON.stringify(normalizeParse({title:'批量整理作品',type:'episode',season:1,episode,year:2026},name)),stamp,stamp); sql.prepare("UPDATE ingestion_candidate SET task_id=?,state='QUEUED' WHERE id=?").run(id,candidate.id); sql.prepare("INSERT INTO task_candidate VALUES(?,?,?,?)").run(randomUUID(),id,JSON.stringify({tmdbId:7,mediaType:"TV_SHOW",title:"批量整理作品",originalTitle:null,year:2026,score:{confidence:0.9,titleScore:1,yearScore:1},evidence:"filename",parentOnlyCapped:false}),0.9); }
for (const [route,value] of [['tv/7',{id:7,name:'批量整理作品',first_air_date:'2026-01-01',seasons:[{season_number:1}]}],['tv/7/season/1',{episodes:[1,2].map(episode_number=>({season_number:1,episode_number,name:'第'+episode_number+'集'}))}]]) { const url=new URL(route,'https://api.themoviedb.org/3/');url.searchParams.set('language','zh-CN');const key=createHash('sha256').update('tmdb-v1|'+url.href).digest('hex');sql.prepare('INSERT INTO tmdb_cache(key,value,expires_at) VALUES(?,?,?)').run(key,JSON.stringify(value),Date.now()+600000); }
db.close();
`);
  await new Promise<void>((done, fail) => execFile(createRequire(resolve("package.json"))("electron") as string, [seed, profile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (error) => error ? fail(error) : done()));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; application = await _electron.launch({ executablePath: process.env.MARSHAL_EXECUTABLE ? process.env.MARSHAL_APP_PATH : undefined, args: [...(process.env.MARSHAL_EXECUTABLE ? [] : [process.env.MARSHAL_APP_PATH ?? resolve("apps/desktop")]), `--user-data-dir=${profile}`], env }); window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); await window.getByRole("link", { name: "待处理", exact: true }).click();
  await window.getByRole("button", { name: "按季集查看", exact: true }).click();
  const groups = window.getByRole("region", { name: "待确认季集候选组", exact: true }); await expect(groups).toContainText("共 2 项待确认"); await groups.getByRole("button", { name: "查看本季候选文件", exact: true }).click();
  const members = window.getByRole("region", { name: "季集候选文件与确认范围", exact: true }); await expect(members).toContainText("上半季/作品.S01E01.mkv"); await expect(members).toContainText("下半季/作品.S01E02.mkv");
  await members.getByRole("checkbox", { name: "季集选择 上半季/作品.S01E01.mkv", exact: true }).check(); await members.getByRole("button", { name: "预览本季所选文件（1）", exact: true }).click();
  await expect(window.getByRole("region", { name: "共同作品与逐文件整理草稿", exact: true }).getByLabel("共同 TMDB 作品 ID", { exact: true })).toHaveValue("7"); await window.getByRole("button", { name: "关闭整理草稿", exact: true }).click(); expect((await window.evaluate(() => window.desktopApi.listOrganizeBatches({}))).total).toBe(0);
  await members.getByRole("button", { name: "选择本页待确认文件", exact: true }).click(); await members.screenshot({ path: "test-results/desktop/season-candidates-selection.png" });
  await members.getByRole("button", { name: "预览本季所选文件（2）", exact: true }).click(); let editor = window.getByRole("region", { name: "共同作品与逐文件整理草稿", exact: true });
  await editor.getByLabel("共同 TMDB 作品 ID", { exact: true }).fill("7"); await editor.getByLabel(`起始集号 ${join(source, "下半季", "作品.S01E02.mkv")}`, { exact: true }).fill("1"); expect(await window.evaluate(() => window.desktopApi.listJobs())).toEqual([]);
  await editor.getByRole("button", { name: "生成所选文件的整理预览", exact: true }).click();
  // 重启后的真实 120 秒连续观察，不用就绪夹具绕过文件稳定性。
  await expect.poll(async () => (await window.evaluate(() => window.desktopApi.listOrganizeBatches({}))).items[0]?.state, { timeout: 165000, intervals: [1000, 5000] }).toBe("BLOCKED");
  const history = window.getByRole("region", { name: "批量整理预览与提交记录", exact: true }); await expect(history).toContainText("S1 E1"); await expect(history).toContainText("作品.S01E01.mkv"); await expect(history).toContainText("作品.S01E02.mkv"); expect(await window.evaluate(() => window.desktopApi.listJobs())).toEqual([]);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640)); await expect.poll(() => window.evaluate(() => innerWidth)).toBe(920); expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await history.screenshot({ path: "test-results/desktop/organize-batch-conflict.png" });
  await members.getByRole("button", { name: "预览本季所选文件（2）", exact: true }).click(); editor = window.getByRole("region", { name: "共同作品与逐文件整理草稿", exact: true }); await expect(editor.getByLabel("共同 TMDB 作品 ID", { exact: true })).toHaveValue("7"); await editor.getByLabel("本批命名模板", { exact: true }).fill("季集验收/{title}-S{season:02d}E{episode:02d}.{ext}"); await editor.getByRole("button", { name: "生成所选文件的整理预览", exact: true }).click();
  await expect.poll(async () => (await window.evaluate(() => window.desktopApi.listOrganizeBatches({}))).items[0]?.state).toBe("READY"); const ready = (await window.evaluate(() => window.desktopApi.listOrganizeBatches({}))).items[0]!;
  const submit = history.getByRole("button", { name: "确认提交本批 COPY（2）", exact: true }); await expect(submit).toBeDisabled(); expect(await window.evaluate(() => window.desktopApi.listJobs())).toEqual([]); await history.screenshot({ path: "test-results/desktop/organize-batch-ready.png" });
  await history.getByRole("checkbox", { name: "确认本批文件完整并核对计划", exact: true }).check(); await submit.click(); await expect.poll(async () => (await window.evaluate((id) => window.desktopApi.getOrganizeBatch({ id }), ready.id)).batch.done, { timeout: 35000 }).toBe(2);
  await expect.poll(async () => (await window.evaluate(() => window.desktopApi.listIngestionSeasons({}))).total).toBe(0);
  const details = await window.evaluate((id) => window.desktopApi.getOrganizeBatch({ id }), ready.id), operations = details.items.map((item) => item.operationId); expect(new Set(operations).size).toBe(2);
  for (const item of details.items) { expect(item.preview!.targetPath).toContain("季集验收"); const original = await readFile(item.sourcePath); expect(original.toString()).toBe(`批量整理原内容 ${item.preview!.episode}`); expect(await readFile(item.preview!.targetPath)).toEqual(original); } await window.reload(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); await window.evaluate(() => window.desktopApi.restartCore()); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  expect((await window.evaluate((id) => window.desktopApi.getOrganizeBatch({ id }), ready.id)).items.map((item) => item.operationId)).toEqual(operations); expect((await window.evaluate(() => window.desktopApi.listTasks({}))).total).toBe(2);
});

test("运行设置固定桥、关闭提醒与随包许可在最小窗口和重载后保持，登录注册不由读取重放", async () => {
  test.skip(process.platform !== "darwin"); test.setTimeout(70000);
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible();
  const nativeRead = await window.evaluate(() => window.desktopApi.getHostPreferences()); expect(nativeRead.loginSupported).toBe(!!process.env.MARSHAL_EXECUTABLE);
  // 隔离测试只替换系统登录项端口；不修改本机真实登录项或宣称已经验证注销重登。
  await application.evaluate(({ app, dialog }) => {
    const probe = { enabled: false, pending: false, calls: [] as boolean[], prompts: 0 }; (globalThis as any).__hostSettingsProbe = probe;
    app.getLoginItemSettings = (() => ({ openAtLogin: probe.enabled, status: probe.pending ? "requires-approval" : probe.enabled ? "enabled" : "not-registered" })) as typeof app.getLoginItemSettings;
    app.setLoginItemSettings = ((settings: { openAtLogin?: boolean }) => { probe.enabled = !!settings.openAtLogin; probe.pending = probe.enabled; probe.calls.push(probe.enabled); }) as typeof app.setLoginItemSettings;
    dialog.showMessageBox = (async () => { probe.prompts++; return { response: 0, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
  });
  const preferencesPath = join(directory, "data/host-preferences.json"); await expect(stat(preferencesPath)).rejects.toMatchObject({ code: "ENOENT" });
  await window.getByRole("link", { name: "设置", exact: true }).click(); const runtime = window.getByRole("region", { name: "运行方式", exact: true }); await expect(runtime).toContainText("托盘状态：已就绪");
  const login = runtime.getByRole("checkbox", { name: "登录后自动启动", exact: true }), reminder = runtime.getByRole("checkbox", { name: "首次关闭时提醒后台运行", exact: true }); await expect(reminder).toBeChecked(); await expect(login).not.toBeChecked();
  if (process.env.MARSHAL_EXECUTABLE) { await login.check(); } else { await expect(login).toBeDisabled(); }
  await reminder.uncheck(); expect(await application.evaluate(() => (globalThis as any).__hostSettingsProbe.calls)).toEqual([]); await runtime.getByRole("button", { name: "保存运行设置", exact: true }).click(); await expect(runtime).toContainText(process.env.MARSHAL_EXECUTABLE ? "仍等待系统批准" : "已保存运行设置");
  const registered = process.env.MARSHAL_EXECUTABLE ? [true] : []; expect(await application.evaluate(() => (globalThis as any).__hostSettingsProbe.calls)).toEqual(registered);
  expect(JSON.parse(await readFile(preferencesPath, "utf8"))).toEqual({ version: 1, remindOnClose: false }); expect((await stat(preferencesPath)).mode & 0o777).toBe(0o600);
  await window.reload(); await expect(runtime).toContainText("托盘状态：已就绪"); await expect(reminder).not.toBeChecked(); expect(await application.evaluate(() => (globalThis as any).__hostSettingsProbe.calls)).toEqual(registered);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()); await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false); expect(await application.evaluate(() => (globalThis as any).__hostSettingsProbe.prompts)).toBe(0); expect((await window.evaluate(() => window.desktopApi.getRuntime())).core).toBe("ready");
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.show(); BrowserWindow.getAllWindows()[0]!.setSize(920, 640); });
  await reminder.check(); await runtime.getByRole("button", { name: "保存运行设置", exact: true }).click(); await expect.poll(async () => JSON.parse(await readFile(preferencesPath, "utf8")).remindOnClose).toBe(true);
  for (const checkbox of [login, reminder]) expect(await checkbox.evaluate((input) => { const box = input.getBoundingClientRect(), text = input.parentElement!.querySelector("span")!.getBoundingClientRect(); return box.width >= 16 && box.width <= 20 && text.left - box.right >= 8 && text.left - box.right <= 16; })).toBe(true);
  expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await runtime.screenshot({ path: "test-results/desktop/host-settings-runtime-minimum.png" });
  const about = window.getByRole("region", { name: "关于与开源许可", exact: true }); const actual = await application.evaluate(({ app }) => app.getVersion()); await expect(about).toContainText(`Media Marshal ${actual}`);
  await about.getByRole("button", { name: "查看 Media Marshal 与自有文件组件 许可", exact: true }).click(); await expect(about.getByLabel("许可与来源说明", { exact: true })).toContainText("GNU GENERAL PUBLIC LICENSE"); await about.screenshot({ path: "test-results/desktop/host-settings-about-minimum.png" }); await about.getByRole("button", { name: "关闭许可原文", exact: true }).click();
  for (const id of ["framework", "parser", "openlist", "rclone", "guardian"] as const) expect((await window.evaluate((id) => window.desktopApi.getLicenseText(id), id)).text.length).toBeGreaterThan(100);
  await expect(window.evaluate(() => window.desktopApi.getLicenseText("../../credentials.json" as never))).rejects.toThrow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()); await expect.poll(() => application.evaluate(() => (globalThis as any).__hostSettingsProbe.prompts)).toBe(1); expect(await application.evaluate(() => (globalThis as any).__hostSettingsProbe.calls)).toEqual(registered); await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false);
  if (process.env.MARSHAL_EXECUTABLE) {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show()); await login.uncheck(); await runtime.getByRole("button", { name: "保存运行设置", exact: true }).click(); await expect(runtime).toContainText("未注册登录启动"); await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()); await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false); expect(await application.evaluate(() => (globalThis as any).__hostSettingsProbe.prompts)).toBe(1); expect(await application.evaluate(() => (globalThis as any).__hostSettingsProbe.calls)).toEqual([true, false]);
  }
});

test("升级前的原生确认默认取消，取消不停止核心、不创建备份且不触碰媒体", async () => {
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); const media = join(directory, "原媒体保持.txt"); await writeFile(media, "不修改现存媒体");
  await application.evaluate(({ dialog }) => { (globalThis as any).__upgradeQuestions = []; dialog.showMessageBox = (async (options: any) => { (globalThis as any).__upgradeQuestions.push(options); return { response: 0, checkboxChecked: false }; }) as typeof dialog.showMessageBox; });
  const backupRoot = join(directory, "data/private-backups"), before = (await readdir(backupRoot)).sort();
  await window.getByRole("link", { name: "设置", exact: true }).click(); await window.getByRole("button", { name: "准备升级并退出", exact: true }).click();
  await expect.poll(() => application.evaluate(() => (globalThis as any).__upgradeQuestions.length)).toBe(1); await expect(window.getByRole("button", { name: "准备升级并退出", exact: true })).toBeEnabled();
  expect(await application.evaluate(() => (globalThis as any).__upgradeQuestions[0])).toMatchObject({ title: "确认备份并退出", defaultId: 0, cancelId: 0, buttons: ["取消", "备份并退出"] });
  expect((await readdir(backupRoot)).sort()).toEqual(before); expect((await window.evaluate(() => window.desktopApi.getRuntime())).core).toBe("ready"); expect(await window.evaluate(() => window.desktopApi.listSources())).toEqual([]); expect(await readFile(media, "utf8")).toBe("不修改现存媒体");
});

test("服务地址和代理在页面提交前校验，非法配置不替换原值，合法代理可跨 Core 重启", async () => {
  const window = await application.firstWindow(); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); const original = await window.evaluate(() => window.desktopApi.getSettings());
  await window.getByRole("link", { name: "设置", exact: true }).click(); const proxy = window.locator("#settings-tmdb-proxy"), emby = window.locator("#settings-emby-url"), save = window.getByRole("button", { name: "保存", exact: true });
  await proxy.fill("file:///invalid-proxy"); await save.click(); await expect(window.getByRole("alert").filter({ hasText: "TMDB 代理只支持" })).toBeVisible(); expect((await window.evaluate(() => window.desktopApi.getSettings())).tmdbProxy).toBe(original.tmdbProxy);
  await proxy.fill(""); await emby.fill("http://private-fixture-secret@localhost:8096"); await save.click(); const error = window.getByRole("alert").filter({ hasText: "Emby 地址只支持" }); await expect(error).toBeVisible(); await expect(error).not.toContainText("private-fixture-secret"); expect((await window.evaluate(() => window.desktopApi.getSettings())).embyUrl).toBe(original.embyUrl);
  await emby.fill(original.embyUrl); await proxy.fill("http://127.0.0.1:7890"); await save.click(); await expect(window.getByText("配置已保存", { exact: true })).toBeVisible(); await window.evaluate(() => window.desktopApi.restartCore()); await expect(window.getByText("核心已连接", { exact: true })).toBeVisible(); expect((await window.evaluate(() => window.desktopApi.getSettings())).tmdbProxy).toBe("http://127.0.0.1:7890");
});
