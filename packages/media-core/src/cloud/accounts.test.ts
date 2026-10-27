import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudError, cloudFailure, type DriveCapabilities } from "@media-marshal/contracts";
import { CoreDatabase, migrations, SCHEMA_VERSION } from "../infrastructure/database";
import { CloudAccounts } from "./accounts";
const capabilities: DriveCapabilities = { authorizationMethods: ["cookie"], accountIdentity: "unavailable", objectIdentity: "path", reliableRevision: false, hashAlgorithms: [], rangeRead: "unknown", sourceKinds: ["webdav"] };
const dbs: CoreDatabase[] = [], directories: string[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) db.close(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup() { const db = await CoreDatabase.open(":memory:"); dbs.push(db); return { db, service: new CloudAccounts(db) }; }
const draft = () => ({ name: "测试账号", requestKey: randomUUID(), implementationId: "test.drive" });
describe("授权持久化与绑定提交", () => {
  it("重复请求返回同一作业，意图变化拒绝，公开查询不含私有引用", async () => {
    const { db, service } = await setup(), input = draft(), first = service.dispatch("cloud.authorization.begin", input);
    expect(service.dispatch("cloud.authorization.begin", input)).toEqual(first);
    expect(() => service.dispatch("cloud.authorization.begin", { ...input, name: "another" })).toThrow(CloudError);
    expect(JSON.stringify(service.authorization(input.requestKey))).not.toMatch(/credentialRef|bindingId|implementationId/);
    expect(db.connection.prepare("SELECT count(*) AS n FROM cloud_account").get()).toEqual({ n: 1 });
  });
  it("认证失败候选不能覆盖活动绑定，稳定身份不匹配同样拒绝", async () => {
    const { db, service } = await setup(), first = service.dispatch("cloud.authorization.begin", draft());
    service.dispatch("cloud.authorization.finish", { jobId: first.job.id, failure: null, capabilities: { ...capabilities, accountIdentity: "stable-id" }, identityKey: "a".repeat(64) });
    const candidate = service.dispatch("cloud.authorization.begin", { ...draft(), accountId: first.job.accountId });
    const failed = service.dispatch("cloud.authorization.finish", { jobId: candidate.job.id, failure: null, capabilities: { ...capabilities, accountIdentity: "stable-id" }, identityKey: "b".repeat(64) });
    expect(failed).toMatchObject({ state: "FAILED", failure: { code: "CONFLICT" } });
    expect(service.dispatch("cloud.bootstrap", {})[0]!.binding).toEqual(first.candidate.binding);
    expect(db.connection.prepare("SELECT credential_ref FROM cloud_account").get()).toEqual({ credential_ref: first.candidate.credentialRef });
  });
  it("没有可信账号身份时保留账号但重新建立根，不复用旧路径授权", async () => {
    const { db, service } = await setup(), first = service.dispatch("cloud.authorization.begin", draft());
    service.dispatch("cloud.authorization.finish", { jobId: first.job.id, failure: null, capabilities, identityKey: null });
    const oldRoot = db.connection.prepare("SELECT id FROM remote_entry").get();
    db.connection.prepare("UPDATE cloud_account SET status='AUTH_REQUIRED'").run();
    const second = service.dispatch("cloud.authorization.begin", { ...draft(), accountId: first.job.accountId });
    expect(second.previous?.binding.generation).toBe(first.candidate.binding.generation);
    service.dispatch("cloud.authorization.finish", { jobId: second.job.id, failure: null, capabilities, identityKey: null });
    expect(db.connection.prepare("SELECT id,status FROM cloud_account").get()).toEqual({ id: first.job.accountId, status: "RESELECT_REQUIRED" });
    expect(db.connection.prepare("SELECT count(*) AS n FROM remote_entry").get()).toEqual({ n: 2 });
    expect(db.connection.prepare("SELECT id FROM remote_entry WHERE id=?").get((oldRoot as { id: string }).id)).toEqual(oldRoot);
  });
  it("Core 恢复不重放授权，迟到成功不覆盖中断记录；解除连接保留历史", async () => {
    const { db, service } = await setup(), first = service.dispatch("cloud.authorization.begin", draft());
    service.recover();
    expect(service.authorization(first.job.requestKey)).toMatchObject({ state: "INTERRUPTED", failure: { code: "INTERRUPTED" } });
    expect(service.dispatch("cloud.authorization.finish", { jobId: first.job.id, failure: null, capabilities, identityKey: null }).state).toBe("INTERRUPTED");
    expect(service.dispatch("cloud.bootstrap", {})).toEqual([]);
    service.dispatch("cloud.account.disconnected", { accountId: first.job.accountId });
    expect(db.connection.prepare("SELECT status FROM cloud_account").get()).toEqual({ status: "DISCONNECTED" });
    expect(service.authorization(first.job.requestKey)?.id).toBe(first.job.id);
  });
  it("v2 追加升级保留业务和匹配备份，未授权账号不会启动宿主", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marshal-auth-v3-")); directories.push(dir);
    const path = join(dir, "desktop.sqlite3"), old = await CoreDatabase.open(path, migrations.slice(0, 2));
    old.connection.prepare("INSERT INTO app_setting VALUES('preserved','v2')").run(); old.close();
    const db = await CoreDatabase.open(path); dbs.push(db);
    expect(db.schemaVersion).toBe(SCHEMA_VERSION); expect(db.connection.prepare("SELECT value FROM app_setting").get()).toEqual({ value: "v2" });
    expect(new CloudAccounts(db).dispatch("cloud.bootstrap", {})).toEqual([]);
    const backup = await CoreDatabase.open(path + `.before-v${SCHEMA_VERSION}.bak`, migrations.slice(0, 2)); dbs.push(backup); expect(backup.schemaVersion).toBe(2);
  });
});
