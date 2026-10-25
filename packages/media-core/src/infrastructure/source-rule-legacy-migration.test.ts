import { afterEach, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CoreDatabase, migrations, SCHEMA_VERSION } from "./database";
import { sourceConfigurationSchema } from "@media-marshal/contracts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const stamp = "2026-10-20T01:00:00.000Z";
const oldTables = ["desktop_source", "ingestion_source", "media_task", "ingestion_candidate", "ingestion_operation", "cloud_account", "cloud_subscription", "cloud_subscription_runtime", "cloud_scan", "download_job", "download_job_item", "download_item", "managed_download_root", "media_target_root"];
const snapshot = (db: CoreDatabase) => Object.fromEntries(oldTables.map((table) => [table, db.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
async function oldFixture(options: { unconfirmed?: boolean; shared?: boolean; orphan?: boolean; oldJobVersion?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "marshal-来源迁移-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "desktop.sqlite3"), db = await CoreDatabase.open(path, migrations.slice(0, 8));
  cleanup.push(() => db.close()); const sql = db.connection;
  const ids = { local: randomUUID(), managed: randomUUID(), sourceGrant: randomUUID(), localTarget: randomUUID(), managedTarget: randomUUID(), root: randomUUID(), onceRoot: randomUUID(), account: randomUUID(), binding: randomUUID(), generation: randomUUID(), remote: randomUUID(), file: randomUUID(), subscription: randomUUID(), secondSubscription: randomUUID(), task: randomUUID(), candidate: randomUUID(), operation: randomUUID(), item: randomUUID(), onceItem: randomUUID() };
  const volume = { volumeId: randomUUID(), rootInode: "1", rootBirthtimeNs: "1", observedDevice: "1", fsTypeCode: "1", fsType: "fixture", caseSensitive: true, unicodeEquivalent: true, pathMaxBytes: 4096 };
  const grant = (id: string, path: string) => JSON.stringify({ id, path, volume });
  sql.prepare("INSERT INTO media_target_root VALUES(?,?,0)").run(ids.localTarget, grant(ids.localTarget, "/legacy/电影库"));
  sql.prepare("INSERT INTO media_target_root VALUES(?,?,0)").run(ids.managedTarget, grant(ids.managedTarget, "/legacy/下载整理目标"));
  sql.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,version,paused,health,created_at) VALUES(?,'原夸克本地来源','quark','/legacy/客户端输入','/legacy/电影库','MOVIE','COPY',4,1,'unavailable',?)").run(ids.local, stamp);
  sql.prepare("INSERT INTO ingestion_source VALUES(?,'local',NULL,?,?,4,0)").run(ids.local, grant(ids.sourceGrant, "/legacy/客户端输入"), ids.localTarget);
  for (const [id, path] of [[ids.root, "/legacy/受管下载"], [ids.onceRoot, "/legacy/一次下载"]]) sql.prepare("INSERT INTO managed_download_root VALUES(?,?,?,?,'UNAVAILABLE',?)").run(id, id, path, JSON.stringify(volume), stamp);
  sql.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,version,paused,created_at) VALUES(?,'原受管整理','custom','/legacy/受管下载/completed','/legacy/下载整理目标','AUTO','COPY',3,0,?)").run(ids.managed, stamp);
  sql.prepare("INSERT INTO ingestion_source VALUES(?,'managed',?,?,?,3,0)").run(ids.managed, ids.root, grant(ids.root, "/legacy/受管下载"), ids.managedTarget);
  sql.prepare("INSERT INTO media_task(id,source_id,source_path,status,target_path,created_at,updated_at) VALUES(?,?,'/legacy/客户端输入/原片.mkv','DONE','/legacy/电影库/原片.mkv',?,?)").run(ids.task, ids.local, stamp, stamp);
  sql.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,snapshot_json,state,task_id,created_at,updated_at) VALUES(?,?,'[\"原片.mkv\"]','legacy-file-version','{}','PROCESSED',?,?,?)").run(ids.candidate, ids.local, ids.task, stamp, stamp);
  sql.prepare("INSERT INTO ingestion_operation(id,candidate_id,task_id,request_key,target_root_id,target_slot,plan_json,attempt_id,phase,created_at,updated_at) VALUES(?,?,?,?,?,'legacy-slot','{\"immutableOriginalPlan\":true}',?,'RECORDED',?,?)").run(ids.operation, ids.candidate, ids.task, randomUUID(), ids.localTarget, randomUUID(), stamp, stamp);
  sql.prepare("INSERT INTO cloud_account(id,name,provider_kind,status,credential_ref,created_at,updated_at) VALUES(?,'原账号','quark','AUTH_REQUIRED',?,?,?)").run(ids.account, randomUUID(), stamp, stamp);
  sql.prepare("INSERT INTO provider_binding(id,account_id,implementation_id,configuration_version,generation,state,created_at) VALUES(?,?,'test.drive',1,?,'ACTIVE',?)").run(ids.binding, ids.account, ids.generation, stamp);
  const remoteName = "中文目录😀".repeat(35);
  sql.prepare("INSERT INTO remote_entry(id,account_id,name,type,observed_at) VALUES(?,?,?,'directory',?)").run(ids.remote, ids.account, remoteName, stamp);
  sql.prepare("INSERT INTO remote_entry(id,account_id,parent_ref,name,type,size,observed_at) VALUES(?,?,?,'文件.mkv','file',10,?)").run(ids.file, ids.account, ids.remote, stamp);
  function preview(rootId = ids.root, filters = { extensions: ["mkv"], names: [] as string[] }) {
    const id = randomUUID(); sql.prepare("INSERT INTO cloud_preview(id,account_id,remote_root_ref,target_root_id,request_key,snapshot_json,state,configuration_version,created_at,expires_at) VALUES(?,?,?,?,?,?,'CONFIRMED',5,?,?)")
      .run(id, ids.account, ids.remote, rootId, randomUUID(), JSON.stringify({ layout: "drive", complete: true, filters, items: [], name: remoteName }), stamp, "2026-10-20T01:15:00.000Z"); return id;
  }
  function subscription(id: string, enabled: number, version: number) {
    sql.prepare("INSERT INTO cloud_subscription(id,account_id,remote_root_ref,target_root_id,filters_json,interval_seconds,enabled,configuration_version,confirmed_preview_id,last_scan_at,next_scan_at,created_at,updated_at) VALUES(?,?,?,?,?,900,?,?,?,?,?,?,?)")
      .run(id, ids.account, ids.remote, ids.root, '{"extensions":["mkv"],"names":[]}', enabled, version, options.unconfirmed ? null : preview(), stamp, enabled ? "2026-10-20T01:15:00.000Z" : null, stamp, stamp);
    sql.prepare("INSERT INTO cloud_subscription_runtime(subscription_id,state,last_files,last_bytes,last_reused,last_complete) VALUES(?,?,2,20,1,1)").run(id, enabled ? "IDLE" : "PAUSED");
  }
  if (!options.orphan) {
    subscription(ids.subscription, 0, 5); if (options.shared) subscription(ids.secondSubscription, 1, 5);
    sql.prepare("INSERT INTO cloud_scan(id,subscription_id,account_id,remote_root_ref,generation,configuration_version,state,started_at,completed_at) VALUES(?,?,?,?,?,5,'COMPLETE',?,?)").run(randomUUID(), ids.subscription, ids.account, ids.remote, randomUUID(), stamp, stamp);
  }
  for (const [id, root] of [[ids.item, ids.root], [ids.onceItem, ids.onceRoot]]) sql.prepare("INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,target_root_id,target_path_key,target_segments_json,expected_size,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'legacy-slot','[\"文件.mkv\"]',10,'PAUSED',?,?)")
    .run(id, ids.account, ids.file, "a".repeat(64), '{"kind":"weak","size":10,"modifiedAt":null}', root, stamp, stamp);
  const jobIds: string[] = [];
  function job(subscriptionId: string | null, itemId: string, rootId: string, version = 5) {
    const id = randomUUID(); jobIds.push(id);
    sql.prepare("INSERT INTO download_job(id,account_id,subscription_id,preview_id,request_key,state,configuration_version,created_at,updated_at) VALUES(?,?,?,?,?,'PAUSED',?,?,?)").run(id, ids.account, subscriptionId, preview(rootId), randomUUID(), version, stamp, stamp);
    sql.prepare("INSERT INTO download_job_item VALUES(?,?,?,'ACTIVE')").run(id, itemId, ids.account); return id;
  }
  if (!options.orphan && !options.unconfirmed) { job(ids.subscription, ids.item, ids.root); job(options.shared ? ids.secondSubscription : ids.subscription, ids.item, ids.root, options.oldJobVersion ? 4 : 5); }
  const once = job(null, ids.onceItem, ids.onceRoot, 1);
  const before = snapshot(db); db.close(); return { directory, path, ids, before, jobIds, once, remoteName };
}
async function upgraded(path: string) { const db = await CoreDatabase.open(path); cleanup.push(() => db.close()); return db; }

describe("旧来源、订阅和共享需求的有序迁移", () => {
  it("保留稳定 ID、路径、暂停、过滤、周期和全部旧表；迁移不创建扫描或作业", async () => {
    const f = await oldFixture(), db = await upgraded(f.path);
    expect(snapshot(db)).toEqual(f.before);
    const rows = db.connection.prepare("SELECT * FROM source_rule ORDER BY type").all() as { id: string; type: string; version: number; paused: number; draft_json: string; subscription_id: string | null; local_source_id: string | null; ingestion_source_id: string | null }[];
    expect(rows).toHaveLength(2); expect(rows.find((row) => row.type === "local")).toMatchObject({ id: f.ids.local, version: 4, paused: 1, local_source_id: f.ids.local });
    const cloud = rows.find((row) => row.type === "cloud")!;
    expect(cloud).toMatchObject({ id: f.ids.subscription, version: 5, paused: 1, subscription_id: f.ids.subscription, ingestion_source_id: f.ids.managed });
    expect(sourceConfigurationSchema.parse(JSON.parse(cloud.draft_json))).toMatchObject({ type: "cloud", accountId: f.ids.account, remoteRef: f.ids.remote, downloadRootId: f.ids.root, filters: { extensions: ["mkv"], names: [] }, periodic: { enabled: true, intervalSeconds: 900 }, organization: { targetPath: "/legacy/下载整理目标" } });
    expect(db.connection.prepare("SELECT name FROM remote_entry WHERE id=?").get(f.ids.remote)).toEqual({ name: f.remoteName });
    expect(db.connection.prepare("SELECT * FROM source_rule_legacy_reference WHERE kind='managed-binding'").get()).toMatchObject({ legacy_id: f.ids.managed, source_id: f.ids.subscription, status: "MAPPED" });
    const demands = db.connection.prepare("SELECT * FROM download_source_demand ORDER BY job_id").all(); expect(demands).toHaveLength(2);
    expect(demands).toEqual(expect.arrayContaining(f.jobIds.filter((id) => id !== f.once).map((id) => ({ job_id: id, source_id: f.ids.subscription, source_version: 5, review_required: 1 }))));
    expect(db.connection.prepare("SELECT * FROM source_rule_legacy_reference WHERE kind='download-job' AND legacy_id=?").get(f.once)).toMatchObject({ source_id: null, status: "HISTORICAL", reason: "NO_SOURCE" });
    db.close(); const reopened = await upgraded(f.path); expect(reopened.connection.prepare("SELECT count(*) AS n FROM source_rule").get()).toEqual({ n: 2 }); expect(snapshot(reopened)).toEqual(f.before);
  });
  it("共享根和条目的多个订阅不被合并，整理归属不明则待核对", async () => {
    const f = await oldFixture({ shared: true }), db = await upgraded(f.path);
    expect(snapshot(db)).toEqual(f.before);
    const rules = db.connection.prepare("SELECT id,draft_json,paused,review_required,ingestion_source_id FROM source_rule WHERE type='cloud' ORDER BY id").all() as { id: string; draft_json: string; paused: number; review_required: number; ingestion_source_id: null }[];
    expect(rules.map((row) => row.id).sort()).toEqual([f.ids.subscription, f.ids.secondSubscription].sort());
    for (const rule of rules) { expect(rule).toMatchObject({ review_required: 1, ingestion_source_id: null }); expect(JSON.parse(rule.draft_json).organization).toBeNull(); }
    expect(rules.find((row) => row.id === f.ids.secondSubscription)?.paused).toBe(0);
    expect(db.connection.prepare("SELECT status,source_id FROM source_rule_legacy_reference WHERE kind='managed-binding'").get()).toEqual({ status: "REVIEW_REQUIRED", source_id: null });
    expect(db.connection.prepare("SELECT count(*) AS n FROM download_job_item WHERE item_id=?").get(f.ids.item)).toEqual({ n: 2 });
    expect(db.connection.prepare("SELECT count(DISTINCT source_id) AS n FROM download_source_demand").get()).toEqual({ n: 2 });
  });
  it("未确认订阅仍为草稿，未知整理绑定和一次性历史不生成自动来源", async () => {
    const draft = await oldFixture({ unconfirmed: true }), first = await upgraded(draft.path);
    expect(snapshot(first)).toEqual(draft.before);
    expect(first.connection.prepare("SELECT version,paused,review_required,subscription_id FROM source_rule WHERE id=?").get(draft.ids.subscription)).toEqual({ version: 0, paused: 1, review_required: 1, subscription_id: null });
    const orphan = await oldFixture({ orphan: true }), second = await upgraded(orphan.path);
    expect(snapshot(second)).toEqual(orphan.before);
    expect(second.connection.prepare("SELECT count(*) AS n FROM source_rule WHERE type='cloud'").get()).toEqual({ n: 0 });
    expect(second.connection.prepare("SELECT status,reason FROM source_rule_legacy_reference WHERE kind='managed-binding'").get()).toEqual({ status: "REVIEW_REQUIRED", reason: "AMBIGUOUS_OWNERSHIP" });
  });
  it("旧版本历史没有完整配置快照时保留定位证据，不伪造其周期或整理策略", async () => {
    const f = await oldFixture({ oldJobVersion: true }), db = await upgraded(f.path);
    expect(snapshot(db)).toEqual(f.before);
    const oldJobId = (f.before.download_job as { id: string; configuration_version: number }[]).find((row) => row.configuration_version === 4)!.id;
    expect(db.connection.prepare("SELECT * FROM download_source_demand WHERE job_id=?").get(oldJobId)).toBeUndefined();
    expect(db.connection.prepare("SELECT source_id,status,reason FROM source_rule_legacy_reference WHERE kind='download-job' AND legacy_id=?").get(oldJobId)).toEqual({ source_id: f.ids.subscription, status: "REVIEW_REQUIRED", reason: "SNAPSHOT_UNAVAILABLE" });
  });
  it("已有有效来源不重复迁入，既有草稿编辑保留并与旧有效配置分开", async () => {
    const f = await oldFixture(), staged = await CoreDatabase.open(f.path, migrations.slice(0, 9)); cleanup.push(() => staged.close());
    const localJson = JSON.stringify(sourceConfigurationSchema.parse({ type: "local", name: "已迁入来源", client: "quark", sourcePath: "/legacy/客户端输入", organization: { targetPath: "/legacy/电影库", mediaType: "MOVIE" } }));
    staged.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,paused,local_source_id,created_at,updated_at) VALUES(?,'local',4,1,?,1,?,?,?)").run(f.ids.local, localJson, f.ids.local, stamp, stamp);
    staged.connection.prepare("INSERT INTO source_rule_version(source_id,version,configuration_json,local_source_id,target_root_id,created_at) VALUES(?,4,?,?,?,?)").run(f.ids.local, localJson, f.ids.local, f.ids.localTarget, stamp);
    const draftJson = JSON.stringify(sourceConfigurationSchema.parse({ type: "cloud", name: "升级前尚未确认的编辑", accountId: f.ids.account, remoteRef: f.ids.remote, downloadRootId: f.ids.root, periodic: { enabled: false, intervalSeconds: 120 } }));
    staged.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,paused,created_at,updated_at) VALUES(?,'cloud',0,3,?,1,?,?)").run(f.ids.subscription, draftJson, stamp, stamp);
    const previewId = randomUUID();
    staged.connection.prepare("INSERT INTO source_rule_preview(id,source_id,version,draft_revision,request_key,configuration_json,state,expires_at,created_at) VALUES(?,?,0,3,?,?,'READY',9999999999999,?)").run(previewId, f.ids.subscription, randomUUID(), draftJson, stamp);
    staged.close(); const db = await upgraded(f.path);
    expect(snapshot(db)).toEqual(f.before);
    expect(db.connection.prepare("SELECT count(*) AS n FROM source_rule").get()).toEqual({ n: 2 });
    expect(db.connection.prepare("SELECT version,draft_revision,draft_json FROM source_rule WHERE id=?").get(f.ids.subscription)).toEqual({ version: 5, draft_revision: 3, draft_json: draftJson });
    expect(JSON.parse((db.connection.prepare("SELECT configuration_json FROM source_rule_version WHERE source_id=? AND version=5").get(f.ids.subscription) as { configuration_json: string }).configuration_json)).toMatchObject({ periodic: { enabled: true, intervalSeconds: 900 } });
    expect(db.connection.prepare("SELECT state FROM source_rule_preview WHERE id=?").get(previewId)).toEqual({ state: "EXPIRED" });
    expect(db.connection.prepare("SELECT configuration_json FROM source_rule_version WHERE source_id=?").get(f.ids.local)).toEqual({ configuration_json: localJson });
  });
  it("迁移中断回滚整步，重试保留最初备份且不重复配置或改动历史", async () => {
    const f = await oldFixture(), plan = migrations.map((migration) => migration.version === 10 ? { ...migration, apply(connection: Database.Database) { migration.apply!(connection); throw new Error("迁移中断"); } } : migration);
    await expect(CoreDatabase.open(f.path, plan)).rejects.toThrow(/迁移中断/);
    const intermediate = await CoreDatabase.open(f.path, migrations.slice(0, 9)); cleanup.push(() => intermediate.close());
    expect(intermediate.schemaVersion).toBe(9); expect(snapshot(intermediate)).toEqual(f.before); expect(intermediate.connection.prepare("SELECT count(*) AS n FROM source_rule").get()).toEqual({ n: 0 });
    expect(intermediate.connection.prepare("SELECT name FROM sqlite_master WHERE name='source_rule_legacy_reference'").get()).toBeUndefined(); intermediate.close();
    const backup = f.path + `.before-v${SCHEMA_VERSION}.bak`, hash = createHash("sha256").update(await readFile(backup)).digest("hex");
    const restored = await upgraded(f.path); expect(snapshot(restored)).toEqual(f.before); expect(restored.connection.prepare("SELECT count(*) AS n FROM source_rule").get()).toEqual({ n: 2 });
    expect(createHash("sha256").update(await readFile(backup)).digest("hex")).toBe(hash);
    expect((await readdir(f.directory)).some((name) => name.includes(`from-v9.before-v${SCHEMA_VERSION}`))).toBe(true);
    const original = new Database(backup, { readonly: true }); expect(original.pragma("user_version", { simple: true })).toBe(8); original.close();
    await expect(CoreDatabase.open(f.path, migrations.slice(0, 8))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
});
