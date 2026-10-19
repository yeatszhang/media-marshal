import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { CoreDatabase, migrations } from "./database";
const directories: string[] = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "marshal-db-"));
  directories.push(directory);
  return join(directory, "desktop.sqlite3");
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("显式数据库迁移", () => {
  it("新库建立版本和基础表，重新打开保留配置", async () => {
    const path = await temporary();
    let db = await CoreDatabase.open(path);
    expect(db.schemaVersion).toBe(1);
    db.connection
      .prepare("INSERT INTO app_setting VALUES('test','saved')")
      .run();
    db.close();
    db = await CoreDatabase.open(path);
    expect(
      db.connection
        .prepare("SELECT value FROM app_setting WHERE key='test'")
        .get(),
    ).toEqual({ value: "saved" });
    db.close();
  });
  it("桌面旧版升级前备份包含 WAL 中的已提交数据", async () => {
    const path = await temporary();
    const first = await CoreDatabase.open(path);
    first.connection
      .prepare("INSERT INTO app_setting VALUES('backup','present')")
      .run();
    first.close();
    const upgraded = await CoreDatabase.open(path, [
      ...migrations,
      {
        version: 2,
        sql: "CREATE TABLE upgrade_check(id INTEGER PRIMARY KEY);",
      },
    ]);
    expect(upgraded.schemaVersion).toBe(2);
    upgraded.close();
    const backup = new Database(`${path}.before-v2.bak`, { readonly: true });
    expect(backup.pragma("user_version", { simple: true })).toBe(1);
    expect(
      backup.prepare("SELECT value FROM app_setting WHERE key='backup'").get(),
    ).toEqual({ value: "present" });
    backup.close();
  });
  it("迁移失败回滚该步，不继续运行调度", async () => {
    const path = await temporary();
    (await CoreDatabase.open(path)).close();
    await expect(
      CoreDatabase.open(path, [
        ...migrations,
        { version: 2, sql: "CREATE TABLE half_done(id INTEGER); INVALID SQL;" },
      ]),
    ).rejects.toThrow();
    const db = new Database(path);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='half_done'").get(),
    ).toBeUndefined();
    db.close();
  });
  it("拒绝未来版本和无版本旧 Java 表", async () => {
    const path = await temporary();
    const future = new Database(path);
    future.pragma("user_version = 999");
    future.close();
    await expect(CoreDatabase.open(path)).rejects.toMatchObject({
      code: "STORAGE_ERROR",
    });
    const oldPath = await temporary();
    const legacy = new Database(oldPath);
    legacy.exec("CREATE TABLE media_task(id INTEGER PRIMARY KEY);");
    legacy.close();
    await expect(CoreDatabase.open(oldPath)).rejects.toMatchObject({
      code: "STORAGE_ERROR",
    });
  });
  it("未知版本迁移序号不能跳跃，数据库约束阻止重复设置", async () => {
    await expect(
      CoreDatabase.open(await temporary(), [{ version: 2, sql: "SELECT 1;" }]),
    ).rejects.toThrow();
    const db = await CoreDatabase.open(await temporary());
    db.connection.prepare("INSERT INTO app_setting VALUES('unique','1')").run();
    expect(() =>
      db.connection
        .prepare("INSERT INTO app_setting VALUES('unique','2')")
        .run(),
    ).toThrow();
    db.close();
  });
});
