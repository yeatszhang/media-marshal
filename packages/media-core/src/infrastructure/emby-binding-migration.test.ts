import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase, migrations } from "./database.js";
const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
it("v31 追加绑定证据，旧关联原样保留，备份可复用且旧核心拒绝新库", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marshal-emby-binding-migration-")); paths.push(directory); const path = join(directory, "core.sqlite3");
  const old = await CoreDatabase.open(path, migrations.slice(0, 30)); old.connection.prepare("INSERT INTO app_setting VALUES('保留设置','不触碰媒体')").run(); old.connection.prepare("INSERT INTO emby_connection VALUES('old-connection',2,'old-server','http://localhost:8096',1,?)").run(new Date().toISOString()); old.close();
  const db = await CoreDatabase.open(path, migrations.slice(0, 31));
  expect(db.schemaVersion).toBe(31); expect(db.connection.prepare("SELECT version,server_id FROM emby_connection").get()).toEqual({ version: 2, server_id: "old-server" });
  expect(db.connection.prepare("SELECT value FROM app_setting WHERE key='保留设置'").get()).toEqual({ value: "不触碰媒体" }); expect(db.connection.pragma("foreign_key_check")).toEqual([]); db.close();
  const backup = await readFile(path + ".before-v31.bak"); await expect(CoreDatabase.open(path, migrations.slice(0, 30))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  const reopened = await CoreDatabase.open(path, migrations.slice(0, 31)); reopened.close(); expect(await readFile(path + ".before-v31.bak")).toEqual(backup);
});
it("v31 失败回滚新增列及收据表，重试保留原 v30 备份", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marshal-emby-binding-rollback-")); paths.push(directory); const path = join(directory, "core.sqlite3");
  (await CoreDatabase.open(path, migrations.slice(0, 30))).close();
  await expect(CoreDatabase.open(path, [...migrations.slice(0, 30), { ...migrations[30]!, sql: migrations[30]!.sql + "SELECT missing_emby_binding_migration();" }])).rejects.toThrow();
  const old = await CoreDatabase.open(path, migrations.slice(0, 30)); expect((old.connection.pragma("table_info(emby_library)") as { name: string }[]).some((row) => row.name === "binding_json")).toBe(false); expect(old.connection.prepare("SELECT name FROM sqlite_master WHERE name='emby_binding_command'").all()).toEqual([]); old.close();
  const backup = await readFile(path + ".before-v31.bak"); const db = await CoreDatabase.open(path, migrations.slice(0, 31)); db.close(); expect(await readFile(path + ".before-v31.bak")).toEqual(backup);
});
