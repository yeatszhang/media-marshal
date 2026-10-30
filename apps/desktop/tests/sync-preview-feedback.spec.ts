import { expect, test, _electron } from "@playwright/test";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
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
    await preview.getByRole("button", { name: "确认配置范围", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.desktopApi.listSyncJobs({}))).toMatchObject({ items: [{ state: "DONE", files: 1, inLibrary: 1, done: 0 }] });
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
