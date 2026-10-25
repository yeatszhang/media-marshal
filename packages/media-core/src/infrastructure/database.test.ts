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
  it("v26 扫描迁移保留原来源、健康诊断与任务，旧核心拒绝新库且升级不产生扫描", async () => {
    const path = await temporary(), old = await CoreDatabase.open(path, migrations.slice(0, 25)), id = randomUUID(), task = randomUUID(), stamp = new Date().toISOString(), config = JSON.stringify({ type: "local", name: "迁移保留", client: "baidu", sourcePath: "/原输入", organization: { targetPath: "/原目标" } }), health = JSON.stringify({ sourceId: id, version: 2, lifecycleRevision: 0, checkedAt: stamp, input: { state: "UNAVAILABLE", reason: "PERMISSION_DENIED" }, target: { state: "AVAILABLE" } });
    old.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,paused,created_at) VALUES(?,'迁移保留','baidu','/原输入','/原目标','AUTO','COPY',1,?)").run(id, stamp);
    old.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,local_source_id,paused,created_at,updated_at) VALUES(?,'local',2,2,?,?,1,?,?)").run(id, config, id, stamp, stamp);
    old.connection.prepare("INSERT INTO source_rule_local_health VALUES(?,2,0,?,?)").run(id, stamp, health);
    old.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'DONE',?,?)").run(task, id, "/原输入/保留.mp4", stamp, stamp); old.close();
    const db = await CoreDatabase.open(path); try { expect(db.schemaVersion).toBe(26); expect(db.connection.prepare("SELECT draft_json,version,paused FROM source_rule").get()).toEqual({ draft_json: config, version: 2, paused: 1 }); expect(db.connection.prepare("SELECT snapshot_json FROM source_rule_local_health").get()).toEqual({ snapshot_json: health }); expect(db.connection.prepare("SELECT id,status FROM media_task").get()).toEqual({ id: task, status: "DONE" }); for (const table of ["ingestion_source_scan", "ingestion_source_scan_request", "ingestion_source_scan_issue"]) expect(db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 }); expect(db.connection.pragma("foreign_key_check")).toEqual([]); } finally { db.close(); }
    const backup = new Database(`${path}.before-v26.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(25); expect(backup.prepare("SELECT snapshot_json FROM source_rule_local_health").get()).toEqual({ snapshot_json: health }); } finally { backup.close(); }
    await expect(CoreDatabase.open(path, migrations.slice(0, 25))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("v26 迁移失败回滚全部扫描表，重试保留原 v25 备份与配置", async () => {
    const path = await temporary(), old = await CoreDatabase.open(path, migrations.slice(0, 25)); old.connection.prepare("INSERT INTO app_setting VALUES('原设置','保留')").run(); old.close();
    await expect(CoreDatabase.open(path, [...migrations.slice(0, 25), { ...migrations[25]!, sql: migrations[25]!.sql + "SELECT missing_scan_migration();" }])).rejects.toThrow();
    const original = await CoreDatabase.open(path, migrations.slice(0, 25)); expect(original.connection.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'ingestion_source_scan%'").all()).toEqual([]); original.close();
    const db = await CoreDatabase.open(path); expect(db.connection.prepare("SELECT value FROM app_setting WHERE key='原设置'").get()).toEqual({ value: "保留" }); db.close();
    const backup = new Database(`${path}.before-v26.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(25); expect(backup.prepare("SELECT value FROM app_setting WHERE key='原设置'").get()).toEqual({ value: "保留" }); } finally { backup.close(); }
  });
  it("v25 健康快照迁移保留本地来源、历史标签和任务，不扫描或启动文件操作，旧核心拒绝新库", async () => {
    const path = await temporary(), previous = await CoreDatabase.open(path, migrations.slice(0, 24)), id = randomUUID(), task = randomUUID(), stamp = new Date().toISOString();
    const configuration = JSON.stringify({ type: "local", name: "历史标签来源", client: "baidu", sourcePath: "/原输入", organization: { targetPath: "/原目标" } });
    previous.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,paused,health,created_at) VALUES(?,'历史标签来源','baidu','/原输入','/原目标','AUTO','COPY',1,'unavailable',?)").run(id, stamp);
    previous.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,local_source_id,paused,created_at,updated_at) VALUES(?,'local',3,2,?,?,1,?,?)").run(id, configuration, id, stamp, stamp);
    previous.connection.prepare("INSERT INTO source_rule_version(source_id,version,configuration_json,local_source_id,created_at) VALUES(?,3,?,?,?)").run(id, configuration, id, stamp);
    previous.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'AWAITING_CONFIRMATION',?,?)").run(task, id, "/原输入/保留.mp4", stamp, stamp); previous.close();
    const upgraded = await CoreDatabase.open(path, migrations.slice(0, 25));
    try { expect(upgraded.schemaVersion).toBe(25); expect(upgraded.connection.prepare("SELECT kind,paused,health FROM desktop_source WHERE id=?").get(id)).toEqual({ kind: "baidu", paused: 1, health: "unavailable" }); expect(upgraded.connection.prepare("SELECT version,draft_revision,draft_json FROM source_rule WHERE id=?").get(id)).toEqual({ version: 3, draft_revision: 2, draft_json: configuration }); expect(upgraded.connection.prepare("SELECT id,status FROM media_task").get()).toEqual({ id: task, status: "AWAITING_CONFIRMATION" }); for (const table of ["source_rule_local_health", "ingestion_operation", "download_job"]) expect(upgraded.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 }); expect(upgraded.connection.pragma("foreign_key_check")).toEqual([]); } finally { upgraded.close(); }
    const backup = new Database(`${path}.before-v25.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(24); expect(backup.prepare("SELECT kind,paused FROM desktop_source WHERE id=?").get(id)).toEqual({ kind: "baidu", paused: 1 }); } finally { backup.close(); }
    await expect(CoreDatabase.open(path, migrations.slice(0, 24))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("v25 迁移失败整体回滚，重试保留原 v24 备份和配置", async () => {
    const path = await temporary(), previous = await CoreDatabase.open(path, migrations.slice(0, 24)); previous.connection.prepare("INSERT INTO app_setting VALUES('原配置','保留')").run(); previous.close();
    await expect(CoreDatabase.open(path, [...migrations.slice(0, 24), { ...migrations[24]!, sql: migrations[24]!.sql + "SELECT missing_health_migration();" }])).rejects.toThrow();
    const original = await CoreDatabase.open(path, migrations.slice(0, 24)); try { expect(original.schemaVersion).toBe(24); expect(original.connection.prepare("SELECT name FROM sqlite_master WHERE name='source_rule_local_health'").get()).toBeUndefined(); } finally { original.close(); }
    const retry = await CoreDatabase.open(path, migrations.slice(0, 25)); try { expect(retry.schemaVersion).toBe(25); expect(retry.connection.prepare("SELECT value FROM app_setting WHERE key='原配置'").get()).toEqual({ value: "保留" }); } finally { retry.close(); }
    const backup = new Database(`${path}.before-v25.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(24); expect(backup.prepare("SELECT value FROM app_setting WHERE key='原配置'").get()).toEqual({ value: "保留" }); } finally { backup.close(); }
  });
  it("v24 升级保留修正配置与 v23 备份，批次迁移失败整体回滚且旧核心拒绝新库", async () => {
    const path = await temporary(), previous = await CoreDatabase.open(path, migrations.slice(0, 23)); previous.connection.prepare("INSERT INTO app_setting VALUES('批量配置','保留原状态')").run(); previous.close();
    await expect(CoreDatabase.open(path, [...migrations.slice(0, 23), { ...migrations[23]!, sql: migrations[23]!.sql + "SELECT missing_batch_migration();" }])).rejects.toThrow();
    const unchanged = new Database(path); try { expect(unchanged.pragma("user_version", { simple: true })).toBe(23); expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name='media_correction_batch'").get()).toBeUndefined(); } finally { unchanged.close(); }
    const upgraded = await CoreDatabase.open(path, migrations.slice(0, 24)); try { expect(upgraded.schemaVersion).toBe(24); expect(upgraded.connection.prepare("SELECT value FROM app_setting WHERE key='批量配置'").get()).toEqual({ value: "保留原状态" }); expect(upgraded.connection.prepare("SELECT count(*) AS n FROM media_correction_batch_member").get()).toEqual({ n: 0 }); expect(upgraded.connection.pragma("foreign_key_check")).toEqual([]); } finally { upgraded.close(); }
    const backup = new Database(`${path}.before-v24.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(23); } finally { backup.close(); }
    await expect(CoreDatabase.open(path, migrations.slice(0, 23))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("v23 保留 v22 修正与备份，新增长核验请求；失败时整体回滚后可重试", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 22)); first.connection.prepare("INSERT INTO app_setting VALUES('修正配置','原配置保留')").run(); first.close();
    await expect(CoreDatabase.open(path, [...migrations.slice(0, 22), { ...migrations[22]!, sql: migrations[22]!.sql + "SELECT missing_preparation_migration();" }])).rejects.toThrow();
    const unchanged = new Database(path); try { expect(unchanged.pragma("user_version", { simple: true })).toBe(22); expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name='media_correction_preparation'").get()).toBeUndefined(); } finally { unchanged.close(); }
    const upgraded = await CoreDatabase.open(path, migrations.slice(0, 23)); try { expect(upgraded.schemaVersion).toBe(23); expect(upgraded.connection.prepare("SELECT value FROM app_setting WHERE key='修正配置'").get()).toEqual({ value: "原配置保留" }); expect(upgraded.connection.prepare("SELECT count(*) AS n FROM media_correction_preparation").get()).toEqual({ n: 0 }); expect(upgraded.connection.pragma("foreign_key_check")).toEqual([]); } finally { upgraded.close(); }
    const backup = new Database(`${path}.before-v23.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(22); } finally { backup.close(); } await expect(CoreDatabase.open(path, migrations.slice(0, 22))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("v22 保留旧交付收据及备份，新增修正交付只允许一种来源，旧核心拒绝新库", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 21)), db = first.connection, source = randomUUID(), task = randomUUID(), candidate = randomUUID(), target = randomUUID(), operation = randomUUID(), stamp = new Date().toISOString();
    db.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'旧来源','custom','/原下载','/原目标','MOVIE','COPY',?)").run(source, stamp); db.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'DONE',?,?)").run(task, source, "/原下载/保留.mkv", stamp, stamp); db.prepare("INSERT INTO media_target_root(id,grant_json) VALUES(?,'{}')").run(target); db.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,snapshot_json,state,task_id,created_at,updated_at) VALUES(?,?,'[\"保留.mkv\"]','旧版本','{}','PROCESSED',?,?,?)").run(candidate, source, task, stamp, stamp); db.prepare("INSERT INTO ingestion_operation(id,candidate_id,task_id,request_key,target_root_id,target_slot,plan_json,attempt_id,phase,evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,'原位置','{}',?,'RECORDED','{}',?,?)").run(operation, candidate, task, randomUUID(), target, randomUUID(), stamp, stamp); db.prepare("INSERT INTO emby_delivery(task_id,operation_id,state,refresh_attempts,next_attempt_at,check_started_at,last_failure,updated_at) VALUES(?,?,'WAITING_LIBRARY',2,1234,1000,'FIXTURE_PENDING',?)").run(task, operation, stamp); const original = db.prepare("SELECT * FROM emby_delivery").get(); first.close();
    const upgraded = await CoreDatabase.open(path, migrations.slice(0, 22)); try { expect(upgraded.schemaVersion).toBe(22); expect(upgraded.connection.prepare("SELECT * FROM emby_delivery").get()).toEqual({ ...original as object, correction_id: null }); expect(upgraded.connection.pragma("foreign_key_check")).toEqual([]); const another = randomUUID(); upgraded.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'DONE',?,?)").run(another, source, "/原下载/另一个.mkv", stamp, stamp); expect(() => upgraded.connection.prepare("INSERT INTO emby_delivery(task_id,state,next_attempt_at,updated_at) VALUES(?,'REFRESH_PENDING',0,?)").run(another, stamp)).toThrow(/CHECK/); expect(upgraded.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get()).toEqual({ n: 0 }); } finally { upgraded.close(); }
    const backup = new Database(`${path}.before-v22.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(21); expect(backup.prepare("SELECT * FROM emby_delivery").get()).toEqual(original); } finally { backup.close(); } await expect(CoreDatabase.open(path, migrations.slice(0, 21))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("v22 交付表重建失败整体回退，重试不丢原交付表与升级备份", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 21)); first.connection.prepare("INSERT INTO app_setting VALUES('修正迁移前','保留')").run(); first.close(); await expect(CoreDatabase.open(path, [...migrations.slice(0, 21), { ...migrations[21]!, sql: migrations[21]!.sql + "SELECT missing_correction_migration();" }])).rejects.toThrow();
    const original = await CoreDatabase.open(path, migrations.slice(0, 21)); try { expect(original.schemaVersion).toBe(21); expect(original.connection.prepare("SELECT name FROM pragma_table_info('emby_delivery') WHERE name='correction_id'").get()).toBeUndefined(); expect(original.connection.prepare("SELECT name FROM sqlite_master WHERE name='media_correction_operation'").get()).toBeUndefined(); expect(original.connection.prepare("SELECT value FROM app_setting WHERE key='修正迁移前'").get()).toEqual({ value: "保留" }); } finally { original.close(); }
    const retry = await CoreDatabase.open(path, migrations.slice(0, 22)); try { expect(retry.schemaVersion).toBe(22); expect(retry.connection.pragma("foreign_key_check")).toEqual([]); } finally { retry.close(); }
  });
  it("v20 修正文件日志迁移保留已完成任务，不触发文件变更，并保留备份与旧版拒绝边界", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 20)), source = randomUUID(), task = randomUUID(), stamp = new Date().toISOString();
    first.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'历史来源','custom','/输入','/媒体目标','AUTO','COPY',?)").run(source, stamp);
    first.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,target_path,created_at,updated_at) VALUES(?,?,?,'DONE',?,?,?)").run(task, source, "/输入/保留.mp4", "/媒体目标/保留.mp4", stamp, stamp); first.close();
    const upgraded = await CoreDatabase.open(path, migrations.slice(0, 21)); try { expect(upgraded.schemaVersion).toBe(21); expect(upgraded.connection.prepare("SELECT id,status,target_path FROM media_task").get()).toEqual({ id: task, status: "DONE", target_path: "/媒体目标/保留.mp4" }); expect(upgraded.connection.prepare("SELECT count(*) AS n FROM media_file_relocation").get()).toEqual({ n: 0 }); expect(upgraded.connection.pragma("foreign_key_check")).toEqual([]); } finally { upgraded.close(); }
    const backup = new Database(`${path}.before-v21.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(20); expect(backup.prepare("SELECT status FROM media_task WHERE id=?").get(task)).toEqual({ status: "DONE" }); } finally { backup.close(); }
    await expect(CoreDatabase.open(path, migrations.slice(0, 20))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("v21 日志迁移失败回滚表与版本，重试保留原 v20 备份和配置", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 20)); first.connection.prepare("INSERT INTO app_setting VALUES('迁移前配置','保留')").run(); first.close();
    await expect(CoreDatabase.open(path, [...migrations.slice(0, 20), { ...migrations[20]!, sql: migrations[20]!.sql + "SELECT missing_relocation_migration();" }])).rejects.toThrow();
    const original = await CoreDatabase.open(path, migrations.slice(0, 20)); try { expect(original.schemaVersion).toBe(20); expect(original.connection.prepare("SELECT name FROM sqlite_master WHERE name='media_file_relocation'").get()).toBeUndefined(); expect(original.connection.prepare("SELECT value FROM app_setting WHERE key='迁移前配置'").get()).toEqual({ value: "保留" }); } finally { original.close(); }
    const retry = await CoreDatabase.open(path, migrations.slice(0, 21)); try { expect(retry.schemaVersion).toBe(21); expect(retry.connection.prepare("SELECT count(*) AS n FROM media_file_relocation").get()).toEqual({ n: 0 }); } finally { retry.close(); }
    const backup = new Database(`${path}.before-v21.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(20); expect(backup.prepare("SELECT value FROM app_setting WHERE key='迁移前配置'").get()).toEqual({ value: "保留" }); } finally { backup.close(); }
  });
  it("v19 批量整理迁移保留旧配置和待确认任务，不自动创建预览或操作，旧核心拒绝新库", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 19)), source = randomUUID(), task = randomUUID(), stamp = new Date().toISOString();
    first.connection.prepare("INSERT INTO app_setting VALUES('保留批次配置','原值')").run();
    first.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'保留来源','custom','/输入','/目标','AUTO','COPY',?)").run(source, stamp);
    first.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'AWAITING_CONFIRMATION',?,?)").run(task, source, "/输入/原文件.mp4", stamp, stamp); first.close();
    const upgraded = await CoreDatabase.open(path, migrations.slice(0, 20)); try { expect(upgraded.schemaVersion).toBe(20); expect(upgraded.connection.prepare("SELECT value FROM app_setting WHERE key='保留批次配置'").get()).toEqual({ value: "原值" }); expect(upgraded.connection.prepare("SELECT id,status FROM media_task").get()).toEqual({ id: task, status: "AWAITING_CONFIRMATION" }); for (const table of ["ingestion_organize_batch", "ingestion_organize_batch_item", "ingestion_operation"]) expect(upgraded.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 }); } finally { upgraded.close(); }
    const backup = new Database(`${path}.before-v20.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(19); } finally { backup.close(); }
    await expect(CoreDatabase.open(path, migrations.slice(0, 19))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("v18 批量识别迁移不启动任务或改写旧识别字段，旧核心拒绝新库", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 18)); first.connection.prepare("INSERT INTO app_setting VALUES('测试保留配置','原值')").run(); first.close(); const upgraded = await CoreDatabase.open(path, migrations.slice(0, 19));
    try { expect(upgraded.schemaVersion).toBe(19); expect(upgraded.connection.prepare("SELECT value FROM app_setting WHERE key='测试保留配置'").get()).toEqual({ value: "原值" }); expect(upgraded.connection.prepare("SELECT count(*) AS n FROM ingestion_recognition_batch").get()).toEqual({ n: 0 }); expect(upgraded.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 }); } finally { upgraded.close(); }
    const backup = new Database(`${path}.before-v19.bak`, { readonly: true }); try { expect(backup.pragma("user_version", { simple: true })).toBe(18); } finally { backup.close(); } await expect(CoreDatabase.open(path, migrations.slice(0, 18))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("v17 识别编辑迁移不重写已有字段或排队任务，保留备份并阻止旧核心写新库", async () => {
    const path = await temporary(), first = await CoreDatabase.open(path, migrations.slice(0, 17)), source = randomUUID(), task = randomUUID(), stamp = new Date().toISOString(), parsed = '{"title":"原作品","year":2026}';
    first.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'保留来源','custom','/输入','/媒体库','AUTO','COPY',?)").run(source, stamp);
    first.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,parsed_json,created_at,updated_at) VALUES(?,?,?,'AWAITING_CONFIRMATION',?,?,?)").run(task, source, "/输入/原文件.mp4", parsed, stamp, stamp); first.close();
    const upgraded = await CoreDatabase.open(path, migrations.slice(0, 18)); try { expect(upgraded.schemaVersion).toBe(18); expect(upgraded.connection.prepare("SELECT id,status,parsed_json FROM media_task").get()).toEqual({ id: task, status: "AWAITING_CONFIRMATION", parsed_json: parsed }); expect(upgraded.connection.prepare("SELECT count(*) AS n FROM ingestion_recognition_edit").get()).toEqual({ n: 0 }); expect(upgraded.connection.prepare("SELECT count(*) AS n FROM ingestion_recognition_command").get()).toEqual({ n: 0 }); } finally { upgraded.close(); }
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
