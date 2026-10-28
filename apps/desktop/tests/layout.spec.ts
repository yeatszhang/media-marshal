import { expect, test, _electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let application: ElectronApplication;
let directory: string;

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marshal-layout-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${join(directory, "data")}`], env });
});

test.afterEach(async () => {
  await application?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
});

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const overflowing = await page.locator("main .panel, main input, main select, main textarea, main .button").evaluateAll((elements) => elements.filter((element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && (box.right > innerWidth + 1 || box.left < 0);
  }).map((element) => element.textContent?.slice(0, 60) || element.getAttribute("aria-label") || element.tagName));
  expect(overflowing).toEqual([]);
}

async function adjacentCheckboxes(scope: Locator) {
  const gaps = await scope.locator('label:has(> input[type="checkbox"])').evaluateAll((labels) => labels.map((label) => {
    const input = label.querySelector("input")!.getBoundingClientRect();
    const text = Array.from(label.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    if (!text) throw new Error("此检查要求复选框标签包含直接文本");
    const range = document.createRange();
    range.selectNodeContents(text);
    const caption = range.getBoundingClientRect();
    return { width: input.width, height: input.height, gap: caption.left - input.right, offset: Math.abs(caption.top - input.top) };
  }));
  expect(gaps.length).toBeGreaterThan(0);
  for (const gap of gaps) {
    expect(gap.width).toBeGreaterThanOrEqual(16);
    expect(gap.height).toBeLessThanOrEqual(18);
    expect(gap.gap).toBeGreaterThanOrEqual(8);
    expect(gap.gap).toBeLessThanOrEqual(12);
    expect(gap.offset).toBeLessThan(6);
  }
}

test("全部主导航与账号、设置在常用和最小窗口保持布局与可操作区域", async () => {
  test.setTimeout(90000);
  const page = await application.firstWindow();
  await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "主导航" });
  const links = await nav.getByRole("link").allTextContents();
  const headings: Record<string, string> = { 总览: "让好内容，回到你的媒体库。", 来源: "来源同步", 待处理: "候选文件与识别确认" };
  for (const width of [1240, 920]) {
    await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 820), width);
    for (const name of links) {
      await nav.getByRole("link", { name: name.trim(), exact: true }).click();
      await expect(page.locator("main h1")).toHaveText(headings[name.trim()] ?? name.trim());
      await expect(nav.getByRole("link", { name: name.trim(), exact: true })).toHaveAttribute("aria-current", "page");
      if (name.trim() === "设置") await expect(page.locator("#settings-emby-url")).toBeVisible();
      await page.evaluate(() => scrollTo(0, 0));
      await noOverflow(page);
      await page.screenshot({ path: `test-results/desktop/layout-${width}-${new URL(page.url()).hash.slice(2) || "overview"}.png`, fullPage: true });
    }
    await nav.getByRole("link", { name: "网盘账号", exact: true }).click();
    await page.getByRole("button", { name: "连接夸克账号", exact: true }).click();
    await noOverflow(page);
    await page.screenshot({ path: `test-results/desktop/layout-account-form-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "取消", exact: true }).click();
  }
});

test("同步和识别表单的长路径、分组、复选文字与过滤行适配窗口宽度", async () => {
  test.skip(process.platform !== "darwin");
  test.setTimeout(90000);
  const page = await application.firstWindow();
  await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  const canonical = await realpath(directory);
  const input = join(canonical, "输入 中文_".repeat(12)), target = join(canonical, "下载目标 中文_".repeat(10)), media = join(canonical, "电影媒体目标 中文_".repeat(8));
  for (const path of [input, target, media]) await mkdir(path);
  await application.evaluate(({ dialog }, paths) => {
    let index = 0;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog;
  }, [input, target, media]);
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("link", { name: "来源", exact: true }).click();
  await page.getByRole("button", { name: "添加同步来源", exact: true }).click();
  await page.getByLabel("来源名称", { exact: true }).fill("布局检查：长路径与有序规则");
  await page.getByRole("button", { name: "选择本地输入目录", exact: true }).click();
  await page.getByRole("button", { name: "选择本地下载目录", exact: true }).click();
  for (let index = 1; index <= 2; index++) {
    await page.getByRole("button", { name: "添加过滤规则", exact: true }).click();
    await page.getByLabel(`规则 ${index} 表达式`, { exact: true }).fill(index === 1 ? "目录/**/*.mp4" : "**");
  }
  await page.getByLabel("规则 2 动作", { exact: true }).selectOption("exclude");
  await page.getByRole("checkbox", { name: "启用周期扫描", exact: true }).check();
  const form = page.getByRole("region", { name: "同步来源表单", exact: true });
  for (const width of [1240, 920]) {
    await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 820), width);
    await noOverflow(page);
    await adjacentCheckboxes(form);
    await form.screenshot({ path: `test-results/desktop/layout-sync-form-${width}.png` });
    const actions = form.getByRole("region", { name: "按顺序过滤文件", exact: true });
    const expression = await actions.getByLabel("规则 1 表达式").boundingBox();
    const remove = await actions.getByRole("button", { name: "删除规则 1", exact: true }).boundingBox();
    expect(expression!.width).toBeGreaterThan(180);
    expect(remove!.y).toBeGreaterThanOrEqual(expression!.y);
  }
  await page.getByRole("button", { name: "上移规则 2", exact: true }).click();
  await expect(page.getByLabel("规则 1 表达式")).toHaveValue("**");
  await page.getByRole("button", { name: "删除规则 1", exact: true }).click();
  await expect(page.getByLabel("规则 1 表达式")).toHaveValue("目录/**/*.mp4");
  await page.getByLabel("来源类型", { exact: true }).selectOption("cloud");
  await noOverflow(page);
  await page.screenshot({ path: "test-results/desktop/layout-cloud-form-920.png", fullPage: true });

  await nav.getByRole("link", { name: "识别与映射", exact: true }).click();
  await page.getByRole("button", { name: "添加识别规则", exact: true }).click();
  await page.getByLabel("识别规则名称").fill("布局检查：电影与剧集映射");
  const inputId = (await page.evaluate(() => window.desktopApi.listConfigurationDirectories())).find((row) => row.path === input)!.id;
  await page.getByLabel("识别输入目录", { exact: true }).selectOption(inputId);
  await page.getByRole("button", { name: "添加映射目标目录", exact: true }).click();
  await page.getByRole("checkbox", { name: "启用有条件自动整理策略", exact: true }).check();
  const recognition = page.getByRole("region", { name: "识别规则表单", exact: true });
  for (const width of [1240, 920]) {
    await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 820), width);
    await noOverflow(page);
    await adjacentCheckboxes(recognition);
    await recognition.screenshot({ path: `test-results/desktop/layout-recognition-form-${width}.png` });
  }
  await page.getByRole("button", { name: "保存识别草稿并预览", exact: true }).click();
  await expect(page.getByRole("region", { name: "识别配置范围预览", exact: true })).toContainText("待确认范围");
  await noOverflow(page);
  const card = page.getByRole("article", { name: "识别规则 布局检查：电影与剧集映射", exact: true });
  await card.screenshot({ path: "test-results/desktop/layout-recognition-card-920.png" });
  await page.getByRole("button", { name: "关闭识别表单", exact: true }).click();
  await card.getByRole("button", { name: "编辑并预览识别规则", exact: true }).click();
  await expect(page.getByLabel("识别规则名称")).toHaveValue("布局检查：电影与剧集映射");
  await expect(page.getByLabel("识别规则名称")).toBeInViewport();
  await expect(page.getByLabel("识别规则名称")).toBeFocused();
  await expect(page.getByRole("region", { name: "识别配置范围预览", exact: true })).toHaveCount(0);
  await page.getByLabel("识别规则名称").fill("已编辑的识别规则");
  await page.getByRole("button", { name: "保存识别草稿并预览", exact: true }).click();
  await page.getByRole("button", { name: "确认识别配置范围", exact: true }).click();
  const updatedCard = page.getByRole("article", { name: "识别规则 已编辑的识别规则", exact: true });
  await updatedCard.getByRole("button", { name: "编辑并预览识别规则", exact: true }).click();
  await expect(page.getByLabel("识别规则名称")).toBeFocused();
  await page.getByLabel("识别规则名称").fill("第二次编辑的识别规则");
  await page.getByRole("button", { name: "保存识别草稿并预览", exact: true }).click();
  const ruleId = (await page.evaluate(() => window.desktopApi.listRecognitionRules()))[0]!.id;
  const editedCard = page.getByRole("article", { name: "识别规则 第二次编辑的识别规则", exact: true });
  await editedCard.getByRole("button", { name: "暂停此识别规则", exact: true }).click();
  const preview = page.getByRole("region", { name: "识别配置范围预览", exact: true });
  await expect(preview.getByRole("button", { name: "编辑并重新预览", exact: true })).toBeVisible();
  const staleLink = new URL(page.url()).hash;
  await editedCard.getByRole("button", { name: "删除识别规则…", exact: true }).click();
  await page.getByRole("button", { name: "确认删除识别规则", exact: true }).click();
  await expect(editedCard).toHaveCount(0);
  await expect(preview).toHaveCount(0);
  await expect(recognition).toHaveCount(0);
  await expect(page.getByRole("region", { name: "首次样本自动授权", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  await page.evaluate((hash) => { location.hash = hash; }, staleLink);
  await expect.poll(() => new URL(page.url()).hash).toBe("#/recognition");
  await expect(recognition).toHaveCount(0);
  await expect(preview).toHaveCount(0);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: "test-results/desktop/layout-recognition-deleted-920.png", fullPage: true });
  await page.locator(".recognition-archive > summary").click();
  await page.getByRole("button", { name: "恢复已删除识别规则", exact: true }).click();
  await expect(editedCard).toContainText("识别已暂停");
  expect((await page.evaluate(() => window.desktopApi.listRecognitionRules()))[0]).toMatchObject({ id: ruleId, paused: true, deletedAt: null });
  expect(await page.evaluate(() => window.desktopApi.listSyncJobs())).toMatchObject({ total: 0 });
  expect(await page.evaluate(() => window.desktopApi.listTasks({ page: 1, pageSize: 100 }))).toMatchObject({ total: 0 });
});


test("全新来源的删除、重载和恢复明确反馈，保留原文件且不创建文件任务", async () => {
  test.skip(process.platform !== "darwin");
  const page = await application.firstWindow();
  await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  const canonical = await realpath(directory), input = join(canonical, "保留原文件"), target = join(canonical, "下载目标");
  await mkdir(input); await mkdir(target); await writeFile(join(input, "原片.mp4"), "删除来源不能修改原文件");
  await application.evaluate(({ dialog }, paths) => { let index = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog; }, [input, target]);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "来源", exact: true }).click();
  await page.getByRole("button", { name: "添加同步来源", exact: true }).click();
  await page.getByLabel("来源名称", { exact: true }).fill("全新来源删除验证");
  await page.getByRole("button", { name: "选择本地输入目录", exact: true }).click();
  await page.getByRole("button", { name: "选择本地下载目录", exact: true }).click();
  await page.getByRole("button", { name: "保存草稿并预览", exact: true }).click();
  await page.getByRole("button", { name: "确认配置范围", exact: true }).click();
  const card = page.getByRole("article", { name: "同步来源 全新来源删除验证", exact: true });
  await card.getByRole("button", { name: "暂停来源同步", exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640));
  await card.getByRole("button", { name: "删除同步来源…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "删除同步来源", exact: true });
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  await expect(card.getByRole("button", { name: "删除同步来源…", exact: true })).toBeFocused();
  await card.getByRole("button", { name: "删除同步来源…", exact: true }).click();
  await dialog.screenshot({ path: "test-results/desktop/sync-remove-confirm.png" });
  await dialog.getByRole("button", { name: "确认删除同步来源", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(card).toHaveCount(0);
  await expect(page.getByRole("region", { name: "同步预览", exact: true })).toHaveCount(0);
  await page.reload(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.desktopApi.listSyncSources())).toEqual([]);
  const deleted = (await page.evaluate(() => window.desktopApi.listSyncSources({ includeDeleted: true })))[0]!;
  expect(deleted).toMatchObject({ paused: true, runtime: { claimed: true } }); expect(deleted.deletedAt).not.toBeNull();
  await page.getByText("已删除同步来源", { exact: true }).click();
  await page.getByRole("button", { name: "恢复已删除来源", exact: true }).click();
  await expect(card).toContainText("已暂停");
  expect(await readFile(join(input, "原片.mp4"), "utf8")).toBe("删除来源不能修改原文件");
  await page.screenshot({ path: "test-results/desktop/sync-restored-paused.png", fullPage: true });
  expect(await page.evaluate(() => window.desktopApi.listSyncJobs())).toMatchObject({ total: 0 });
  expect(await page.evaluate(() => window.desktopApi.listDownloads({ page: 1, pageSize: 25 }))).toMatchObject({ total: 0 });
  expect(await page.evaluate(() => window.desktopApi.listTasks({ page: 1, pageSize: 100 }))).toMatchObject({ total: 0 });
});
