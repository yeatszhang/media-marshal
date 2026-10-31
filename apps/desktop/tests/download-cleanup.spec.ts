import { expect, test, _electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";

test("下载清理长路径、失败重试、历史范围与重载及 Core 重启（隔离配置）", async () => {
  test.setTimeout(90000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-cleanup-window-"))),
    download = join(directory, "下载"),
    media = join(directory, "媒体库"),
    content = "已交付的隔离媒体内容，完整摘要相同。";
  const segments = [
    ["中文很长的目录名称与文件身份验证".repeat(3), "第一季", "01.mp4"],
    ["历史待清理", "02.mp4"],
  ];
  await mkdir(download);
  await mkdir(media);
  for (const parts of segments) {
    await mkdir(join(download, "completed", ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(download, "completed", ...parts), content);
  }
  const target = join(media, "已经重命名的作品 - S01E01.mp4");
  await writeFile(target, content);
  const inode = (await stat(target)).ino;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers["x-emby-token"] !== "isolated-cleanup-test") {
      res.writeHead(401).end();
      return;
    }
    const path = new URL(req.url!, "http://localhost").pathname;
    if (path === "/System/Info")
      res.end(JSON.stringify({ Id: "cleanup-server", Version: "4.9-fixture" }));
    else if (path === "/Library/VirtualFolders/Query")
      res.end(
        JSON.stringify({
          Items: [
            { ItemId: "movies", Name: "隔离媒体库", Locations: [media], CollectionType: "movies" },
          ],
          TotalRecordCount: 1,
        }),
      );
    else if (path === "/Items") res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
    else res.writeHead(204).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () =>
    _electron.launch({
      args: [resolve("apps/desktop"), `--user-data-dir=${join(directory, "data")}`],
      env,
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await app.evaluate(
      ({ dialog }, paths) => {
        let index = 0;
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [paths[index++]!],
        })) as typeof dialog.showOpenDialog;
      },
      [download, media],
    );
    const rootId = await page.evaluate(
      async ({ address, media }) => {
        const root = await window.desktopApi.chooseConfigurationDirectory("managed");
        await window.desktopApi.setDefaultDownloadDirectory({
          expectedVersion: 0,
          directoryId: root!.id,
          requestKey: crypto.randomUUID(),
        });
        const libraries = await window.desktopApi.chooseMediaTarget("MOVIE");
        await window.desktopApi.saveSettings({
          language: "zh-CN",
          embyUrl: address,
          tmdbProxy: "",
        });
        await window.desktopApi.saveCredential("emby", "isolated-cleanup-test");
        await window.desktopApi.connectEmby({
          serverId: "cleanup-server",
          libraries: [
            { targetId: libraries[0]!.targetId, libraryId: "movies", libraryPath: media },
          ],
        });
        return root!.id;
      },
      { address, media },
    );
    await app.close();
    const config = join(directory, "seed.json");
    await writeFile(
      config,
      JSON.stringify({ database: join(directory, "data/desktop.sqlite3"), rootId, segments }),
    );
    const seeded = await new Promise<string>((done, fail) =>
      execFile(
        createRequire(resolve("package.json"))("electron") as string,
        [resolve("tools/desktop-files/seed-download-cleanup.mjs"), config],
        { cwd: resolve("."), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20000 },
        (error, stdout, stderr) =>
          error ? fail(new Error(`${error.message}\n${stderr}`)) : done(stdout),
      ),
    );
    const fixture = JSON.parse(seeded) as { receiptIds: string[]; cleanupId: string };
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "云端下载", exact: true })
      .click();
    const panel = page.getByRole("region", { name: "下载副本与临时资源", exact: true });
    await expect(panel).toContainText("清理需要处理");
    await expect(panel).toContainText(segments[0]!.join("/"));
    await expect(panel).toContainText("恢复原卷后重试");
    for (const width of [1240, 920]) {
      await app.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0]!.setSize(width, width === 920 ? 640 : 820),
        width,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await panel.screenshot({ path: `test-results/desktop/download-cleanup-${width}.png` });
    }
    await page.reload();
    await expect(panel).toContainText("清理需要处理");
    expect(await readFile(join(download, "completed", ...segments[0]!), "utf8")).toBe(content);
    await page.evaluate(() => window.desktopApi.restartCore());
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await expect(panel).toContainText("清理需要处理");
    await expect
      .poll(
        async () => (await page.evaluate(() => window.desktopApi.listDownloadRoots()))[0]?.state,
        { timeout: 40000 },
      )
      .toBe("AVAILABLE");
    await panel.getByRole("button", { name: "重试此项清理", exact: true }).click();
    await expect(panel).toContainText("清理完成");
    await panel.getByText("清理历史下载副本", { exact: true }).click();
    await panel.getByRole("button", { name: "选择历史清理范围", exact: true }).click();
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "预览所选清理范围", exact: true }).click();
    await expect(panel).toContainText("待确认清理 1 项");
    const before = await page.evaluate(() => window.desktopApi.listDownloadCleanup({}));
    expect(before).toHaveLength(1);
    await page.reload();
    await expect(panel).toContainText("待确认清理 1 项");
    expect(await page.evaluate(() => window.desktopApi.listDownloadCleanup({}))).toHaveLength(1);
    await panel.getByRole("button", { name: "确认清理上述下载副本", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktopApi.listDownloadCleanup({}))).filter(
            (row) => row.phase === "DONE",
          ).length,
      )
      .toBe(2);
    await page.evaluate(() => window.desktopApi.restartCore());
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    expect(
      (await page.evaluate(() => window.desktopApi.listDownloadCleanup({})))
        .map((row) => row.receiptId)
        .sort(),
    ).toEqual([...fixture.receiptIds].sort());
    for (const parts of segments)
      await expect(readFile(join(download, "completed", ...parts))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(await readFile(target, "utf8")).toBe(content);
    expect((await stat(target)).ino).toBe(inode);
  } finally {
    await app.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
