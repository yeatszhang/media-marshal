import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreDatabase, migrations, SCHEMA_VERSION } from "./database";
import { CloudError } from "@media-marshal/contracts";
import { CloudRepository } from "../cloud/repository";

const connections: CoreDatabase[] = [];
const directories: string[] = [];
const now = new Date().toISOString();
const digest = "a".repeat(64);
async function open(path?: string) {
  if (!path) { const directory = await mkdtemp(join(tmpdir(), "marshal-cloud-db-")); directories.push(directory); path = join(directory, "desktop.sqlite3"); }
  const database = await CoreDatabase.open(path); connections.push(database);
  return { database, path };
}
afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function seed(database: CoreDatabase, sharedRoot?: string) {
  const db = database.connection;
  const accountId = randomUUID(), bindingId = randomUUID(), generation = randomUUID(), remoteRef = randomUUID(), rootId = sharedRoot ?? randomUUID(), itemId = randomUUID();
  new CloudRepository(database).createAccount({ id: accountId, name: "测试账号", credentialRef: randomUUID(), bindingId, implementationId: "test.drive", generation });
  db.prepare("UPDATE provider_binding SET state='ACTIVE' WHERE id=?").run(bindingId);
  if (!sharedRoot) db.prepare("INSERT INTO managed_download_root VALUES(?,?,?,?,'AVAILABLE',?)").run(rootId, randomUUID(), `/synthetic/${rootId}`, "fixture-volume", now);
  db.prepare("INSERT INTO remote_entry(id,account_id,name,type,size,observed_at) VALUES(?,?,'sample.bin','file',10,?)").run(remoteRef, accountId, now);
  db.prepare("INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,target_root_id,target_path_key,target_segments_json,expected_size,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,10,'QUEUED',?,?)")
    .run(itemId, accountId, remoteRef, digest, JSON.stringify({ kind: "weak", size: 10, modifiedAt: null }), rootId, "same-slot", '["sample.bin"]', now, now);
  return { accountId, bindingId, generation, remoteRef, rootId, itemId };
}
function attempt(database: CoreDatabase, seeded: ReturnType<typeof seed>) {
  const id = randomUUID();
  database.connection.prepare("INSERT INTO download_attempt(id,account_id,binding_id,core_generation,binding_generation,host_generation,idempotency_key,staging_key,state,plan_json,created_at) VALUES(?,?,?,?,?,?,?,?,'CLAIMED','{}',?)")
    .run(id, seeded.accountId, seeded.bindingId, randomUUID(), seeded.generation, randomUUID(), randomUUID(), id, now);
  return id;
}
function claim(database: CoreDatabase, seeded: ReturnType<typeof seed>, attemptId: string) {
  database.connection.prepare("INSERT INTO download_claim VALUES(?,?,?,?,?,0)").run(seeded.itemId, attemptId, seeded.accountId, seeded.rootId, "same-slot");
}

describe("云端 schema v2 的实际 SQLite 约束", () => {
  it("诊断仅聚合状态计数，区分暂停、认证失效与组件故障", async () => {
    const { database } = await open(), paused = seed(database), auth = seed(database), failed = seed(database);
    const db = database.connection;
    db.prepare("UPDATE download_item SET state='PAUSED' WHERE id=?").run(paused.itemId);
    db.prepare("UPDATE download_item SET state='AUTH_REQUIRED',failure_code='AUTH_REQUIRED' WHERE id=?").run(auth.itemId);
    db.prepare("UPDATE cloud_account SET status='AUTH_REQUIRED' WHERE id=?").run(auth.accountId);
    db.prepare("UPDATE download_item SET state='FAILED',failure_code='COMPONENT_UNAVAILABLE' WHERE id=?").run(failed.itemId);
    expect(new CloudRepository(database).diagnosticCounts()).toEqual({ pausedItems: 1, authenticationRequiredAccounts: 1, authenticationRequiredItems: 1, componentFailedItems: 1 });
  });
  it("升级保留 v1 本地来源和任务，云账号保持空且有匹配备份", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marshal-cloud-v1-")); directories.push(directory);
    const path = join(directory, "desktop.sqlite3");
    const old = await CoreDatabase.open(path, migrations.slice(0, 1));
    const sourceId = randomUUID(), taskId = randomUUID();
    old.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'旧夸克','quark','/source','/target','AUTO','COPY',?)").run(sourceId, now);
    old.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,'/source/a.mkv','PENDING',?,?)").run(taskId, sourceId, now, now);
    old.close();
    const { database } = await open(path);
    expect(database.schemaVersion).toBe(SCHEMA_VERSION);
    expect(database.connection.prepare("SELECT kind,automatic FROM desktop_source WHERE id=?").get(sourceId)).toEqual({ kind: "quark", automatic: 0 });
    expect(database.connection.prepare("SELECT status FROM media_task WHERE id=?").get(taskId)).toEqual({ status: "PENDING" });
    expect(database.connection.prepare("SELECT count(*) AS count FROM cloud_account").get()).toEqual({ count: 0 });
    const backup = await CoreDatabase.open(`${path}.before-v${SCHEMA_VERSION}.bak`, migrations.slice(0, 1)); connections.push(backup);
    expect(backup.schemaVersion).toBe(1);
    expect(backup.connection.prepare("SELECT id FROM media_task").get()).toEqual({ id: taskId });
  });
  it("同账号的未确认旧执行阻止第二个写入者，退出需保留停止证据", async () => {
    const { database } = await open(); const data = seed(database); const first = attempt(database, data);
    expect(() => attempt(database, data)).toThrow(/UNIQUE/);
    database.connection.prepare("UPDATE download_attempt SET state='UNCERTAIN' WHERE id=?").run(first);
    expect(() => attempt(database, data)).toThrow(/UNIQUE/);
    expect(() => database.connection.prepare("UPDATE download_attempt SET state='STOPPED',stopped_at=? WHERE id=?").run(now, first)).toThrow(/CHECK/);
    database.connection.prepare("UPDATE download_attempt SET state='STOPPED',stopped_at=?,stop_evidence_json=? WHERE id=?").run(now, '{"kind":"observed-exit"}', first);
    expect(attempt(database, data)).toBeTypeOf("string");
  });
  it("v2 迁移中途失败时回到完整 v1，不遗留半套云端表", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marshal-cloud-rollback-")); directories.push(directory);
    const path = join(directory, "desktop.sqlite3");
    const old = await CoreDatabase.open(path, migrations.slice(0, 1));
    old.connection.prepare("INSERT INTO app_setting VALUES('preserved','v1')").run(); old.close();
    await expect(CoreDatabase.open(path, [migrations[0]!, { version: 2, sql: migrations[1]!.sql + " INVALID SQL;" }])).rejects.toThrow();
    const restored = await CoreDatabase.open(path, migrations.slice(0, 1)); connections.push(restored);
    expect(restored.schemaVersion).toBe(1);
    expect(restored.connection.prepare("SELECT value FROM app_setting WHERE key='preserved'").get()).toEqual({ value: "v1" });
    expect(restored.connection.prepare("SELECT name FROM sqlite_master WHERE name='cloud_account'").get()).toBeUndefined();
  });
  it("两个连接竞争同目标时只保留一个领取，失败事务不提前推进状态", async () => {
    const { database: first, path } = await open(); const a = seed(first); const b = seed(first, a.rootId);
    const aa = attempt(first, a), ab = attempt(first, b); const { database: second } = await open(path);
    claim(first, a, aa);
    expect(() => second.connection.transaction(() => {
      second.connection.prepare("UPDATE download_item SET state='RUNNING' WHERE id=?").run(b.itemId);
      claim(second, b, ab);
    })()).toThrow(/UNIQUE/);
    expect(second.connection.prepare("SELECT state FROM download_item WHERE id=?").get(b.itemId)).toEqual({ state: "QUEUED" });
    expect(second.connection.prepare("SELECT item_id FROM download_claim").all()).toEqual([{ item_id: a.itemId }]);
    expect(() => claim(second, a, ab)).toThrow();
  });
  it("未完成项不能生成 outbox，完成必须有长度与摘要且投递去重", async () => {
    const { database } = await open(); const data = seed(database); const db = database.connection;
    const insert = () => db.prepare("INSERT INTO ingestion_outbox(id,item_id,version_key,state,created_at,updated_at) VALUES(?,?,?,'PENDING',?,?)").run(randomUUID(), data.itemId, digest, now, now);
    expect(insert).toThrow(/尚未提交/);
    expect(() => db.prepare("UPDATE download_item SET state='COMPLETED',local_sha256=? WHERE id=?").run(digest, data.itemId)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE download_item SET state='COMPLETED',local_sha256=?,completed_size=9 WHERE id=?").run(digest, data.itemId)).toThrow(/CHECK/);
    db.prepare("UPDATE download_item SET state='COMPLETED',local_sha256=?,completed_size=10 WHERE id=?").run(digest, data.itemId);
    insert(); expect(insert).toThrow(/UNIQUE/);
  });
  it("账号持久化入口拒绝 Cookie 与原始组件配置，只保存凭据 UUID", async () => {
    const { database, path } = await open(); const repo = new CloudRepository(database);
    const input = { id: randomUUID(), name: "账号", credentialRef: randomUUID(), bindingId: randomUUID(), implementationId: "test.drive", generation: randomUUID() };
    const cookie = "__pus=fixture-sensitive-cookie";
    for (const extra of [{ cookie }, { addition: cookie }, { password: cookie }])
      expect(() => repo.createAccount({ ...input, ...extra })).toThrow(CloudError);
    expect(() => repo.createAccount({ ...input, credentialRef: cookie })).toThrow(CloudError);
    const account = repo.createAccount(input);
    expect(account).not.toHaveProperty("credentialRef");
    expect(database.connection.prepare("SELECT credential_ref FROM cloud_account").get()).toEqual({ credential_ref: input.credentialRef });
    database.connection.pragma("wal_checkpoint(TRUNCATE)");
    expect((await readFile(path)).includes(Buffer.from(cookie))).toBe(false);
  });
});
