// 在自有临时安装目录内复制、卸载并重装 App，保留已授权的临时验收资料目录。
import { _electron } from "@playwright/test";
import { mkdtemp, realpath, cp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
const [profile, sourceApp] = process.argv.slice(2); let application, directory;
try {
  const data = await realpath(profile), temporary = await realpath(tmpdir()); if (!data.startsWith(temporary + sep + "marshal-quark-desktop-") || !sourceApp?.endsWith("/Media Marshal.app")) throw new Error();
  directory = await mkdtemp(join(tmpdir(), "marshal-owned-install-")); const installed = join(directory, "Media Marshal.app");
  const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const launch = async () => {
    application = await _electron.launch({ executablePath: join(installed, "Contents/MacOS/Media Marshal"), args: [`--user-data-dir=${profile}`], env });
    const page = await application.firstWindow(); await page.getByText("核心已连接", { exact: true }).waitFor();
    const snapshot = await page.evaluate(async () => ({ downloads: await window.desktopApi.listDownloads({ page: 1, pageSize: 100 }), subscriptions: await window.desktopApi.listCloudSubscriptions({ page: 1, pageSize: 100 }) }));
    await application.close(); application = undefined; return snapshot;
  };
  await cp(sourceApp, installed, { recursive: true, dereference: false, verbatimSymlinks: true }); const before = await launch();
  if (!before.downloads.items.some((item) => item.state === "COMPLETED")) throw new Error();
  await rm(installed, { recursive: true }); await cp(sourceApp, installed, { recursive: true, dereference: false, verbatimSymlinks: true }); const after = await launch();
  const stable = (value) => JSON.stringify({ total: value.downloads.total, items: value.downloads.items.map(({ id, state }) => ({ id, state })), subscriptions: value.subscriptions.items.map(({ id, configurationVersion, enabled }) => ({ id, configurationVersion, enabled })) });
  if (stable(before) !== stable(after)) throw new Error();
  const report = { target: `${process.platform}-${process.arch}`, packaged: true, ownedAppCopyRemovedAndReinstalled: true, existingUserDataRetained: true, sameDownloadAndSubscriptionRecords: true, developerPathExcluded: true, normalApplicationsDirectoryModified: false, signed: false };
  await writeFile("test-results/sidecars/mac-reinstall.json", JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report));
} catch { console.log("自有安装副本的卸载重装验收未通过；未打印个人路径或原始错误。"); process.exitCode = 1; }
finally { await application?.close().catch(() => {}); if (directory) await rm(directory, { recursive: true, force: true }); }
