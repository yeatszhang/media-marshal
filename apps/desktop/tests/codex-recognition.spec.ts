import { expect, test, _electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, realpath, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("Codex配置、目录入口、缺少CLI的持久错误、用量及重启恢复", async () => {
  test.skip(process.platform !== "darwin");
  test.setTimeout(90000);
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "marshal-codex-window-"))),
    data = join(temporary, "data"),
    source = join(temporary, "已有剧集", "作品", "S01"),
    target = join(temporary, "媒体库");
  await mkdir(source, { recursive: true });
  await mkdir(target);
  for (const name of ["01.mkv", "02.mkv"]) await writeFile(join(source, name), "隔离窗口夹具");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [resolve("apps/desktop"), `--user-data-dir=${data}`];
  let app = await _electron.launch({ args, env });
  try {
    let page = await app.firstWindow();
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await app.evaluate(
      ({ dialog }, paths) => {
        let n = 0;
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [paths[n++]!],
        })) as typeof dialog.showOpenDialog;
      },
      [source, target],
    );
    await page.evaluate(
      async ({ source, target }) => {
        await window.desktopApi.chooseDirectory("source");
        await window.desktopApi.chooseDirectory("target");
        const draft = await window.desktopApi.configureSourceRule({
          id: crypto.randomUUID(),
          expectedVersion: 0,
          expectedDraftRevision: 0,
          requestKey: crypto.randomUUID(),
          configuration: {
            type: "local",
            name: "Codex 隔离剧集",
            client: "custom",
            sourcePath: source,
            organization: { targetPath: target, mediaType: "TV_SHOW" },
          },
        });
        const preview = await window.desktopApi.previewSourceRule({
          id: draft.id,
          expectedVersion: 0,
          expectedDraftRevision: 1,
          requestKey: crypto.randomUUID(),
        });
        await window.desktopApi.applySourceRule({
          previewId: preview.id,
          requestKey: crypto.randomUUID(),
        });
      },
      { source, target },
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktopApi.listIngestionCandidates({}))).total,
      )
      .toBe(2);
    await app.close();
    const seed = join(temporary, "seed.mjs");
    await writeFile(
      seed,
      `
import { CoreDatabase } from ${JSON.stringify(pathToFileURL(resolve("packages/media-core/dist/infrastructure/database.js")).href)};
import { normalizeParse } from ${JSON.stringify(pathToFileURL(resolve("packages/media-core/dist/domain/media.js")).href)};
import { randomUUID } from 'node:crypto'; import { join } from 'node:path';
const db=await CoreDatabase.open(join(process.argv[2],'desktop.sqlite3')),sql=db.connection,stamp=new Date().toISOString();
for(const c of sql.prepare('SELECT * FROM ingestion_candidate ORDER BY relative_json').all()){
 const parts=JSON.parse(c.relative_json),name=parts.at(-1),id=randomUUID(),root=sql.prepare('SELECT source_path FROM desktop_source WHERE id=?').get(c.source_id).source_path;
 sql.prepare("INSERT INTO media_task(id,source_id,source_path,title,status,parsed_json,created_at,updated_at) VALUES(?,?,?,'已识别作品','AWAITING_CONFIRMATION',?,?,?)").run(id,c.source_id,join(root,...parts),JSON.stringify(normalizeParse({title:'已识别作品',type:'episode',season:1,episode:Number(name.slice(0,2)),year:2026},name)),stamp,stamp);
 sql.prepare("UPDATE ingestion_candidate SET task_id=?,state='QUEUED' WHERE id=?").run(id,c.id);
 sql.prepare('INSERT INTO task_candidate VALUES(?,?,?,?)').run(randomUUID(),id,JSON.stringify({tmdbId:7,mediaType:'TV_SHOW',title:'已识别作品',originalTitle:null,year:2026,score:{confidence:.9,titleScore:1,yearScore:1,mediaTypeScore:1,structureBonus:0},evidence:'filename'}),.9);
} db.close();`,
    );
    await new Promise<void>((done, fail) =>
      execFile(
        createRequire(resolve("package.json"))("electron") as string,
        [seed, data],
        { env: { ...env, ELECTRON_RUN_AS_NODE: "1" } },
        (error) => (error ? fail(error) : done()),
      ),
    );
    app = await _electron.launch({ args, env });
    page = await app.firstWindow();
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "待处理", exact: true }).click();
    await expect(page.getByRole("button", { name: "批量识别目录", exact: true })).toBeDisabled();
    await page.getByRole("link", { name: "配置识别策略", exact: true }).click();
    await page.getByLabel("启用 Codex 辅助识别", { exact: true }).check();
    await page.getByText("高级识别设置", { exact: true }).click();
    await page
      .getByLabel("Codex CLI 可执行文件", { exact: true })
      .fill(join(temporary, "不存在的codex"));
    await page.getByRole("button", { name: "保存识别设置", exact: true }).click();
    await expect(page.getByText("识别设置已保存", { exact: true })).toBeVisible();
    for (const width of [1440, 920]) {
      await app.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 1000),
        width,
      );
      await page.locator("#recognition-strategy").scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `test-results/desktop/codex-settings-${width}.png` });
    }
    await page.getByRole("link", { name: "待处理", exact: true }).click();
    await expect(page.getByRole("button", { name: "批量识别目录", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "批量识别目录", exact: true }).click();
    await expect(page.getByRole("region", { name: "Codex 识别记录", exact: true })).toContainText(
      "找不到 Codex CLI",
    );
    const jobs = await page.evaluate(() => window.desktopApi.listCodexJobs({}));
    expect(jobs.items).toHaveLength(1);
    expect(jobs.items[0]).toMatchObject({ state: "FAILED", directory: true, organize: false });
    expect((await page.evaluate(() => window.desktopApi.getCodexUsage())).calls).toBe(1);
    expect(await page.evaluate(() => window.desktopApi.listJobs())).toEqual([]);
    await page.screenshot({
      path: "test-results/desktop/codex-directory-error-920.png",
      fullPage: true,
    });
    await app.close();
    app = await _electron.launch({ args, env });
    page = await app.firstWindow();
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "待处理", exact: true }).click();
    await expect(page.getByRole("region", { name: "Codex 识别记录", exact: true })).toContainText(
      "Codex 识别记录（1）",
    );
    await page
      .getByRole("region", { name: "Codex 识别记录", exact: true })
      .locator("summary")
      .click();
    await expect(page.getByRole("region", { name: "Codex 识别记录", exact: true })).toContainText(
      "找不到 Codex CLI",
    );
    expect((await page.evaluate(() => window.desktopApi.listCodexJobs({}))).total).toBe(1);
    expect((await page.evaluate(() => window.desktopApi.getCodexUsage())).calls).toBe(1);
  } finally {
    await app.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
});
