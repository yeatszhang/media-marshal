import { expect, test, _electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("识别工作台目录优先、目录内连续核对、扫描问题分离及最小窗口", async () => {
  test.skip(process.platform !== "darwin");
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "marshal-recognition-workspace-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [resolve("apps/desktop"), `--user-data-dir=${join(directory, "data")}`];
  let application = await _electron.launch({ args, env });
  try {
    let page = await application.firstWindow();
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    const canonical = await realpath(directory),
      source = join(canonical, "识别输入"),
      target = join(canonical, "媒体库");
    const folders = [
      "翠鸟谋杀案 (2026)/Season 01",
      "猫头鹰谋杀案 (2024)/Season 01",
      "待核对的非标准目录 中文与长路径".repeat(3),
    ];
    await mkdir(target);
    for (const folder of folders) {
      await mkdir(join(source, folder), { recursive: true });
      for (const episode of [1, 2])
        await writeFile(
          join(source, folder, `测试作品.S01E0${episode}.mkv`),
          `隔离交互夹具 ${episode}`,
        );
    }
    await application.evaluate(
      ({ dialog }, paths) => {
        let index = 0;
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [paths[index++]!],
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
            name: "隔离交互夹具",
            client: "custom",
            sourcePath: source,
            organization: { targetPath: target },
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
      .toBe(6);
    await application.close();
    const seed = join(directory, "seed.mjs");
    // 退出隔离应用后写入待确认夹具；界面、查询、导航与 IPC 使用生产代码，不代表真实识别质量。
    await writeFile(
      seed,
      `
import { CoreDatabase } from ${JSON.stringify(pathToFileURL(resolve("packages/media-core/dist/infrastructure/database.js")).href)};
import { normalizeParse } from ${JSON.stringify(pathToFileURL(resolve("packages/media-core/dist/domain/media.js")).href)};
import { randomUUID } from 'node:crypto'; import { join } from 'node:path';
const db=await CoreDatabase.open(join(process.argv[2],'desktop.sqlite3')),sql=db.connection,stamp=new Date().toISOString();
for (const candidate of sql.prepare('SELECT * FROM ingestion_candidate ORDER BY relative_json').all()) {
 const parts=JSON.parse(candidate.relative_json),name=parts.at(-1),episode=Number(/E0?(\\d+)/.exec(name)[1]),id=randomUUID(),root=sql.prepare('SELECT source_path FROM desktop_source WHERE id=?').get(candidate.source_id).source_path;
 sql.prepare("INSERT INTO media_task(id,source_id,source_path,title,status,parsed_json,created_at,updated_at) VALUES(?,?,?,'翠鸟谋杀案','AWAITING_CONFIRMATION',?,?,?)").run(id,candidate.source_id,join(root,...parts),JSON.stringify(normalizeParse({title:'翠鸟谋杀案',type:'episode',season:1,episode,year:2026},name)),stamp,stamp);
 sql.prepare("UPDATE ingestion_candidate SET task_id=?,state='QUEUED' WHERE id=?").run(id,candidate.id);
 sql.prepare("INSERT INTO task_candidate VALUES(?,?,?,?)").run(randomUUID(),id,JSON.stringify({tmdbId:7,mediaType:'TV_SHOW',title:'翠鸟谋杀案',originalTitle:'Marble Hall Murders',year:2026,score:{confidence:0.92,titleScore:1,yearScore:1},evidence:'both',parentOnlyCapped:false}),0.92);
}
const source=sql.prepare('SELECT id FROM desktop_source LIMIT 1').get().id, scan=randomUUID();
sql.prepare("INSERT INTO ingestion_source_scan(id,source_id,physical_source_id,source_name,context,state,discovered,failure,created_at,updated_at) VALUES(?,?,?,?,?,'PARTIAL_FAILED',6,?,?,?)").run(scan,source,source,'隔离交互夹具','{}','部分文件未能核对，请检查文件权限后重新扫描',stamp,stamp);
sql.prepare('INSERT INTO ingestion_source_scan_issue VALUES(?,?,?)').run(scan,'翠鸟谋杀案 (2026)/poster.jpg','文件暂不可读，请检查原文件、磁盘和读取权限后重新扫描');
db.close();`,
    );
    await new Promise<void>((done, fail) =>
      execFile(
        createRequire(resolve("package.json"))("electron") as string,
        [seed, join(directory, "data")],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
        (error) => (error ? fail(error) : done()),
      ),
    );
    application = await _electron.launch({ args, env });
    page = await application.firstWindow();
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "待处理", exact: true }).click();
    await expect(page.getByRole("button", { name: "目录批量", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("region", { name: "目录文件与候选摘要" })).toBeVisible();
    await expect(page.getByRole("region", { name: "手动目录扫描" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "扫描与问题 1" })).toBeVisible();
    for (const width of [1440, 920]) {
      await application.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 1000),
        width,
      );
      await page.evaluate(() => scrollTo(0, 0));
      const tabs = await page
        .locator(".recognition-tabs .button")
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
      expect(Math.max(...tabs) - Math.min(...tabs)).toBeLessThan(50);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `test-results/desktop/recognition-directories-${width}.png`,
        fullPage: true,
      });
    }
    await page
      .getByRole("region", { name: "目录文件与候选摘要" })
      .getByRole("button", { name: "查看此项识别", exact: true })
      .first()
      .click();
    await expect(page.getByRole("button", { name: "逐个处理", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const queue = page.getByRole("region", { name: "文件队列", exact: true });
    await expect(queue.locator(".recognition-file-row")).toHaveCount(2);
    await expect(page.getByLabel("下一个文件", { exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "选择此作品", exact: true }).click();
    await expect(page.locator(".recognition-match.is-selected")).toHaveCount(1);
    await page.getByLabel("下一个文件", { exact: true }).click();
    await expect(page.locator(".recognition-match.is-selected")).toHaveCount(0);
    await expect(page.getByLabel("上一个文件", { exact: true })).toBeEnabled();
    for (const width of [1440, 920]) {
      await application.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 1000),
        width,
      );
      await page.evaluate(() => scrollTo(0, 0));
      const tabs = await page
        .locator(".recognition-tabs .button")
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
      expect(Math.max(...tabs) - Math.min(...tabs)).toBeLessThan(50);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `test-results/desktop/recognition-file-${width}.png`,
        fullPage: true,
      });
    }
    await page
      .getByRole("button", { name: "预览 COPY 计划", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(page.getByLabel("上一个文件", { exact: true })).toBeInViewport();
    await page.screenshot({ path: "test-results/desktop/recognition-file-scrolled-920.png" });
    await page.getByLabel("上一个文件", { exact: true }).click();
    await expect(page.getByLabel("下一个文件", { exact: true })).toBeEnabled();
    await page.evaluate(() => scrollTo(0, 0));
    await page.getByRole("button", { name: "扫描与问题 1" }).click();
    await page.getByRole("button", { name: "查看扫描问题", exact: true }).click();
    await expect(page.getByRole("region", { name: "目录扫描逐项问题" })).toContainText(
      "poster.jpg",
    );
    await expect(page.getByRole("region", { name: "文件队列", exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      scrollTo(0, 0);
    });
    await page.screenshot({
      path: "test-results/desktop/recognition-scan-issues-920.png",
      fullPage: true,
    });
    expect(await page.evaluate(() => window.desktopApi.listJobs())).toEqual([]);
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
