import { test, expect, _electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile, rename, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("逐文件提交异常支持分页、持久反馈及原提交恢复，窄窗口保留完整路径", async () => {
  test.skip(process.platform !== "darwin", "当前受管卷验证为 macOS");
  const directory = await mkdtemp(join(tmpdir(), "marshal-recovery-window-")), download = join(directory, "下载"); await mkdir(download);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")); delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${join(directory, "data")}`], env }); let app = await launch();
  try {
    let page = await app.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await app.evaluate(({ dialog }, download) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [download] })) as typeof dialog.showOpenDialog; }, download);
    const rootId = await page.evaluate(async () => (await window.desktopApi.chooseConfigurationDirectory("managed"))!.id); await app.close();
    const config = join(directory, "seed.json"); await writeFile(config, JSON.stringify({ database: join(directory, "data/desktop.sqlite3"), rootId }));
    const seeded = await new Promise<string>((done, fail) => execFile(createRequire(resolve("package.json"))("electron") as string, [resolve("tools/desktop-files/seed-download-recovery.mjs"), config], { cwd: resolve("."), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20000 }, (error, stdout, stderr) => error ? fail(new Error(`${error.message}\n${stderr}`)) : done(stdout)));
    const fixture = JSON.parse(seeded) as { jobId: string; items: { itemId: string; segments: string[]; target: string; inode: string }[] };
    app = await launch(); page = await app.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "云端下载", exact: true }).click();
    const card = page.getByRole("article", { name: "提交异常恢复测试", exact: true });
    await expect(card.getByRole("button", { name: "打开完成目录", exact: true })).toBeVisible();
    await card.getByText("11 项异常待处理", { exact: true }).click();
    await expect(card.getByText("第 1 页 · 共 11 项异常", { exact: true })).toBeVisible();
    await expect(card.getByText(/完成位置被其他文件占用/).first()).toBeVisible();
    await card.getByRole("button", { name: "下一页异常", exact: true }).click(); await expect(card.getByText("第 2 页 · 共 11 项异常", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "上一页异常", exact: true }).click();
    for (const width of [1240, 920]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 820), width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("heading", { name: "云端下载", exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/desktop/download-recovery-${width}.png` });
    }
    const firstId = await page.evaluate(async (jobId) => (await window.desktopApi.listDownloadIssues({ jobId })).items[0]!.itemId, fixture.jobId);
    const first = fixture.items.find((item) => item.itemId === firstId)!, target = first.target, external = join(directory, "保留的外部文件.mkv"), old = await readFile(target), externalInode = (await stat(target)).ino;
    await rename(target, external);
    const row = card.getByRole("listitem", { name: first.segments.join("/"), exact: true });
    await row.getByRole("button", { name: `重新核对此文件 ${first.segments.join("/")}`, exact: true }).click();
    await expect(card.getByText("10 项异常待处理", { exact: true })).toBeVisible();
    await expect(card.locator(".download-progress")).toContainText("已完成 1 / 11 项");
    expect(String((await stat(target)).ino)).toBe(first.inode); expect((await stat(external)).ino).toBe(externalInode); expect(await readFile(external)).toEqual(old);
    await page.reload(); await expect(card.getByText("10 项异常待处理", { exact: true })).toBeVisible();
    await page.evaluate(() => window.desktopApi.restartCore()); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await expect(card.locator(".download-progress")).toContainText("已完成 1 / 11 项");
    const issues = await page.evaluate((jobId) => window.desktopApi.listDownloadIssues({ jobId }), fixture.jobId); expect(issues.total).toBe(10);
    expect(issues.items.every((item) => item.failure.code === "TARGET_OCCUPIED")).toBe(true);
  } finally { await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
