import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";
import Database from "better-sqlite3";
import { CoreDatabase, migrations } from "../../../../../packages/media-core/src/infrastructure/database";
import { ManagedUpgradeBackups, type RuntimeVersion } from "./upgrades";
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const version: RuntimeVersion = { appVersion: "0.2.0", schemaVersion: 6, target: "darwin-arm64", components: { openlist: "固定组件摘要" } };
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "marshal-upgrade-")); directories.push(path); const data = join(path, "data"), media = join(path, "downloads");
  await mkdir(data); await mkdir(media); await writeFile(join(media, "保留.mp4"), "现存成果");
  const db = await CoreDatabase.open(join(data, "desktop.sqlite3"), migrations.slice(0, 4)); db.connection.prepare("INSERT INTO app_setting VALUES('preserved','before')").run(); db.close();
  await mkdir(join(data, "sidecars", "sessions", "旧私有状态"), { recursive: true }); await writeFile(join(data, "sidecars", "sessions", "旧私有状态", "config.json"), "私有组件配置"); await writeFile(join(data, "credentials.json"), "仅测试的密文占位");
  return { path, data, media, backups: new ManagedUpgradeBackups(data) };
}
describe("停写后的整包状态快照与恢复", () => {
  it("Core 启动中断不能沿用旧 Schema 元数据，ready 后才确认新版本", async () => {
    const f = await fixture(); await f.backups.recordVersion(version); expect(await f.backups.previousVersion()).toEqual(version);
    await f.backups.markCoreStarting(); const reopened = new ManagedUpgradeBackups(f.data); expect(await reopened.previousVersion()).toBeNull();
    const snapshot = await reopened.capture({ ...version, appVersion: "legacy", schemaVersion: 0 }); expect(snapshot.schemaVersion).toBe(0);
    await reopened.recordVersion({ ...version, schemaVersion: 15 }); expect(await new ManagedUpgradeBackups(f.data).previousVersion()).toEqual({ ...version, schemaVersion: 15 });
    await expect(stat(join(f.data, "runtime-start.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("崩溃遗留 WAL 的完整私有快照恢复后仍包含已提交记录", async () => {
    const f = await fixture(), database = join(f.data, "desktop.sqlite3"), script = join(f.path, "wal-writer.mjs");
    const require = createRequire(resolve("package.json"));
    await writeFile(script, `import Database from ${JSON.stringify(pathToFileURL(require.resolve("better-sqlite3")).href)};
const db=new Database(process.argv[2]); db.pragma('journal_mode = WAL');db.pragma('wal_autocheckpoint = 0');db.pragma('wal_checkpoint(TRUNCATE)');
db.prepare("UPDATE app_setting SET value='in-wal' WHERE key='preserved'").run();process.stdout.write('WAL_READY\\n');process.stdin.resume();`);
    const child = spawn(process.execPath, [script, database], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "ignore"] });
    const exited = new Promise<void>((done) => child.once("close", () => done()));
    try {
      await new Promise<void>((done, fail) => { let output = ""; const timer = setTimeout(() => fail(new Error("WAL 写入进程未就绪")), 5000); child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("WAL_READY\n")) { clearTimeout(timer); done(); } }); child.once("error", (error) => { clearTimeout(timer); fail(error); }); child.once("exit", () => { clearTimeout(timer); fail(new Error("WAL 写入进程提前退出")); }); });
      child.kill("SIGKILL"); await exited;
      expect((await stat(database + "-wal")).size).toBeGreaterThan(32);
      const mainOnly = join(f.path, "main-only.sqlite3"); await copyFile(database, mainOnly);
      const incomplete = new Database(mainOnly, { readonly: true }); try { expect(incomplete.prepare("SELECT value FROM app_setting WHERE key='preserved'").get()).toEqual({ value: "before" }); } finally { incomplete.close(); }
      const backup = await f.backups.capture({ ...version, schemaVersion: 4 });
      const manifest = JSON.parse(await readFile(join(f.backups.root, backup.id, "manifest.json"), "utf8")); expect(manifest.files.some((file: { path: string }) => file.path === "desktop.sqlite3-wal")).toBe(true);
      const changed = await CoreDatabase.open(database, migrations.slice(0, 4)); changed.connection.prepare("UPDATE app_setting SET value='after' WHERE key='preserved'").run(); changed.close();
      await f.backups.restore(backup.id, version);
      const restored = await CoreDatabase.open(database, migrations.slice(0, 4));
      try { expect(restored.connection.prepare("SELECT value FROM app_setting WHERE key='preserved'").get()).toEqual({ value: "in-wal" }); } finally { restored.close(); }
      expect(await f.backups.reconciliationNeeded()).toBe(true); expect(await readFile(join(f.media, "保留.mp4"), "utf8")).toBe("现存成果");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
  });
  it("快照包含匹配私有状态，旧 Core 拒绝新版库；恢复数据不改动下载成果", async () => {
    const f = await fixture(), backup = await f.backups.capture({ ...version, appVersion: "0.1.0", schemaVersion: 4 });
    const db = await CoreDatabase.open(join(f.data, "desktop.sqlite3")); db.connection.prepare("UPDATE app_setting SET value='after'").run(); db.close();
    await expect(CoreDatabase.open(join(f.data, "desktop.sqlite3"), migrations.slice(0, 4))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await writeFile(join(f.data, "credentials.json"), "新的密文占位"); await f.backups.restore(backup.id, version);
    const restored = await CoreDatabase.open(join(f.data, "desktop.sqlite3"), migrations.slice(0, 4)); expect(restored.schemaVersion).toBe(4); expect(restored.connection.prepare("SELECT value FROM app_setting").get()).toEqual({ value: "before" }); restored.close();
    expect(await f.backups.reconciliationNeeded()).toBe(true);
    expect(await readFile(join(f.data, "credentials.json"), "utf8")).toBe("仅测试的密文占位"); expect(await readFile(join(f.media, "保留.mp4"), "utf8")).toBe("现存成果");
    expect(JSON.stringify(await f.backups.list())).not.toMatch(/私有|密文|保留.mp4/);
    expect((await stat(join(f.backups.root, backup.id))).mode & 0o077).toBe(0);
  });
  it("恢复到一半发生异常时凭日志还原全部原文件，不留下半套状态", async () => {
    const f = await fixture(), backup = await f.backups.capture({ ...version, schemaVersion: 4 }); await writeFile(join(f.data, "credentials.json"), "当前密文");
    await expect(f.backups.restore(backup.id, version, async (name) => { if (name === "credentials.json") throw new Error("模拟恢复进程中断"); })).rejects.toThrow();
    await f.backups.recover(); expect(await readFile(join(f.data, "credentials.json"), "utf8")).toBe("当前密文"); expect(await readFile(join(f.media, "保留.mp4"), "utf8")).toBe("现存成果");
    const db = await CoreDatabase.open(join(f.data, "desktop.sqlite3"), migrations.slice(0, 4)); expect(db.schemaVersion).toBe(4); db.close();
  });
  it("恢复进程被 SIGKILL 后，新进程在打开业务库前回滚半套状态", async () => {
    const f = await fixture(), backup = await f.backups.capture({ ...version, schemaVersion: 4 }); await writeFile(join(f.data, "credentials.json"), "恢复前当前密文");
    const compile = join(f.path, "compiled"); await mkdir(compile); const require = createRequire(resolve("package.json"));
    for (const name of ["upgrades", "private-files"]) {
      const source = await readFile(resolve(`apps/desktop/src/main/cloud/${name}.ts`), "utf8"), output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
        .replaceAll('"@media-marshal/contracts"', JSON.stringify(pathToFileURL(resolve("packages/contracts/dist/index.js")).href))
        .replaceAll('"zod"', JSON.stringify(pathToFileURL(require.resolve("zod")).href)).replaceAll('"./private-files"', '"./private-files.mjs"');
      await writeFile(join(compile, name + ".mjs"), output);
    }
    const script = join(compile, "crash.mjs"); await writeFile(script, `import {ManagedUpgradeBackups} from './upgrades.mjs'; await new ManagedUpgradeBackups(${JSON.stringify(f.data)}).restore(${JSON.stringify(backup.id)},${JSON.stringify(version)},async name=>{if(name==='credentials.json'){process.stdout.write('RESTORING\\n');await new Promise(()=>{});}});`);
    const child = spawn(process.execPath, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((done, fail) => { const timer = setTimeout(() => fail(new Error("恢复进程未到达检查点")), 5000); child.stdout.on("data", () => { clearTimeout(timer); done(); }); child.once("exit", () => { clearTimeout(timer); fail(new Error("恢复进程提前退出")); }); });
      const exited = new Promise((done) => child.once("exit", done)); child.kill("SIGKILL"); await exited;
      await new ManagedUpgradeBackups(f.data).recover(); expect(await readFile(join(f.data, "credentials.json"), "utf8")).toBe("恢复前当前密文"); expect(await readFile(join(f.media, "保留.mp4"), "utf8")).toBe("现存成果");
      const db = await CoreDatabase.open(join(f.data, "desktop.sqlite3"), migrations.slice(0, 4)); expect(db.schemaVersion).toBe(4); db.close();
    } finally { child.kill("SIGKILL"); }
  }, 10000);
  it("损坏摘要、未来版本及链接在恢复写入之前被拒绝", async () => {
    const f = await fixture(), backup = await f.backups.capture({ ...version, schemaVersion: 4 });
    await writeFile(join(f.backups.root, backup.id, "credentials.json"), "被替换的备份"); await expect(f.backups.restore(backup.id, version)).rejects.toMatchObject({ code: "STORAGE_ERROR" }); expect(await readFile(join(f.data, "credentials.json"), "utf8")).toBe("仅测试的密文占位");
    const future = await f.backups.capture({ ...version, schemaVersion: 999 }); await expect(f.backups.restore(future.id, version)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    const otherArchitecture = await f.backups.capture({ ...version, schemaVersion: 4, target: "darwin-x64" }); await expect(f.backups.restore(otherArchitecture.id, version)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    const linked = await f.backups.capture({ ...version, schemaVersion: 4 }); await rm(join(f.backups.root, linked.id, "credentials.json")); await symlink(join(f.data, "credentials.json"), join(f.backups.root, linked.id, "credentials.json")); await expect(f.backups.restore(linked.id, version)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
});
