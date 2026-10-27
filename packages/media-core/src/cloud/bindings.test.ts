import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { CloudError, type DriveCapabilities } from "@media-marshal/contracts";
import { remoteLocatorSchema } from "@media-marshal/contracts/internal";
import type { CoreHostGateway } from "@media-marshal/contracts/internal/rpc";
import type { PrivateCoreAction, PrivateCoreInput } from "@media-marshal/contracts/internal/core";
import { createMediaApplication } from "../modules/application";
import { DatabaseToken } from "../application/core-service";
import { RemoteCatalog } from "./catalog";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closing.splice(0)) await close(); });
const capabilities: DriveCapabilities = { authorizationMethods: ["cookie"], accountIdentity: "stable-id", objectIdentity: "stable-id", reliableRevision: false, hashAlgorithms: [], rangeRead: "supported", sourceKinds: ["webdav"] };
async function fixture(pathIdentity = false) {
  const coreGeneration = randomUUID(), hostGeneration = randomUUID(); let failing = false, stats = 0;
  const host: CoreHostGateway = { context: (bindingGeneration, attemptId) => ({ coreGeneration, hostGeneration, bindingGeneration, attemptId }), async request(_action, input: any) {
    stats++; if (failing) throw new CloudError("NETWORK_UNAVAILABLE");
    return { accountId: input.binding.accountId, name: input.locator.objectKey === "root" ? "新实现根目录" : "保留.txt", type: input.locator.objectKey === "root" ? "directory" : "file", size: input.locator.objectKey === "root" ? null : 5, modifiedAt: null, version: null } as never;
  } };
  const runtime = createMediaApplication(":memory:", [], { host }); await runtime.app.start(); closing.push(() => runtime.stop());
  const db = runtime.app.container.get(DatabaseToken).connection;
  const dispatch = <K extends PrivateCoreAction>(action: K, payload: PrivateCoreInput<K>) => runtime.dispatchPrivate({ kind: "core.private.request", requestId: randomUUID(), action, payload }) as Promise<any>;
  const first = await dispatch("cloud.authorization.begin", { name: "迁移测试", requestKey: randomUUID(), implementationId: "test.original" });
  const finish = (jobId: string) => dispatch("cloud.authorization.finish", { jobId, failure: null, capabilities: pathIdentity ? { ...capabilities, objectIdentity: "path" } : capabilities, identityKey: "a".repeat(64), ...(pathIdentity ? {} : { objectNamespace: "test.native-files", rootLocator: { kind: "stable-id", objectKey: "root" } }) });
  await finish(first.job.id);
  const root = (db.prepare("SELECT id FROM remote_entry WHERE parent_ref IS NULL").get() as { id: string }).id, ref = randomUUID(), locator = JSON.stringify(pathIdentity ? { kind: "path", segments: ["保留.txt"] } : { kind: "stable-id", objectKey: "file" });
  db.prepare("INSERT INTO remote_entry(id,account_id,parent_ref,name,type,size,observed_at) VALUES(?,?,?,'保留.txt','file',5,?)").run(ref, first.job.accountId, root, new Date().toISOString());
  db.prepare("INSERT INTO remote_binding(remote_ref,binding_id,account_id,locator_json,locator_key,updated_at) VALUES(?,?,?,?,?,?)").run(ref, first.candidate.binding.bindingId, first.job.accountId, locator, locator, new Date().toISOString());
  return { runtime, db, dispatch, finish, first, ref, root, host, fail: () => { failing = true; }, stats: () => stats };
}
describe("接入绑定的稳定 ID 迁移与回退", () => {
  it("候选逐项核对后保留应用引用，回退也使用新代际，不复用旧执行", async () => {
    const f = await fixture(), next = await f.dispatch("cloud.authorization.begin", { accountId: f.first.job.accountId, name: "迁移测试", requestKey: randomUUID(), implementationId: "test.replacement" });
    expect((await f.finish(next.job.id)).state).toBe("SUCCEEDED"); expect(f.stats()).toBe(2);
    const catalog = new RemoteCatalog(f.runtime.app.container.get(DatabaseToken), f.host);
    expect(catalog.accounts()[0]?.rootRef).toBe(f.root); expect(catalog.source(f.first.job.accountId, f.ref).binding.generation).toBe(next.candidate.binding.generation);
    expect(catalog.source(f.first.job.accountId, f.ref).locator).toEqual(remoteLocatorSchema.parse({ kind: "stable-id", objectKey: "file" }));
    const rollback = await f.dispatch("cloud.authorization.begin", { accountId: f.first.job.accountId, name: "迁移测试", requestKey: randomUUID(), implementationId: "test.original" });
    expect((await f.finish(rollback.job.id)).state).toBe("SUCCEEDED"); expect(rollback.candidate.binding.generation).not.toBe(f.first.candidate.binding.generation);
    expect(catalog.source(f.first.job.accountId, f.ref).binding.bindingId).toBe(rollback.candidate.binding.bindingId);
    expect(f.db.prepare("SELECT count(*) AS n FROM remote_entry").get()).toEqual({ n: 2 }); expect(f.db.prepare("SELECT count(*) AS n FROM download_attempt").get()).toEqual({ n: 0 });
  });
  it("同一账号的路径证据仍要求重新选择，历史引用保留但不能自动复用", async () => {
    const f = await fixture(true), next = await f.dispatch("cloud.authorization.begin", { accountId: f.first.job.accountId, name: "迁移测试", requestKey: randomUUID(), implementationId: "test.replacement" });
    expect((await f.finish(next.job.id)).state).toBe("SUCCEEDED");
    const catalog = new RemoteCatalog(f.runtime.app.container.get(DatabaseToken), f.host);
    expect(catalog.accounts()[0]?.status).toBe("RESELECT_REQUIRED"); expect(catalog.accounts()[0]?.rootRef).not.toBe(f.root);
    expect(() => catalog.source(f.first.job.accountId, f.ref)).toThrow(); expect(f.db.prepare("SELECT id FROM remote_entry WHERE id=?").get(f.ref)).toEqual({ id: f.ref });
  });
  it("候选映射的网络验证失败时原绑定不变，迟到成功不覆盖失败记录", async () => {
    const f = await fixture(), next = await f.dispatch("cloud.authorization.begin", { accountId: f.first.job.accountId, name: "迁移测试", requestKey: randomUUID(), implementationId: "test.replacement" }); f.fail();
    expect(await f.finish(next.job.id)).toMatchObject({ state: "FAILED", failure: { code: "NETWORK_UNAVAILABLE" } });
    expect((await f.dispatch("cloud.bootstrap", {}))[0]?.binding.generation).toBe(f.first.candidate.binding.generation);
    expect((await f.finish(next.job.id)).state).toBe("FAILED");
  });
});
