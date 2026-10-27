import { test, expect, _electron, type ElectronApplication } from "@playwright/test";
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CORE_DATA_SCHEMA_VERSION } from "@media-marshal/contracts/internal/core";

// 必须显式指向本轮只读映像；不能用工作区目录包替代安装态证据。
const executable = process.env.MARSHAL_APP_PATH;
test.skip(process.platform !== "darwin" || process.env.MARSHAL_INSTALL_MATRIX !== "1" || !executable, "需要本轮 macOS 只读 DMG 与显式安装态验收入口");
let directory: string, application: ElectronApplication | undefined;
const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const launch = async (path: string, profile: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  application = await _electron.launch({ executablePath: path, args: [`--user-data-dir=${profile}`], env });
  const page = await application.firstWindow();
  await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  expect(await application.evaluate(({ app }) => ({ packaged: app.isPackaged, path: app.getAppPath(), data: app.getPath("userData"), searchPath: process.env.PATH }))).toEqual({ packaged: true, path: join(dirname(dirname(path)), "Resources/app.asar"), data: profile, searchPath: "/usr/bin:/bin:/usr/sbin:/sbin" });
  return page;
};
test.beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-install-matrix-"))); });
test.afterEach(async () => { await application?.close().catch(() => {}); application = undefined; if (directory) await rm(directory, { recursive: true, force: true }); });

test("只读 DMG 实际启动、Core 重启与新库均不写入安装卷", async () => {
  const sourceApp = dirname(dirname(dirname(resolve(executable!)))), probe = join(sourceApp, "Contents", `.marshal-readonly-${randomUUID()}`), profile = join(directory, "资料 中文 空格");
  try { await expect(writeFile(probe, "只读安装验证", { flag: "wx" })).rejects.toMatchObject({ code: "EROFS" }); }
  finally { await rm(probe).catch(() => {}); }
  const before = await digest(join(sourceApp, "Contents/Resources/app.asar")), page = await launch(executable!, profile);
  const initial = await page.evaluate(() => window.desktopApi.getRuntime()); expect(initial).toMatchObject({ core: "ready", status: { schemaVersion: CORE_DATA_SCHEMA_VERSION, parser: "ready", correctionFiles: "ready" } });
  await page.evaluate(() => window.desktopApi.restartCore());
  await expect.poll(() => page.evaluate(() => window.desktopApi.getRuntime())).toMatchObject({ core: "ready" });
  expect(await page.evaluate(() => window.desktopApi.listSourceRules())).toEqual([]);
  expect(await page.evaluate(() => window.desktopApi.listJobs())).toEqual([]);
  await application!.close(); application = undefined;
  expect((await stat(join(profile, "desktop.sqlite3"))).isFile()).toBe(true);
  expect(await digest(join(sourceApp, "Contents/Resources/app.asar"))).toBe(before);
  await writeFile(resolve("test-results/desktop/install-matrix-readonly.json"), JSON.stringify({ target: `${process.platform}-${process.arch}`, appVersion: initial.appVersion, schema: initial.status!.schemaVersion, parser: initial.status!.parser, correctionFiles: initial.status!.correctionFiles, asarSha256: before, actualReadOnlyVolume: true, coreRestarted: true, systemPathOnly: true }, null, 2));
});

test("中文空格路径重复安装、卸载重装保留来源配置与原媒体", async () => {
  test.setTimeout(180000);
  const sourceApp = dirname(dirname(dirname(resolve(executable!)))), installed = join(directory, "安装 中文 空格", "媒体管家 中文.app"), profile = join(directory, "保留的资料 中文"), source = join(directory, "来源 中文"), target = join(directory, "媒体库 中文");
  await mkdir(source); await mkdir(target); await writeFile(join(source, "原始.S01E01.mkv"), "安装验收原文件，只用于隔离扫描"); await writeFile(join(target, "已有媒体.mkv"), "用户已有媒体保持");
  const sourceHash = await digest(join(source, "原始.S01E01.mkv")), targetHash = await digest(join(target, "已有媒体.mkv")), archiveHash = await digest(join(sourceApp, "Contents/Resources/app.asar"));
  const sourceIdentity = await stat(join(source, "原始.S01E01.mkv")), targetIdentity = await stat(join(target, "已有媒体.mkv"));
  await cp(sourceApp, installed, { recursive: true, dereference: false, verbatimSymlinks: true });
  let page = await launch(join(installed, "Contents/MacOS/Media Marshal"), profile);
  // 仅目录选择结果为受控替身；实际授权探测、预览、事务与安装文件均为生产实现。
  await application!.evaluate(({ dialog }, paths) => { let index = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog; }, [source, target]);
  const rule = await page.evaluate(async ({ source, target }) => {
    await window.desktopApi.chooseDirectory("source"); await window.desktopApi.chooseDirectory("target");
    const draft = await window.desktopApi.configureSourceRule({ id: crypto.randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: crypto.randomUUID(), configuration: { type: "local", name: "安装后保留的来源", client: "custom", sourcePath: source, organization: { targetPath: target } } });
    const preview = await window.desktopApi.previewSourceRule({ id: draft.id, expectedVersion: draft.version, expectedDraftRevision: draft.draftRevision, requestKey: crypto.randomUUID() });
    return window.desktopApi.applySourceRule({ previewId: preview.id, requestKey: crypto.randomUUID() });
  }, { source, target });
  await expect.poll(async () => (await page.evaluate(() => window.desktopApi.listIngestionCandidates({}))).total).toBe(1);
  const candidates = await page.evaluate(() => window.desktopApi.listIngestionCandidates({}));
  await application!.evaluate(({ dialog }) => { dialog.showMessageBox = (async (options: { title?: string }) => ({ response: options.title === "确认备份并退出" ? 1 : 0, checkboxChecked: false })) as typeof dialog.showMessageBox; });
  const stoppedForBackup = new Promise<void>(done => application!.once("close", () => done()));
  await page.evaluate(() => window.desktopApi.prepareDesktopUpgrade()); await stoppedForBackup; application = undefined;
  const backupRoot = join(profile, "private-backups"), backupIds = (await readdir(backupRoot)).filter(id => /^[a-f0-9-]{36}$/.test(id));
  expect(backupIds.length).toBeGreaterThan(0);
  const backupManifests = await Promise.all(backupIds.map(async id => {
    const path = join(backupRoot, id, "manifest.json"), manifest = JSON.parse(await readFile(path, "utf8")) as { files: { path: string; sha256: string }[] };
    return { id, sha256: await digest(path), files: manifest.files };
  }));
  expect(backupManifests.some(backup => backup.files.some(file => file.path === "desktop.sqlite3"))).toBe(true);
  // 初次目标授权会创建归属标记；重装应保持该标记和既有媒体，而不是假定目录完全无写入。
  const targetEntries = (await readdir(target)).sort();
  expect(targetEntries).toEqual([".media-marshal", "已有媒体.mkv"]);
  for (const operation of ["覆盖安装", "卸载后重装"]) {
    if (operation === "卸载后重装") {
      await rm(installed, { recursive: true }); await expect(stat(installed)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(join(profile, "desktop.sqlite3"))).isFile()).toBe(true);
    }
    await cp(sourceApp, installed, { recursive: true, dereference: false, verbatimSymlinks: true });
    expect(await digest(join(installed, "Contents/Resources/app.asar"))).toBe(archiveHash);
    page = await launch(join(installed, "Contents/MacOS/Media Marshal"), profile);
    expect(await page.evaluate((id) => window.desktopApi.getSourceRule(id), rule.id)).toMatchObject({ id: rule.id, version: rule.version, configuration: rule.configuration, paused: rule.paused });
    expect((await page.evaluate(() => window.desktopApi.listIngestionCandidates({}))).items.map(value => value.id)).toEqual(candidates.items.map(value => value.id));
    expect(await page.evaluate(() => window.desktopApi.listTasks({ page: 1, pageSize: 100 }))).toMatchObject({ total: 0 }); expect(await page.evaluate(() => window.desktopApi.listJobs())).toEqual([]);
    await application!.close(); application = undefined;
    expect(await digest(join(source, "原始.S01E01.mkv"))).toBe(sourceHash); expect(await digest(join(target, "已有媒体.mkv"))).toBe(targetHash); expect((await readdir(target)).sort()).toEqual(targetEntries);
    for (const [path, original] of [[join(source, "原始.S01E01.mkv"), sourceIdentity], [join(target, "已有媒体.mkv"), targetIdentity]] as const) expect(await stat(path)).toMatchObject({ ino: original.ino, mtimeMs: original.mtimeMs, birthtimeMs: original.birthtimeMs, size: original.size });
    for (const backup of backupManifests) {
      expect(await digest(join(backupRoot, backup.id, "manifest.json"))).toBe(backup.sha256);
      for (const file of backup.files) expect(await digest(join(backupRoot, backup.id, file.path))).toBe(file.sha256);
    }
  }
  await writeFile(resolve("test-results/desktop/install-matrix-reinstall.json"), JSON.stringify({ target: `${process.platform}-${process.arch}`, asarSha256: archiveHash, configurationVersion: rule.version, candidatesRetained: candidates.total, backupsRetained: backupManifests.length, backupFilesVerified: backupManifests.reduce((count, backup) => count + backup.files.length, 0), existingFilesRetained: 2, sameFileIdentityAndContents: true, unicodeAndSpaceInstallPath: true, replacementInstall: true, uninstallAndReinstall: true, systemPathOnly: true, directoryDialog: "controlled-result", upgradeDialog: "controlled-result" }, null, 2));
});

test("历史实际 DMG 手动替换为当前应用后保留来源身份、暂停和媒体并备份旧库", async () => {
  test.skip(!process.env.MARSHAL_PREVIOUS_APP_PATH, "需要明确指定历史实际 DMG 的可执行文件"); test.setTimeout(180000);
  const previous = process.env.MARSHAL_PREVIOUS_APP_PATH!, previousApp = dirname(dirname(dirname(resolve(previous)))), sourceApp = dirname(dirname(dirname(resolve(executable!)))), installed = join(directory, "手动升级 中文", "Media Marshal.app"), profile = join(directory, "升级保留资料"), source = join(directory, "旧来源 中文"), target = join(directory, "旧媒体库 中文");
  await mkdir(source); await mkdir(target); await writeFile(join(source, "原下载.mkv"), "旧版来源文件保持"); await writeFile(join(target, "现有影片.mkv"), "现有影片保持");
  const sourceHash = await digest(join(source, "原下载.mkv")), targetHash = await digest(join(target, "现有影片.mkv"));
  await cp(previousApp, installed, { recursive: true, dereference: false, verbatimSymlinks: true });
  let page = await launch(join(installed, "Contents/MacOS/Media Marshal"), profile);
  const originalRuntime = await page.evaluate(() => window.desktopApi.getRuntime()); expect(originalRuntime.status!.schemaVersion).toBeGreaterThan(0); expect(originalRuntime.status!.schemaVersion).toBeLessThan(CORE_DATA_SCHEMA_VERSION);
  await application!.evaluate(({ dialog }, paths) => { let index = 0; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog; }, [source, target]);
  const original = await page.evaluate(async ({ source, target }) => {
    await window.desktopApi.chooseDirectory("source"); await window.desktopApi.chooseDirectory("target");
    const row = await window.desktopApi.saveSource({ name: "历史实际安装来源", kind: "custom", sourcePath: source, targetPath: target, mediaType: "AUTO", operation: "COPY", automatic: false });
    await window.desktopApi.pauseSource(row.id, true); return row;
  }, { source, target });
  await application!.close(); application = undefined;
  await rm(installed, { recursive: true }); await cp(sourceApp, installed, { recursive: true, dereference: false, verbatimSymlinks: true });
  page = await launch(join(installed, "Contents/MacOS/Media Marshal"), profile);
  expect(await page.evaluate(() => window.desktopApi.getRuntime())).toMatchObject({ core: "ready", status: { schemaVersion: CORE_DATA_SCHEMA_VERSION } });
  const rules = await page.evaluate(() => window.desktopApi.listSourceRules()); expect(rules).toHaveLength(1); expect(rules[0]).toMatchObject({ id: original.id, paused: true, configuration: { type: "local", name: original.name, client: "custom", sourcePath: source, organization: { targetPath: target, automatic: false } } });
  expect(await page.evaluate(() => window.desktopApi.listJobs())).toEqual([]); expect(await page.evaluate(() => window.desktopApi.listTasks({ page: 1, pageSize: 100 }))).toMatchObject({ total: 0 });
  const backupRoot = join(profile, "private-backups"), manifests = await Promise.all((await readdir(backupRoot)).filter(id => /^[a-f0-9-]{36}$/.test(id)).map(async id => JSON.parse(await readFile(join(backupRoot, id, "manifest.json"), "utf8"))));
  expect(manifests.some(value => value.version.schemaVersion === originalRuntime.status!.schemaVersion && value.files.some((file: { path: string }) => file.path === "desktop.sqlite3"))).toBe(true);
  await application!.close(); application = undefined;
  expect(await digest(join(source, "原下载.mkv"))).toBe(sourceHash); expect(await digest(join(target, "现有影片.mkv"))).toBe(targetHash);
  await writeFile(resolve("test-results/desktop/install-matrix-upgrade.json"), JSON.stringify({ target: `${process.platform}-${process.arch}`, previousAppVersion: originalRuntime.appVersion, previousSchema: originalRuntime.status!.schemaVersion, previousAsarSha256: await digest(join(previousApp, "Contents/Resources/app.asar")), currentAsarSha256: await digest(join(sourceApp, "Contents/Resources/app.asar")), currentSchema: CORE_DATA_SCHEMA_VERSION, previousSchemaBackupPresent: true, sourceIdentityAndPauseRetained: true, existingFilesRetained: 2, systemPathOnly: true, directoryDialog: "controlled-result" }, null, 2));
});
