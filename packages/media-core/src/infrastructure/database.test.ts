import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, copyFile, stat, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
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
  it("v17 识别编辑迁移不重写已有字段或排队任务，保留备份并阻止旧核心写新库", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 17)), source = randomUUID(), task = randomUUID(), stamp = new Date().toISOString(), parsed = '{"title":"原作品","year":2026}';
    first.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'保留来源','custom','/输入','/媒体库','AUTO','COPY',?)").run(source, stamp);
    first.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,parsed_json,created_at,updated_at) VALUES(?,?,?,'AWAITING_CONFIRMATION',?,?,?)").run(task, source, "/输入/原文件.mp4", parsed, stamp, stamp); first.close();
    const upgraded = await CoreDatabase.open(path); try { expect(upgraded.schemaVersion).toBe(18); expect(upgraded.connection.prepare("SELECT id,status,parsed_json FROM media_task").get()).toEqual({ id: task, status: "AWAITING_CONFIRMATION", parsed_json: parsed }); expect(upgraded.connection.prepare("SELECT count(*) AS n FROM ingestion_recognition_edit").get()).toEqual({ n: 0 }); expect(upgraded.connection.prepare("SELECT count(*) AS n FROM ingestion_recognition_command").get()).toEqual({ n: 0 }); } finally { upgraded.close(); }
    const backup = new Database(`${path}.before-v18.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(17); expect(backup.prepare("SELECT parsed_json FROM media_task WHERE id=?").get(task)).toEqual({ parsed_json: parsed }); } finally { backup.close(); }
    await expect(CoreDatabase.open(path, migrations.slice(0, 17))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("v16 删除迁移保留来源、任务与外键，历史路径可复用且旧核心拒绝打开", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 16)), id = randomUUID(), task = randomUUID(), stamp = new Date().toISOString();
    const configuration = JSON.stringify({ type: "local", name: "历史来源", client: "custom", sourcePath: "/旧输入", organization: { targetPath: "/旧目标" } });
    first.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'历史来源','custom','/旧输入','/旧目标','AUTO','COPY',?)").run(id, stamp);
    first.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,local_source_id,created_at,updated_at) VALUES(?,'local',1,2,?,?,?,?)").run(id, configuration, id, stamp, stamp);
    first.connection.prepare("INSERT INTO source_rule_version(source_id,version,configuration_json,local_source_id,created_at) VALUES(?,1,?,?,?)").run(id, configuration, id, stamp);
    first.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'DONE',?,?)").run(task, id, "/旧输入/原文件.mp4", stamp, stamp); first.close();
    const upgraded = await CoreDatabase.open(path, migrations.slice(0, 17));
    try {
      const db = upgraded.connection; expect(upgraded.schemaVersion).toBe(17); expect(db.pragma("foreign_keys", { simple: true })).toBe(1); expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.prepare("SELECT version,draft_revision,draft_json,deleted_at,lifecycle_revision FROM source_rule").get()).toEqual({ version: 1, draft_revision: 2, draft_json: configuration, deleted_at: null, lifecycle_revision: 0 });
      expect(db.prepare("SELECT id,source_id,status FROM media_task").get()).toEqual({ id: task, source_id: id, status: "DONE" });
      expect(() => db.prepare("UPDATE source_rule SET paused=0,deleted_at=? WHERE id=?").run(stamp, id)).toThrow("必须保持暂停");
      expect(() => db.prepare("DELETE FROM desktop_source WHERE id=?").run(id)).toThrow();
      db.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'新来源','custom','/旧输入','/新目标','AUTO','COPY',?)").run(randomUUID(), stamp);
      expect(db.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 1 });
    } finally { upgraded.close(); }
    const backup = new Database(`${path}.before-v17.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(16); expect(backup.prepare("SELECT count(*) AS n FROM desktop_source").get()).toEqual({ n: 1 }); } finally { backup.close(); }
    await expect(CoreDatabase.open(path, migrations.slice(0, 16))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("重建引用表失败会回滚表和 schema 版本", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 16)); first.close();
    await expect(CoreDatabase.open(path, [...migrations.slice(0, 16), { ...migrations[16]!, sql: migrations[16]!.sql + "SELECT missing_migration_function();" }])).rejects.toThrow();
    const original = await CoreDatabase.open(path, migrations.slice(0, 16)); try { expect(original.schemaVersion).toBe(16); expect(original.connection.prepare("SELECT count(*) AS n FROM desktop_source").get()).toEqual({ n: 0 }); expect(original.connection.prepare("SELECT name FROM pragma_table_info('source_rule') WHERE name='deleted_at'").get()).toBeUndefined(); } finally { original.close(); }
  });
  it("v15 资产历史升级后仅保留一个当前版本，已完成 COPY 摘要作为原内容基线", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 15)), source = randomUUID(), old = randomUUID(), latest = randomUUID(), task = randomUUID(), target = randomUUID(), stamp = new Date().toISOString(), sha = "a".repeat(64);
    const sql = first.connection;
    sql.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'历史输入','custom','/输入','/媒体库','MOVIE','COPY',?)").run(source, stamp);
    sql.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'DONE',?,?)").run(task, source, "/输入/保留.mp4", stamp, stamp);
    sql.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,snapshot_json,state,task_id,created_at,updated_at) VALUES(?,?,'[\"保留.mp4\"]','旧属性','{}','PROCESSED',?,?,?)").run(old, source, task, stamp, stamp);
    sql.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,snapshot_json,state,created_at,updated_at) VALUES(?,?,'[\"保留.mp4\"]','新属性','{}','OBSERVING',?,?)").run(latest, source, stamp, stamp);
    sql.prepare("INSERT INTO media_target_root(id,grant_json) VALUES(?,'{}')").run(target);
    sql.prepare("INSERT INTO ingestion_operation(id,candidate_id,task_id,request_key,target_root_id,target_slot,plan_json,attempt_id,phase,evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,'slot','{}',?,'RECORDED',?,?,?)").run(randomUUID(), old, task, randomUUID(), target, randomUUID(), JSON.stringify({ sha256: sha }), stamp, stamp); first.close();
    const upgraded = await CoreDatabase.open(path, migrations.slice(0, 16));
    try {
      expect(upgraded.schemaVersion).toBe(16);
      expect(upgraded.connection.prepare("SELECT id,attribute_key,is_current,expected_sha256 FROM ingestion_candidate ORDER BY rowid").all()).toEqual([{ id: old, attribute_key: "旧属性", is_current: 0, expected_sha256: sha }, { id: latest, attribute_key: "新属性", is_current: 1, expected_sha256: null }]);
      expect(upgraded.connection.prepare("SELECT status FROM media_task WHERE id=?").get(task)).toEqual({ status: "DONE" }); expect(upgraded.connection.prepare("SELECT count(*) AS n FROM ingestion_content_review").get()).toEqual({ n: 0 });
      expect(() => upgraded.connection.prepare("UPDATE ingestion_candidate SET is_current=1 WHERE id=?").run(old)).toThrow();
    } finally { upgraded.close(); }
    await expect(CoreDatabase.open(path, migrations.slice(0, 15))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    const backup = new Database(`${path}.before-v16.bak`, { readonly: true });
    try { expect(backup.pragma("user_version", { simple: true })).toBe(15); expect(backup.prepare("SELECT expected_sha256 FROM ingestion_candidate WHERE id=?").get(old)).toEqual({ expected_sha256: null }); } finally { backup.close(); }
  });
  it("v13 来源快照原文升级后保持，默认忽略兼容；旧核心拒绝新版本", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 13)), id = randomUUID(), stamp = new Date().toISOString();
    const configuration = JSON.stringify({ type: "local", name: "既有来源", client: "baidu", sourcePath: "/既有输入", organization: { targetPath: "/既有目标" } });
    first.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,paused,created_at) VALUES(?,'既有来源','baidu','/既有输入','/既有目标','AUTO','COPY',1,?)").run(id, stamp);
    first.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,paused,local_source_id,created_at,updated_at) VALUES(?,'local',1,1,?,1,?,?,?)").run(id, configuration, id, stamp, stamp);
    first.connection.prepare("INSERT INTO source_rule_version(source_id,version,configuration_json,local_source_id,created_at) VALUES(?,1,?,?,?)").run(id, configuration, id, stamp); first.close();
    const upgraded = await CoreDatabase.open(path);
    try {
      expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION);
      expect(upgraded.connection.prepare("SELECT draft_json,paused,local_source_id FROM source_rule").get()).toEqual({ draft_json: configuration, paused: 1, local_source_id: id });
      expect(upgraded.connection.prepare("SELECT configuration_json FROM source_rule_version").get()).toEqual({ configuration_json: configuration });
      expect(sourceConfigurationSchema.parse(JSON.parse(configuration))).not.toHaveProperty("ignoredFilePatterns");
      expect(upgraded.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
    } finally { upgraded.close(); }
    const backup = new Database(`${path}.before-v${SCHEMA_VERSION}.bak`, { readonly: true });
    try { expect(backup.pragma("user_version", { simple: true })).toBe(13); expect(backup.prepare("SELECT draft_json FROM source_rule").get()).toEqual({ draft_json: configuration }); }
    finally { backup.close(); }
    await expect(CoreDatabase.open(path, migrations.slice(0, 14))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
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
    try {
      first.connection.pragma("wal_autocheckpoint = 0"); first.connection.pragma("wal_checkpoint(TRUNCATE)");
      first.connection.prepare("INSERT INTO app_setting VALUES('backup','present')").run();
      expect((await stat(path + "-wal")).size).toBeGreaterThan(32);
      // 保留原连接使 WAL 不被关闭时自动 checkpoint；仅复制主文件确实缺少这条记录。
      const mainOnly = path + ".main-only"; await copyFile(path, mainOnly);
      const incomplete = new Database(mainOnly, { readonly: true });
      try { expect(incomplete.prepare("SELECT value FROM app_setting WHERE key='backup'").get()).toBeUndefined(); } finally { incomplete.close(); }
      const upgraded = await CoreDatabase.open(path);
      try { expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION); } finally { upgraded.close(); }
    } finally { first.close(); }
    const backup = new Database(`${path}.before-v${SCHEMA_VERSION}.bak`, { readonly: true });
    expect(backup.pragma("user_version", { simple: true })).toBe(1);
    expect(
      backup.prepare("SELECT value FROM app_setting WHERE key='backup'").get(),
    ).toEqual({ value: "present" });
    backup.close();
  });
  it.runIf(process.platform !== "win32")("升级备份不可写时不迁移，恢复权限后才能继续", async () => {
    const path = await temporary(), directory = dirname(path);
    const first = await CoreDatabase.open(path, migrations.slice(0, 1)); first.connection.prepare("INSERT INTO app_setting VALUES('preserved','before')").run(); first.close();
    try { await chmod(directory, 0o500); await expect(CoreDatabase.open(path)).rejects.toThrow(); }
    finally { await chmod(directory, 0o700); }
    const untouched = new Database(path);
    try {
      expect(untouched.pragma("user_version", { simple: true })).toBe(1);
      expect(untouched.prepare("SELECT value FROM app_setting WHERE key='preserved'").get()).toEqual({ value: "before" });
      expect(untouched.prepare("SELECT name FROM sqlite_master WHERE name='cloud_account'").get()).toBeUndefined();
    } finally { untouched.close(); }
    const retried = await CoreDatabase.open(path); try { expect(retried.schemaVersion).toBe(SCHEMA_VERSION); } finally { retried.close(); }
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
