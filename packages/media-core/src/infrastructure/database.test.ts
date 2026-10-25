import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { CoreDatabase, migrations, SCHEMA_VERSION } from "./database";
import { sourceConfigurationSchema } from "@media-marshal/contracts";
import { randomUUID } from "node:crypto";
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
  it("v13 来源快照原文升级后保持，默认忽略兼容；旧核心拒绝 v14", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 13)), id = randomUUID(), stamp = new Date().toISOString();
    const configuration = JSON.stringify({ type: "local", name: "既有来源", client: "baidu", sourcePath: "/既有输入", organization: { targetPath: "/既有目标" } });
    first.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,paused,created_at) VALUES(?,'既有来源','baidu','/既有输入','/既有目标','AUTO','COPY',1,?)").run(id, stamp);
    first.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,paused,local_source_id,created_at,updated_at) VALUES(?,'local',1,1,?,1,?,?,?)").run(id, configuration, id, stamp, stamp);
    first.connection.prepare("INSERT INTO source_rule_version(source_id,version,configuration_json,local_source_id,created_at) VALUES(?,1,?,?,?)").run(id, configuration, id, stamp); first.close();
    const upgraded = await CoreDatabase.open(path);
    try {
      expect(upgraded.schemaVersion).toBe(14);
      expect(upgraded.connection.prepare("SELECT draft_json,paused,local_source_id FROM source_rule").get()).toEqual({ draft_json: configuration, paused: 1, local_source_id: id });
      expect(upgraded.connection.prepare("SELECT configuration_json FROM source_rule_version").get()).toEqual({ configuration_json: configuration });
      expect(sourceConfigurationSchema.parse(JSON.parse(configuration))).not.toHaveProperty("ignoredFilePatterns");
      expect(upgraded.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
    } finally { upgraded.close(); }
    const backup = new Database(`${path}.before-v14.bak`, { readonly: true });
    try { expect(backup.pragma("user_version", { simple: true })).toBe(13); expect(backup.prepare("SELECT draft_json FROM source_rule").get()).toEqual({ draft_json: configuration }); }
    finally { backup.close(); }
    await expect(CoreDatabase.open(path, migrations.slice(0, 13))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("生产连接独占所有权，旧所有者释放后才能重新打开", async () => {
    const path = await temporary();
    const first = await CoreDatabase.open(path, migrations, { exclusiveOwner: true });
    try {
      first.connection.prepare("INSERT INTO app_setting VALUES('owner','original')").run();
      await expect(CoreDatabase.open(path, migrations, { exclusiveOwner: true })).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    } finally { first.close(); }
    const next = await CoreDatabase.open(path, migrations, { exclusiveOwner: true });
    expect(next.connection.prepare("SELECT value FROM app_setting WHERE key='owner'").get()).toEqual({ value: "original" }); next.close();
  });
  it("新库建立版本和基础表，重新打开保留配置", async () => {
    const path = await temporary();
    let db = await CoreDatabase.open(path);
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
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
    const first = await CoreDatabase.open(path, migrations.slice(0, 1));
    first.connection
      .prepare("INSERT INTO app_setting VALUES('backup','present')")
      .run();
    first.close();
    const upgraded = await CoreDatabase.open(path);
    expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION);
    upgraded.close();
    const backup = new Database(`${path}.before-v${SCHEMA_VERSION}.bak`, { readonly: true });
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
        { version: SCHEMA_VERSION + 1, sql: "CREATE TABLE half_done(id INTEGER); INVALID SQL;" },
      ]),
    ).rejects.toThrow();
    const db = new Database(path);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
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
