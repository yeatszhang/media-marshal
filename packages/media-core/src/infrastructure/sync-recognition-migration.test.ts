import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recognitionRuleSnapshotSchema, syncSourceSnapshotSchema, sourceConfigurationSchema, type SourceConfiguration } from "@media-marshal/contracts";
import { type ManagedRootGrant } from "@media-marshal/contracts/internal";
import { CoreDatabase, migrations, type Migration } from "./database.js";
import { migrateSyncRecognition, syncRecognitionMigrationSql } from "./sync-recognition-migration.js";
import { legacySyncFilters } from "../sources/legacy-sync-filters.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const migration: Migration = { version: 28, sql: syncRecognitionMigrationSql, apply: migrateSyncRecognition };
const oldPlan = migrations.slice(0, 27), plan = [...oldPlan, migration];
const stamp = "2026-10-26T15:00:00.000Z";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "marshal-职责拆分迁移-"))); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, "desktop.sqlite3"), db = await CoreDatabase.open(path, oldPlan); cleanup.push(() => db.close());
  async function directory(name: string): Promise<ManagedRootGrant> {
    const path = join(folder, name); await mkdir(path); const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true });
    return { id: randomUUID(), path, volume: { volumeId: randomUUID(), rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "isolated-test", caseSensitive: false, unicodeEquivalent: true, pathMaxBytes: 4096 } };
  }
  const input = await directory("原本地输入"), media = await directory("原电影库"), secondMedia = await directory("另一媒体库"), root = await directory("原下载目录"), secondRoot = await directory("另一下载目录");
  const sql = db.connection, account = randomUUID(), remote = randomUUID(), file = randomUUID();
  for (const target of [media, secondMedia]) sql.prepare("INSERT INTO media_target_root VALUES(?,?,0)").run(target.id, JSON.stringify(target));
  for (const target of [root, secondRoot]) sql.prepare("INSERT INTO managed_download_root VALUES(?,?,?,?,'UNAVAILABLE',?)").run(target.id, target.id, target.path, JSON.stringify(target.volume), stamp);
  sql.prepare("INSERT INTO cloud_account(id,name,provider_kind,status,created_at,updated_at) VALUES(?,'测试账号','quark','AUTH_REQUIRED',?,?)").run(account, stamp, stamp);
  sql.prepare("INSERT INTO remote_entry(id,account_id,name,type,observed_at) VALUES(?,?,'测试范围','directory',?)").run(remote, account, stamp);
  sql.prepare("INSERT INTO remote_entry(id,account_id,parent_ref,name,type,size,observed_at) VALUES(?,?,?,'片段.mkv','file',7,?)").run(file, account, remote, stamp);
  function source(value: unknown, options: { id?: string; paused?: boolean; target?: string; input?: ManagedRootGrant; version?: number } = {}) {
    const config = sourceConfigurationSchema.parse(value), id = options.id ?? randomUUID(), version = options.version ?? 2;
    if (config.type === "local") {
      sql.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,version,paused,created_at) VALUES(?,?,?,?,?,?,'COPY',?,?,?)").run(id, config.name, config.client, config.sourcePath, config.organization.targetPath, config.organization.mediaType, version || 1, Number(options.paused ?? false), stamp);
      if (options.input) sql.prepare("INSERT INTO ingestion_source VALUES(?,'local',NULL,?,?,?,0)").run(id, JSON.stringify(options.input), options.target ?? media.id, version || 1);
    }
    sql.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,paused,local_source_id,lifecycle_revision,created_at,updated_at) VALUES(?,?,?,3,?,?,?,?,?,?)").run(id, config.type, version, JSON.stringify(config), Number(options.paused ?? false), config.type === "local" ? id : null, 4, stamp, stamp);
    if (version) sql.prepare("INSERT INTO source_rule_version(source_id,version,configuration_json,local_source_id,target_root_id,created_at) VALUES(?,?,?,?,?,?)").run(id, version, JSON.stringify(config), config.type === "local" ? id : null, options.target ?? (config.organization ? media.id : null), stamp);
    return { id, config };
  }
  const local = (patch = {}) => ({ type: "local", name: "保留本地直整", client: "baidu", sourcePath: input.path, organization: { targetPath: media.path, mediaType: "MOVIE", automatic: true }, ...patch });
  const cloud = (patch = {}) => ({ type: "cloud", name: "网盘来源", accountId: account, remoteRef: remote, downloadRootId: root.id, filters: { extensions: ["mkv"], names: [] }, organization: { targetPath: media.path }, ...patch });
  function item(state = "COMPLETED") {
    const id = randomUUID(); sql.prepare("INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,target_root_id,target_path_key,target_segments_json,expected_size,state,local_sha256,completed_size,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'[\"片段.mkv\"]',7,?,?,?,?,?)").run(id, account, file, digest("weak-source-version"), '{"kind":"weak","size":7,"modifiedAt":null}', root.id, digest(id), state, state === "COMPLETED" ? digest("payload") : null, state === "COMPLETED" ? 7 : null, stamp, stamp); return id;
  }
  const oldTables = ["source_rule", "source_rule_version", "desktop_source", "ingestion_source", "media_target_root", "managed_download_root", "media_task", "ingestion_candidate", "ingestion_operation", "download_item", "download_job", "download_attempt", "ingestion_automatic"];
  const snapshot = () => Object.fromEntries(oldTables.map((table) => [table, sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  async function upgrade(customPlan = plan) { db.close(); const current = await CoreDatabase.open(path, customPlan); cleanup.push(() => current.close()); return current; }
  return { folder, path, db, input, media, secondMedia, root, secondRoot, account, remote, file, source, local, cloud, item, snapshot, upgrade };
}

describe("同步／识别配置与成功收据的追加迁移", () => {
  it("本地直整保留 ID、原路径和暂停并迁为直接识别，不插入本地同步或扩大自动授权", async () => {
    const f = await fixture(), local = f.source(f.local(), { paused: true, input: f.input, target: f.media.id });
    const original = join(f.input.path, "保留原片.mkv"); await writeFile(original, "original"); const inode = (await lstat(original)).ino;
    const task = randomUUID(), candidate = randomUUID(), operation = randomUUID();
    f.db.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'PROCESSING',?,?)").run(task, local.id, original, stamp, stamp);
    f.db.connection.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,snapshot_json,state,task_id,created_at,updated_at) VALUES(?,?,'[\"保留原片.mkv\"]','旧资产版本','{}','QUEUED',?,?,?)").run(candidate, local.id, task, stamp, stamp);
    f.db.connection.prepare("INSERT INTO ingestion_operation(id,candidate_id,task_id,request_key,target_root_id,target_slot,plan_json,attempt_id,phase,created_at,updated_at) VALUES(?,?,?,?,?,'保留原位置','{\"frozenOriginalPlan\":true}',?,'PLANNED',?,?)").run(operation, candidate, task, randomUUID(), f.media.id, randomUUID(), stamp, stamp);
    const before = f.snapshot(), db = await f.upgrade();
    expect(db.schemaVersion).toBe(28);
    for (const [table, rows] of Object.entries(before)) expect(db.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(rows);
    expect(db.connection.prepare("SELECT count(*) AS n FROM sync_source_rule").get()).toEqual({ n: 0 });
    const row = db.connection.prepare("SELECT * FROM recognition_rule WHERE id=?").get(local.id) as { version: number; paused: number; draft_json: string; review_json: string; lifecycle_revision: number };
    expect(row).toMatchObject({ version: 2, paused: 1, lifecycle_revision: 4 }); expect(JSON.parse(row.draft_json)).toMatchObject({ automatic: false, input: { directoryId: f.input.id }, targets: [{ mediaType: "MOVIE", directoryId: f.media.id }] });
    expect(JSON.parse(row.review_json)).toContain("AUTOMATIC_REAUTHORIZATION_REQUIRED");
    const frozen = db.connection.prepare("SELECT snapshot_json FROM recognition_rule_version WHERE rule_id=?").get(local.id) as { snapshot_json: string };
    expect(recognitionRuleSnapshotSchema.parse(JSON.parse(frozen.snapshot_json))).toMatchObject({ inputMode: "ordinary", inputDirectory: { path: f.input.path }, targets: [{ directory: { path: f.media.path }, embyBinding: null }] });
    const legacy = db.connection.prepare("SELECT configuration_json FROM recognition_rule_legacy_reference WHERE source_id=?").get(local.id) as { configuration_json: string };
    expect(JSON.parse(legacy.configuration_json).configuration.client).toBe("baidu");
    expect(await readFile(original, "utf8")).toBe("original"); expect((await lstat(original)).ino).toBe(inode);
    expect(db.connection.prepare("SELECT plan_json,phase FROM ingestion_operation WHERE id=?").get(operation)).toEqual({ plan_json: '{"frozenOriginalPlan":true}', phase: "PLANNED" });
  });

  it("网盘整理按相同输入及完整策略合并，保留多根绑定并等待选择默认目录", async () => {
    const f = await fixture(), first = f.source(f.cloud()), second = f.source(f.cloud()), third = f.source(f.cloud({ downloadRootId: f.secondRoot.id, organization: null }));
    const db = await f.upgrade();
    expect(db.connection.prepare("SELECT count(*) AS n FROM recognition_rule").get()).toEqual({ n: 1 });
    const refs = db.connection.prepare("SELECT source_id,rule_id FROM recognition_rule_legacy_reference ORDER BY source_id").all() as { source_id: string; rule_id: string }[];
    expect(refs.map((row) => row.source_id).sort()).toEqual([first.id, second.id].sort()); expect(new Set(refs.map((row) => row.rule_id)).size).toBe(1);
    for (const source of [first, second, third]) {
      const row = db.connection.prepare("SELECT snapshot_json FROM sync_source_version WHERE source_id=?").get(source.id) as { snapshot_json: string };
      const snapshot = syncSourceSnapshotSchema.parse(JSON.parse(row.snapshot_json)); expect(snapshot.targetDirectory.id).toBe(source.config.type === "cloud" ? source.config.downloadRootId : ""); expect(snapshot.configuration).not.toHaveProperty("organization");
    }
    expect(db.connection.prepare("SELECT version,directory_id FROM default_download_directory").get()).toEqual({ version: 0, directory_id: null });
  });

  it("共享输入的不同目标或暂停策略不互相覆盖，冲突全部暂停待核对", async () => {
    const f = await fixture(), a = f.source(f.cloud()), b = f.source(f.cloud({ organization: { targetPath: f.secondMedia.path } }), { target: f.secondMedia.id }), c = f.source(f.cloud(), { paused: true });
    const db = await f.upgrade(); const rows = db.connection.prepare("SELECT id,paused,review_json FROM recognition_rule ORDER BY id").all() as { id: string; paused: number; review_json: string }[];
    expect(rows.map((row) => row.id).sort()).toEqual([a.id, b.id, c.id].sort());
    for (const row of rows) { expect(row.paused).toBe(1); expect(JSON.parse(row.review_json)).toContain("LEGACY_POLICY_CONFLICT"); }
    expect(db.connection.prepare("SELECT source_id FROM recognition_rule_legacy_reference").all()).toHaveLength(3);
  });

  it("成功副本已删除仍回填收据，未完成记录不产生成功事实，重开幂等且不能修改收据", async () => {
    const f = await fixture(), completed = f.item(), pending = f.item("PAUSED"); await mkdir(join(f.root.path, "completed"));
    const path = join(f.root.path, "completed/片段.mkv"); await writeFile(path, "payload"); await rm(path);
    const db = await f.upgrade(); expect(db.connection.prepare("SELECT result_id,size,local_sha256 FROM sync_receipt").all()).toEqual([{ result_id: completed, size: 7, local_sha256: digest("payload") }]);
    expect(db.connection.prepare("SELECT * FROM sync_receipt WHERE result_id=?").get(pending)).toBeUndefined(); expect(await readdir(join(f.root.path, "completed"))).toEqual([]);
    expect(() => db.connection.prepare("UPDATE sync_receipt SET size=0").run()).toThrow(/不可修改/);
    db.close(); const reopened = await CoreDatabase.open(f.path, plan); cleanup.push(() => reopened.close()); expect(reopened.connection.prepare("SELECT count(*) AS n FROM sync_receipt").get()).toEqual({ n: 1 });
  });

  it("未知目录授权和不可表示的旧名称保留原文待核对，不能以空过滤启用", async () => {
    const f = await fixture(), local = f.source(f.local(), { target: f.media.id }), cloud = f.source(f.cloud({ filters: { extensions: [], names: ["含\n换行.mkv"] } }));
    const db = await f.upgrade();
    expect(JSON.parse((db.connection.prepare("SELECT review_json FROM recognition_rule WHERE id=?").get(local.id) as { review_json: string }).review_json)).toContain("LEGACY_AUTHORIZATION_MISSING");
    expect(db.connection.prepare("SELECT snapshot_json FROM sync_source_version WHERE source_id=?").get(cloud.id)).toBeUndefined();
    const row = db.connection.prepare("SELECT review_json,legacy_configuration_json FROM sync_source_rule WHERE id=?").get(cloud.id) as { review_json: string; legacy_configuration_json: string };
    expect(JSON.parse(row.review_json)).toContain("LEGACY_SCOPE_REVIEW_REQUIRED"); expect(JSON.parse(row.legacy_configuration_json).configuration.filters.names).toEqual(["含\n换行.mkv"]);
  });

  it("迁移中断整体回滚，重试保留最初一致性备份，旧核心拒绝新库", async () => {
    const f = await fixture(); f.source(f.local(), { input: f.input }); f.item(); const before = f.snapshot();
    const failed = [...oldPlan, { ...migration, apply(db: Database.Database) { migrateSyncRecognition(db); throw new Error("注入迁移中断"); } }];
    await expect(f.upgrade(failed)).rejects.toThrow("注入迁移中断");
    const backupPath = `${f.path}.before-v28.bak`, backupHash = digest(await readFile(backupPath));
    const old = await CoreDatabase.open(f.path, oldPlan); expect(old.schemaVersion).toBe(27); for (const [table, rows] of Object.entries(before)) expect(old.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(rows);
    expect(old.connection.prepare("SELECT name FROM sqlite_master WHERE name IN ('sync_source_rule','recognition_rule','sync_receipt')").all()).toEqual([]); old.close();
    const db = await CoreDatabase.open(f.path, plan); cleanup.push(() => db.close()); expect(db.connection.pragma("foreign_key_check")).toEqual([]); expect(digest(await readFile(backupPath))).toBe(backupHash);
    db.close(); await expect(CoreDatabase.open(f.path, oldPlan)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    const backup = new Database(backupPath, { readonly: true }); expect(backup.pragma("user_version", { simple: true })).toBe(27); backup.close();
  });

  it("缺失有效版本证据时保留草稿和原版本号，不把草稿伪造为已确认快照", async () => {
    const f = await fixture(), source = f.source(f.cloud());
    f.db.connection.prepare("DELETE FROM source_rule_version WHERE source_id=?").run(source.id);
    const db = await f.upgrade();
    expect(db.connection.prepare("SELECT version FROM sync_source_rule WHERE id=?").get(source.id)).toEqual({ version: 2 });
    expect(db.connection.prepare("SELECT * FROM sync_source_version WHERE source_id=?").get(source.id)).toBeUndefined();
    expect(db.connection.prepare("SELECT * FROM recognition_rule_version WHERE rule_id=?").get(source.id)).toBeUndefined();
    const row = db.connection.prepare("SELECT review_json,legacy_configuration_json FROM sync_source_rule WHERE id=?").get(source.id) as { review_json: string; legacy_configuration_json: string };
    expect(JSON.parse(row.review_json)).toContain("LEGACY_SCOPE_REVIEW_REQUIRED"); expect(JSON.parse(row.legacy_configuration_json).draft).toEqual(source.config);
  });
});

describe("旧筛选条件的同范围投影", () => {
  it("扩展名与精确名称取交集，保留各自大小写语义和 glob 字面量", () => {
    expect(legacySyncFilters({ extensions: ["MKV"], names: ["甲[1]?.MKV", "排除.mp4"] })).toEqual([{ action: "include", pattern: "甲\\[1\\]\\?.MKV", caseSensitive: true }, { action: "exclude", pattern: "**", caseSensitive: true }]);
    expect(legacySyncFilters({ extensions: ["MKV"] })).toEqual([{ action: "include", pattern: "*.mkv", caseSensitive: false }, { action: "exclude", pattern: "**", caseSensitive: true }]);
    expect(legacySyncFilters({ extensions: ["mkv"], names: ["排除.mp4"] })).toEqual([{ action: "exclude", pattern: "**", caseSensitive: true }]);
    expect(legacySyncFilters({})).toEqual([]);
  });
});
