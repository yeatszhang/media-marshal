import type { DesktopApi } from "@media-marshal/contracts";
import { expect, type Page } from "./test-electron";
export async function chooseSettingsDownload(window: Page) {
  await expect(window.getByLabel("本地输入目录", { exact: true })).not.toHaveValue("");
  const navigation = window.getByRole("navigation", { name: "主导航" });
  await window
    .getByRole("region", { name: "本地下载目录", exact: true })
    .getByRole("link", { name: "前往设置", exact: true })
    .click();
  const panel = window.getByRole("region", { name: "本地下载目录", exact: true });
  await panel.getByRole("button", { name: "选择本地下载目录", exact: true }).click();
  await panel.getByRole("button", { name: "保存下载目录", exact: true }).click();
  await expect(panel).toContainText("下载目录已保存");
  const saved = await window.evaluate(() =>
    (globalThis as unknown as { desktopApi: DesktopApi }).desktopApi.getDefaultDownloadDirectory(),
  );
  expect(saved.directory).not.toBeNull();
  await navigation.getByRole("link", { name: "来源", exact: true }).click();
  await expect(window.getByRole("region", { name: "本地下载目录", exact: true })).toContainText(
    saved.directory!.path,
  );
}
export async function editSavedSyncDraft(window: Page, name: string) {
  await expect(window.getByRole("region", { name: "同步预览", exact: true })).toBeVisible();
  await window.getByRole("button", { name: "关闭预览", exact: true }).click();
  await window
    .getByRole("article", { name: `同步来源 ${name}`, exact: true })
    .getByRole("button", { name: "编辑并预览", exact: true })
    .click();
  await expect(window.getByRole("dialog", { name: "编辑同步来源", exact: true })).toBeVisible();
}
