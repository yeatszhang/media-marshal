import { expect, test, _electron } from "@playwright/test";
import { mkdtemp, mkdir, realpath, rename, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("同步预览恢复启动时离线的原目录，并拒绝同路径替代目录", async ({}, testInfo) => {
  test.setTimeout(90000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-sync-directory-window-"))), input = join(directory, "本地输入"), target = join(directory, "下载目录"), data = join(directory, "data");
  await Promise.all([mkdir(input), mkdir(target)]);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")); delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ args: [resolve("apps/desktop"), `--user-data-dir=${data}`], env });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await app.evaluate(({ dialog }, paths) => { let index = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog; }, [input, target]);
    const ids = await page.evaluate(async () => {
      const input = await window.desktopApi.chooseConfigurationDirectory("ordinary"), target = await window.desktopApi.chooseConfigurationDirectory("managed");
      await window.desktopApi.setDefaultDownloadDirectory({ expectedVersion: 0, directoryId: target!.id, requestKey: crypto.randomUUID() });
      await window.desktopApi.saveSyncSource({ id: crypto.randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, expectedLifecycleRevision: 0, requestKey: crypto.randomUUID(), configuration: { type: "local", name: "原目录恢复验证", inputDirectoryId: input!.id } });
      return [input!.id, target!.id];
    });
    await app.close(); await Promise.all([rename(input, input + "-离线"), rename(target, target + "-离线")]);
    app = await launch(); page = await app.firstWindow(); await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const records = (await readFile(join(data, "logs/desktop.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      return ids.every((id) => records.some((record) => record.event === "directory.restore.failed" && record.kind && record.directoryId === id));
    }).toBe(true);
    await Promise.all([rename(input + "-离线", input), rename(target + "-离线", target)]);
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "来源", exact: true }).click();
    const source = page.getByRole("article", { name: "同步来源 原目录恢复验证", exact: true });
    await source.getByRole("button", { name: "编辑并预览", exact: true }).click();
    await page.getByRole("button", { name: "保存草稿并预览", exact: true }).click();
    const preview = page.getByRole("region", { name: "同步预览", exact: true });
    await expect(preview.getByRole("button", { name: "确认配置范围", exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => window.desktopApi.listConfigurationDirectories())).toEqual(expect.arrayContaining(ids.map((id) => expect.objectContaining({ id, version: 1, available: true }))));
    await preview.getByRole("button", { name: "关闭预览", exact: true }).click();
    const accepted = await page.evaluate(async () => {
      const source = (await window.desktopApi.listSyncSources())[0]!;
      const input = { id: source.id, expectedVersion: source.version, expectedDraftRevision: source.draftRevision, expectedLifecycleRevision: source.lifecycleRevision, requestKey: crypto.randomUUID() };
      return { input, id: (await window.desktopApi.previewSyncSource(input)).id };
    });
    // 用新目录占据原路径：名称与卷均相同，目录身份仍必须拒绝。
    await rename(input, input + "-原目录"); await mkdir(input);
    // 已受理请求的重试仍查询原预览，不因后续目录离线改变幂等结果。
    expect(await page.evaluate((input) => window.desktopApi.previewSyncSource(input), accepted.input)).toMatchObject({ id: accepted.id });
    await source.getByRole("button", { name: "编辑并预览", exact: true }).click();
    await page.getByRole("button", { name: "保存草稿并预览", exact: true }).click();
    const form = page.getByRole("region", { name: "同步来源表单", exact: true });
    await expect(form.getByRole("alert")).toContainText(input);
    await expect(form.getByRole("alert")).toContainText("原卷身份不一致");
    await expect(form.getByRole("alert")).toContainText("重新选择并授权原目录");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640));
    await page.screenshot({ path: testInfo.outputPath("sync-directory-identity-failure.png"), fullPage: true });
    await rm(input, { recursive: true }); await rename(input + "-原目录", input);
    await page.getByRole("button", { name: "保存草稿并预览", exact: true }).click();
    await expect(preview.getByRole("button", { name: "确认配置范围", exact: true })).toBeEnabled();
    await preview.screenshot({ path: testInfo.outputPath("sync-directory-restored.png") });
    expect(await page.evaluate(() => window.desktopApi.listSyncJobs())).toMatchObject({ total: 0 });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
