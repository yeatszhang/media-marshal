import { expect, test, _electron } from "@playwright/test";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

test("同步预览高亮冲突并在确认按钮旁解释拦截原因", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marshal-sync-feedback-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${join(directory, "data")}`], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    const canonical = await realpath(directory), input = join(canonical, "输入"), target = join(canonical, "下载");
    await mkdir(input); await mkdir(target);
    await writeFile(join(input, "冲突原片.mp4"), "本次来源内容");
    await writeFile(join(input, "正常原片.mp4"), "正常来源内容");
    await app.evaluate(({ dialog }, paths) => {
      let index = 0;
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog;
    }, [input, target]);
    const inputId = await page.evaluate(async () => {
      const input = await window.desktopApi.chooseConfigurationDirectory("ordinary");
      const target = await window.desktopApi.chooseConfigurationDirectory("managed");
      await window.desktopApi.setDefaultDownloadDirectory({ expectedVersion: 0, directoryId: target!.id, requestKey: crypto.randomUUID() });
      return input!.id;
    });
    await mkdir(join(target, "completed"), { recursive: true });
    await writeFile(join(target, "completed", "冲突原片.mp4"), "原有目标内容");
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "来源", exact: true }).click();
    await page.getByRole("button", { name: "添加同步来源", exact: true }).click();
    await page.getByLabel("来源名称", { exact: true }).fill("冲突反馈验证");
    await page.getByLabel("本地输入目录", { exact: true }).selectOption(inputId);
    await page.getByRole("button", { name: "保存草稿并预览", exact: true }).click();
    const preview = page.getByRole("region", { name: "同步预览", exact: true });
    await expect(preview.locator(".sync-conflict-count")).toHaveText("冲突 1");
    await expect(preview.locator(".sync-file-blocked")).toContainText("冲突原片.mp4");
    await expect(preview.locator(".sync-file-blocked")).toContainText("目标已被其他内容占用");
    const confirm = preview.getByRole("button", { name: "确认配置范围", exact: true });
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAccessibleDescription(/有 1 项冲突.*处理后重新预览/);
    for (const width of [1240, 920]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 820), width);
      await expect(preview.locator(".sync-file-blocked")).toHaveCSS("background-color", "rgb(255, 243, 241)");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await preview.screenshot({ path: `test-results/desktop/sync-preview-conflict-${width}.png` });
    }
    expect(await page.evaluate(() => window.desktopApi.listSyncJobs())).toMatchObject({ total: 0 });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test("同步优先复核 Emby 目录已有文件，窗口标记已在媒体库且重载不复制", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-sync-library-")));
  const input = join(directory, "输入"), target = join(directory, "下载"), media = join(directory, "媒体库"), name = "已下载原片 [中文].mp4", content = "媒体文件已存在，跳过同步并保留原文件。";
  await Promise.all([mkdir(input), mkdir(target), mkdir(media)]);
  await Promise.all([writeFile(join(input, name), content), writeFile(join(media, name), content)]);
  const inode = (await stat(join(media, name))).ino;
  let refreshes = 0;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers["x-emby-token"] !== "isolated-library-test") { res.writeHead(401).end(); return; }
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/System/Info") res.end(JSON.stringify({ Id: "test-server", Version: "4.9-fixture" }));
    else if (url.pathname === "/Library/VirtualFolders/Query") res.end(JSON.stringify({ Items: [{ ItemId: "movies", Name: "测试电影", Locations: [media], CollectionType: "movies" }], TotalRecordCount: 1 }));
    else if (url.pathname === "/Items") res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
    else if (url.pathname === "/Library/Refresh") { refreshes++; res.writeHead(204).end(); }
    else res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")); delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${join(directory, "data")}`], env });
  try {
    const page = await app.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await app.evaluate(({ dialog }, paths) => { let index = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog; }, [input, target, media]);
    const inputId = await page.evaluate(async ({ address, media }) => {
      const input = await window.desktopApi.chooseConfigurationDirectory("ordinary"), target = await window.desktopApi.chooseConfigurationDirectory("managed");
      await window.desktopApi.setDefaultDownloadDirectory({ expectedVersion: 0, directoryId: target!.id, requestKey: crypto.randomUUID() });
      const libraries = await window.desktopApi.chooseMediaTarget("MOVIE");
      await window.desktopApi.saveSettings({ language: "zh-CN", embyUrl: address, tmdbProxy: "" });
      await window.desktopApi.saveCredential("emby", "isolated-library-test");
      await window.desktopApi.connectEmby({ serverId: "test-server", libraries: [{ targetId: libraries[0]!.targetId, libraryId: "movies", libraryPath: media }] });
      return input!.id;
    }, { address, media });
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "来源", exact: true }).click();
    await page.getByRole("button", { name: "添加同步来源", exact: true }).click();
    await page.getByLabel("来源名称", { exact: true }).fill("已有媒体优先检查");
    await page.getByLabel("本地输入目录", { exact: true }).selectOption(inputId);
    await page.getByRole("button", { name: "保存草稿并预览", exact: true }).click();
    const preview = page.getByRole("region", { name: "同步预览", exact: true });
    await expect(preview).toContainText("已在媒体库 1"); await expect(preview.locator(".sync-files")).toContainText(join(media, name));
    await expect(preview.locator(".sync-files")).toContainText("已在媒体库"); await expect(preview).toContainText("观察中 0");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await preview.screenshot({ path: "test-results/desktop/sync-existing-library-preview.png" });
    await preview.getByLabel("确认配置时执行一次", { exact: false }).check();
    await preview.getByLabel("我已确认本次本地文件完整，允许复制此精确清单", { exact: true }).check();
    await page.evaluate(() => window.desktopApi.setCloudDownloadPause({ paused: true, requestKey: crypto.randomUUID() }));
    await preview.getByRole("button", { name: "确认配置范围", exact: true }).click();
    const waitingDetail = page.getByRole("dialog", { name: "同步任务详情", exact: true });
    await expect(waitingDetail).toContainText("全部同步下载已暂停");
    await page.evaluate(async () => {
      const source = (await window.desktopApi.listSyncSources({}))[0]!;
      await window.desktopApi.controlSyncSource({ id: source.id, expectedVersion: source.version, expectedDraftRevision: source.draftRevision, expectedLifecycleRevision: source.lifecycleRevision, operation: "pause", requestKey: crypto.randomUUID() });
    });
    await expect(waitingDetail).toContainText("来源同步已暂停");
    await expect(waitingDetail).toContainText("全部同步下载已暂停");
    await waitingDetail.screenshot({ path: "test-results/desktop/sync-job-paused-detail.png" });
    await waitingDetail.getByRole("button", { name: "关闭任务详情", exact: true }).click();
    const jobs = page.locator("section").filter({ has: page.getByRole("heading", { name: "同步任务", exact: true }) });
    await expect(jobs).toContainText("恢复来源同步"); await expect(jobs).toContainText("恢复全部同步下载");
    for (const width of [1240, 920]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 820), width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await jobs.screenshot({ path: `test-results/desktop/sync-job-paused-${width}.png` });
    }
    await page.getByRole("button", { name: "恢复来源同步", exact: true }).click();
    await expect(jobs).not.toContainText("来源同步已暂停"); await expect(jobs).toContainText("全部同步下载已暂停");
    await page.getByRole("button", { name: "恢复全部同步下载", exact: true }).click();
    await expect(jobs).not.toContainText("全部同步下载已暂停");
    await page.getByRole("button", { name: "查看任务明细", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.desktopApi.listSyncJobs({}))).toMatchObject({ items: [{ state: "DONE", files: 1, inLibrary: 1, done: 0, waitingReason: null }] });
    const detail = page.getByRole("dialog", { name: "同步任务详情", exact: true }); await expect(detail).toContainText("已在媒体库 1");
    await page.reload(); await expect(detail).toContainText("已在媒体库 1"); await expect(detail.locator(".sync-files")).toContainText(join(media, name));
    for (const width of [1240, 920]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 820), width);
      await expect(detail).toBeVisible();
      expect(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await detail.screenshot({ path: `test-results/desktop/sync-job-modal-${width}.png` });
    }
    await page.keyboard.press("Escape"); await expect(detail).not.toBeVisible();
    const trigger = page.getByRole("button", { name: "查看任务明细", exact: true });
    await trigger.click(); await expect(detail).toBeVisible();
    await detail.getByRole("button", { name: "关闭任务详情", exact: true }).click(); await expect(trigger).toBeFocused();
    await page.getByRole("button", { name: "删除任务…", exact: true }).click();
    const removal = page.getByRole("dialog", { name: "删除同步任务", exact: true });
    await expect(removal).toContainText("成功历史保留");
    await removal.getByRole("button", { name: "取消", exact: true }).click();
    expect(await page.evaluate(() => window.desktopApi.listSyncJobs())).toMatchObject({ total: 1 });
    await page.getByRole("button", { name: "删除任务…", exact: true }).click();
    await removal.getByRole("button", { name: "确认删除同步任务", exact: true }).click();
    await expect(removal).not.toBeVisible(); await expect(page.getByText("暂无同步任务。", { exact: true })).toBeVisible();
    await page.reload(); expect(await page.evaluate(() => window.desktopApi.listSyncJobs())).toMatchObject({ total: 0 });
    await expect(readFile(join(target, "completed", name))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(media, name), "utf8")).toBe(content); expect((await stat(join(media, name))).ino).toBe(inode);
    expect(await page.evaluate(() => window.desktopApi.listDownloads({}))).toMatchObject({ total: 0 }); expect(refreshes).toBe(1);
  } finally {
    await app.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});


test("暂停网盘任务显式复核改名视频，失败可见且重载保留跳过证据", async () => {
  test.setTimeout(90000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-recheck-window-"))), target = join(directory, "下载 中文"), media = join(directory, "媒体库 中文");
  const folder = join(media, "猫头鹰谋杀案 (2024) [tmdbid=241548]", "Season 01"), mediaName = "猫头鹰谋杀案 (2024) - S01E04 - 2160p.mp4", content = "窗口复核夹具，媒体已存在且整理改名。";
  await mkdir(target); await mkdir(folder, { recursive: true }); await writeFile(join(folder, mediaName), content); const inode = (await stat(join(folder, mediaName))).ino;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/System/Info") res.end(JSON.stringify({ Id: "recheck-server", Version: "4.9-fixture" }));
    else if (url.pathname === "/Library/VirtualFolders/Query") res.end(JSON.stringify({ Items: [{ ItemId: "movies", Name: "隔离复核库", Locations: [media], CollectionType: "movies" }], TotalRecordCount: 1 }));
    else if (url.pathname === "/Items") res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
    else res.writeHead(204).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); const address = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")); delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${join(directory, "data")}`], env });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await app.evaluate(({ dialog }, paths) => { let i = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[i++]!] })) as typeof dialog.showOpenDialog; }, [target, media]);
    const rootId = await page.evaluate(async ({ media, address }) => {
      const target = await window.desktopApi.chooseConfigurationDirectory("managed");
      await window.desktopApi.setDefaultDownloadDirectory({ expectedVersion: 0, directoryId: target!.id, requestKey: crypto.randomUUID() });
      const libraries = await window.desktopApi.chooseMediaTarget("MOVIE");
      await window.desktopApi.saveSettings({ language: "zh-CN", embyUrl: address, tmdbProxy: "" }); await window.desktopApi.saveCredential("emby", "isolated-recheck-test");
      await window.desktopApi.connectEmby({ serverId: "recheck-server", libraries: [{ targetId: libraries[0]!.targetId, libraryId: "movies", libraryPath: media }] });
      return target!.id;
    }, { media, address });
    await app.close();
    const config = join(directory, "seed-recheck.json"); await writeFile(config, JSON.stringify({ database: join(directory, "data/desktop.sqlite3"), rootId, size: Buffer.byteLength(content) }));
    const seeded = await new Promise<string>((done, fail) => execFile(createRequire(resolve("package.json"))("electron") as string, [resolve("tools/desktop-files/seed-sync-library-recheck.mjs"), config], { cwd: resolve("."), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20000 }, (error, stdout) => error ? fail(error) : done(stdout)));
    const fixture = JSON.parse(seeded.trim()) as { jobId: string; sourceId: string };
    app = await launch(); page = await app.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "来源", exact: true }).click();
    await page.getByRole("button", { name: "查看任务明细", exact: true }).click(); const detail = page.getByRole("dialog", { name: "同步任务详情", exact: true });
    await expect(detail.getByRole("button", { name: "重新核对媒体库已有文件", exact: true })).toBeEnabled();
    // 先验证目录失联的持久反馈，再恢复同一原目录重试。
    await import("node:fs/promises").then(({ rename }) => rename(media, media + "-离线"));
    await detail.getByRole("button", { name: "重新核对媒体库已有文件", exact: true }).click();
    await expect(detail.getByRole("alert")).toContainText("媒体库检查未完成"); await expect(detail.locator(".sync-file-blocked")).toContainText("Moonflower Murders S01E04");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640)); await detail.screenshot({ path: "test-results/desktop/sync-library-recheck-failed-920.png" });
    await import("node:fs/promises").then(({ rename }) => rename(media + "-离线", media));
    await detail.getByRole("button", { name: "重新核对媒体库已有文件", exact: true }).click();
    await expect(detail).toContainText("媒体库核对完成：本次跳过 1 个视频"); await expect(detail.locator(".sync-files")).toContainText("作品、季集、格式和字节大小一致"); await expect(detail.locator(".sync-files")).toContainText(join(folder, mediaName));
    await page.reload(); await expect(detail).toContainText("媒体库核对完成：本次跳过 1 个视频");
    await page.evaluate(() => window.desktopApi.restartCore()); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await expect(detail).toContainText("媒体库核对完成：本次跳过 1 个视频");
    expect(await page.evaluate(({ sourceId }) => window.desktopApi.listSyncSources({}).then((rows) => rows.find((row) => row.id === sourceId)?.paused), fixture)).toBe(true);
    for (const width of [1240, 920]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 820), width);
      expect(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true); await detail.screenshot({ path: `test-results/desktop/sync-library-recheck-done-${width}.png` });
    }
    await page.keyboard.press("Escape"); await expect(detail).not.toBeVisible(); expect((await stat(join(folder, mediaName))).ino).toBe(inode); expect(await readFile(join(folder, mediaName), "utf8")).toBe(content);
    await expect(readFile(join(target, "completed", "视频电影", "X 喜鹊+猫头鹰+翠鸟谋杀案", "猫头鹰谋杀案 (2024)", "第 1 季 - 2160p WEB-DL H265 10bit AAC", "Moonflower Murders S01E04 - 第 4 集 - 2160p WEB-DL H265 10bit AAC.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await app.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await rm(directory, { recursive: true, force: true }); }
});

for (const decision of ["USE_LIBRARY", "DOWNLOAD"] as const) test(`疑似重复窗口逐项核对 ${decision}，决定重载后保留`, async () => {
  test.setTimeout(90000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-library-review-"))), target = join(directory, "下载 中文"), media = join(directory, "媒体库 中文"), folder = join(media, "小城日常 (2025) [tmdbid=272118]", "Season 01");
  const name = "小城日常 (2025) - S01E12.mp4", content = "隔离窗口的原有剧集内容", path = join(folder, name);
  await mkdir(target); await mkdir(folder, { recursive: true }); await writeFile(path, content); const inode = (await stat(path)).ino;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json"); const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/System/Info") res.end(JSON.stringify({ Id: "review-server", Version: "4.9-fixture" }));
    else if (url.pathname === "/Library/VirtualFolders/Query") res.end(JSON.stringify({ Items: [{ ItemId: "movies", Name: "隔离核对库", Locations: [media], CollectionType: "movies" }], TotalRecordCount: 1 }));
    else if (url.pathname === "/Items") res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 })); else res.writeHead(204).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); const address = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")); delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${join(directory, "data")}`], env }); let app = await launch();
  try {
    let page = await app.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await app.evaluate(({ dialog }, paths) => { let i = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[i++]!] })) as typeof dialog.showOpenDialog; }, [target, media]);
    const rootId = await page.evaluate(async ({ media, address }) => {
      const target = await window.desktopApi.chooseConfigurationDirectory("managed"); await window.desktopApi.setDefaultDownloadDirectory({ expectedVersion: 0, directoryId: target!.id, requestKey: crypto.randomUUID() });
      const libraries = await window.desktopApi.chooseMediaTarget("MOVIE"); await window.desktopApi.saveSettings({ language: "zh-CN", embyUrl: address, tmdbProxy: "" }); await window.desktopApi.saveCredential("emby", "isolated-review-test");
      await window.desktopApi.connectEmby({ serverId: "review-server", libraries: [{ targetId: libraries[0]!.targetId, libraryId: "movies", libraryPath: media }] }); return target!.id;
    }, { media, address });
    await app.close(); const config = join(directory, "seed-review.json"); await writeFile(config, JSON.stringify({ database: join(directory, "data/desktop.sqlite3"), rootId, size: Buffer.byteLength(content), reviewPreview: true, segments: ["视频电影", "未知资源", "12.mp4"] }));
    const seeded = await new Promise<string>((done, fail) => execFile(createRequire(resolve("package.json"))("electron") as string, [resolve("tools/desktop-files/seed-sync-library-recheck.mjs"), config], { cwd: resolve("."), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20000 }, (error, stdout) => error ? fail(error) : done(stdout))), fixture = JSON.parse(seeded.trim()) as { previewId: string };
    app = await launch(); page = await app.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible(); await page.evaluate(({ previewId }) => { location.hash = "/sources?preview=" + previewId; }, fixture);
    const preview = page.getByRole("region", { name: "同步预览", exact: true }); await expect(preview).toContainText("重复待核对 1"); await expect(preview).not.toContainText("目标冲突"); await expect(preview.getByRole("button", { name: "确认执行一次", exact: true })).toBeDisabled();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640));
    await preview.screenshot({ path: `test-results/desktop/sync-library-review-${decision}-before.png` }); expect(await preview.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (decision === "USE_LIBRARY") {
      const skip = preview.getByRole("button", { name: "确认所选文件已在库，跳过", exact: true }); await expect(skip).toBeDisabled(); await preview.getByRole("radio").check();
      await import("node:fs/promises").then(({ rename }) => rename(media, media + "-离线")); await skip.click(); await expect(preview.locator('.sync-file-blocked [role="alert"]')).toContainText("媒体库检查未完成");
      await import("node:fs/promises").then(({ rename }) => rename(media + "-离线", media)); await skip.click(); await expect(preview).toContainText("已由用户核对候选并确认跳过"); await expect(preview).toContainText("已在媒体库 1");
    } else { await preview.getByRole("button", { name: "仍需同步此文件", exact: true }).click(); await expect(preview).toContainText("重复待核对 0"); await expect(preview).toContainText("已在媒体库 0"); }
    await expect(preview.getByRole("button", { name: "确认执行一次", exact: true })).toBeEnabled(); await page.reload(); await expect(preview).toContainText("重复待核对 0");
    await expect(preview.getByRole("button", { name: "确认执行一次", exact: true })).toBeEnabled(); await preview.screenshot({ path: `test-results/desktop/sync-library-review-${decision}-after.png` });
    expect(await page.evaluate(() => window.desktopApi.listDownloads({}))).toMatchObject({ total: 0 }); expect((await stat(path)).ino).toBe(inode); expect(await readFile(path, "utf8")).toBe(content);
  } finally { await app.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await rm(directory, { recursive: true, force: true }); }
});
