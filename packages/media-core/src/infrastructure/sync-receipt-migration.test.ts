import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase, migrations, SCHEMA_VERSION } from "./database.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture(conflictingEvidence = false) {
  const folder = await mkdtemp(join(tmpdir(), "marshal-receipt-migration-")); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, "desktop.sqlite3"), old = await CoreDatabase.open(path, migrations.slice(0, 28)); cleanup.push(() => old.close()); const db = old.connection;
  const id = randomUUID(), account = randomUUID(), remote = randomUUID(), root = randomUUID(), item = randomUUID(), attempt = randomUUID(), binding = randomUUID(), generation = randomUUID(), stamp = new Date().toISOString();
  const evidence = { volumeId: randomUUID(), inode: "1", birthtimeNs: "2", modifiedNs: "3", size: 5, sha256: "a".repeat(64) }, version = JSON.stringify({ kind: "weak", size: 5, modifiedAt: null }), key = digest(version);
  db.prepare("INSERT INTO cloud_account(id,name,provider_kind,status,created_at,updated_at) VALUES(?,'测试账号','quark','DISCONNECTED',?,?)").run(account, stamp, stamp);
  db.prepare("INSERT INTO provider_binding(id,account_id,implementation_id,configuration_version,generation,state,created_at) VALUES(?,?,'test.fixture',1,?,'ACTIVE',?)").run(binding, account, generation, stamp);
  db.prepare("INSERT INTO managed_download_root VALUES(?,?,?,'{}','UNAVAILABLE',?)").run(root, root, "/isolated/root", stamp);
  db.prepare("INSERT INTO remote_entry(id,account_id,name,type,size,observed_at) VALUES(?,?,'file.mkv','file',5,?)").run(remote, account, stamp);
  db.prepare("INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,target_root_id,target_path_key,target_segments_json,expected_size,state,local_sha256,completed_size,created_at,updated_at) VALUES(?,?,?,?,?,?,'slot','[\"file.mkv\"]',5,'COMPLETED',?,5,?,?)").run(item, account, remote, key, version, root, evidence.sha256, stamp, stamp);
  db.prepare("INSERT INTO download_attempt(id,account_id,binding_id,core_generation,binding_generation,host_generation,idempotency_key,staging_key,state,plan_json,stop_evidence_json,created_at,stopped_at) VALUES(?,?,?,?,?,?,?,?,'EXITED','{}','{}',?,?)").run(attempt, account, binding, randomUUID(), generation, randomUUID(), randomUUID(), randomUUID(), stamp, stamp);
  db.prepare("INSERT INTO download_commit_intent VALUES(?,?,?,?,?,?,?,'RECORDED',?,?)").run(item, attempt, account, key, evidence.sha256, 5, JSON.stringify({ ...evidence, sha256: conflictingEvidence ? "b".repeat(64) : evidence.sha256 }), stamp, stamp);
  db.prepare("INSERT INTO sync_receipt VALUES(?,'cloud',?,?,?, ?,?,'slot','[\"file.mkv\"]',?,5,?,'download-item',?,'')").run(id, account, remote, key, version, root, evidence.sha256, stamp, item);
  const before = db.prepare("SELECT * FROM sync_receipt").all(); old.close(); return { path, id, evidence, before };
}
describe("v29 成功收据文件证据迁移", () => {
  it("保留 v28 成功事实，仅补入摘要和长度一致的原提交文件证据", async () => {
    const f = await fixture(), db = await CoreDatabase.open(f.path, migrations.slice(0, 29)); cleanup.push(() => db.close());
    expect(db.schemaVersion).toBe(29); expect(db.connection.prepare("SELECT * FROM sync_receipt").all()).toEqual(f.before);
    expect(JSON.parse((db.connection.prepare("SELECT evidence_json FROM sync_receipt_evidence WHERE receipt_id=?").get(f.id) as { evidence_json: string }).evidence_json)).toEqual(f.evidence);
    expect(db.connection.prepare("SELECT count(*) AS n FROM sync_receipt_local_state").get()).toEqual({ n: 0 }); expect(db.connection.prepare("SELECT count(*) AS n FROM download_job_receipt").get()).toEqual({ n: 0 });
    expect(db.connection.pragma("foreign_key_check")).toEqual([]); db.close(); await expect(CoreDatabase.open(f.path, migrations.slice(0, 28))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("证据冲突不伪造原文件身份，也不删除已有成功事实", async () => {
    const f = await fixture(true), db = await CoreDatabase.open(f.path, migrations.slice(0, 29)); cleanup.push(() => db.close());
    expect(db.connection.prepare("SELECT * FROM sync_receipt").all()).toEqual(f.before); expect(db.connection.prepare("SELECT count(*) AS n FROM sync_receipt_evidence").get()).toEqual({ n: 0 });
  });
  it("迁移失败保留 v28 原记录及一致性备份，重试不覆盖原备份", async () => {
    const f = await fixture(), failed = [...migrations.slice(0, 28), { ...migrations[28]!, sql: migrations[28]!.sql + "SELECT injected_receipt_failure();" }];
    await expect(CoreDatabase.open(f.path, failed)).rejects.toThrow(); const backup = f.path + ".before-v29.bak", before = digest(await readFile(backup));
    const old = await CoreDatabase.open(f.path, migrations.slice(0, 28)); expect(old.schemaVersion).toBe(28); expect(old.connection.prepare("SELECT * FROM sync_receipt").all()).toEqual(f.before); expect(old.connection.prepare("SELECT name FROM sqlite_master WHERE name='sync_receipt_evidence'").get()).toBeUndefined(); old.close();
    const current = await CoreDatabase.open(f.path, migrations.slice(0, 29)); cleanup.push(() => current.close()); expect(current.schemaVersion).toBe(29); expect(digest(await readFile(backup))).toBe(before);
    const saved = new Database(backup, { readonly: true }); expect(saved.pragma("user_version", { simple: true })).toBe(28); saved.close();
  });
});

describe("v30 登录历史线索迁移", () => {
  async function historyFixture() {
    const f = await fixture(), old = await CoreDatabase.open(f.path, migrations.slice(0, 29)), db = old.connection;
    const receipt = db.prepare("SELECT source_namespace,source_object_key FROM sync_receipt").get() as { source_namespace: string; source_object_key: string };
    const binding = db.prepare("SELECT id FROM provider_binding").get() as { id: string }, locator = JSON.stringify({ kind: "path", segments: ["file.mkv"] });
    db.prepare("INSERT INTO remote_binding(remote_ref,binding_id,account_id,locator_json,locator_key,updated_at) VALUES(?,?,?,?,?,?)").run(receipt.source_object_key, binding.id, receipt.source_namespace, locator, digest(locator), new Date().toISOString());
    old.close(); return { ...f, receipt, locator };
  }
  it("仅回填可核对的定位线索，不伪造账号确认或新授权关联，原成功事实不变", async () => {
    const f = await historyFixture(), db = await CoreDatabase.open(f.path); cleanup.push(() => db.close());
    expect(db.schemaVersion).toBe(SCHEMA_VERSION); expect(db.connection.prepare("SELECT * FROM sync_receipt").all()).toEqual(f.before);
    expect(db.connection.prepare("SELECT * FROM sync_receipt_origin").all()).toEqual([{ receipt_id: f.id, account_id: f.receipt.source_namespace, object_namespace: "path", locator_key: digest(f.locator) }]);
    expect(db.connection.prepare("SELECT count(*) AS n FROM sync_history_confirmation").get()).toEqual({ n: 0 }); expect(db.connection.prepare("SELECT count(*) AS n FROM sync_receipt_reference").get()).toEqual({ n: 0 });
    expect(db.connection.pragma("foreign_key_check")).toEqual([]); db.close(); await expect(CoreDatabase.open(f.path, migrations.slice(0, 29))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("没有定位映射的旧收据仍保留，未知历史不按名称猜测", async () => {
    const f = await fixture(), db = await CoreDatabase.open(f.path); cleanup.push(() => db.close());
    expect(db.connection.prepare("SELECT * FROM sync_receipt").all()).toEqual(f.before); expect(db.connection.prepare("SELECT count(*) AS n FROM sync_receipt_origin").get()).toEqual({ n: 0 });
  });
  it("回填失败整体回滚，重试不覆盖 v29 一致性备份", async () => {
    const f = await historyFixture(), failing = [...migrations.slice(0, 29), { ...migrations[29]!, sql: migrations[29]!.sql + "SELECT injected_history_failure();" }];
    await expect(CoreDatabase.open(f.path, failing)).rejects.toThrow(); const backup = f.path + ".before-v30.bak", before = digest(await readFile(backup));
    const old = await CoreDatabase.open(f.path, migrations.slice(0, 29)); expect(old.schemaVersion).toBe(29); expect(old.connection.prepare("SELECT * FROM sync_receipt").all()).toEqual(f.before); expect(old.connection.prepare("SELECT name FROM sqlite_master WHERE name='sync_receipt_origin'").get()).toBeUndefined(); old.close();
    const db = await CoreDatabase.open(f.path); cleanup.push(() => db.close()); expect(db.schemaVersion).toBe(SCHEMA_VERSION); expect(digest(await readFile(backup))).toBe(before);
  });
});
