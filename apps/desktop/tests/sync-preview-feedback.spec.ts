import { expect, test, _electron } from "@playwright/test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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
