import { expect, test, _electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("工作台键盘入口、使用说明和英文长导航在最小窗口可用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marshal-workspace-design-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${join(directory, "data")}`], env });
  try {
    const page = await application.firstWindow();
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640));
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.webContents.focus(); });
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "跳至主内容" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    await page.locator(".release-note summary").click();
    await expect(page.locator(".release-note p")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "主导航" });
    await nav.getByRole("link", { name: "设置", exact: true }).click();
    await expect(page.locator(".breadcrumb strong")).toHaveText("设置");
    await page.getByLabel("界面语言", { exact: true }).selectOption("en");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const englishNav = page.getByRole("navigation", { name: "Main navigation" });
    await englishNav.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page.locator("main h1")).toHaveText("A place for every good story.");
    await expect(page.locator(".breadcrumb strong")).toHaveText("Overview");
    await expect(englishNav.getByRole("link", { name: "Settings", exact: true })).toBeInViewport();
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.locator(".button").first().evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0s");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const overflowing = await page.locator(".sidebar a, main .button, .setup-steps a").evaluateAll((nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent));
    expect(overflowing).toEqual([]);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: "test-results/desktop/workspace-english-920.png", fullPage: true });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
