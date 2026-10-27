import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { CloudError, type DriveCapabilities } from "@media-marshal/contracts";
import type { CoreHostGateway } from "@media-marshal/contracts/internal/rpc";
import { CoreDatabase } from "../infrastructure/database";
import { CloudAccounts } from "./accounts";
import { RemoteCatalog } from "./catalog";

const connections: CoreDatabase[] = [];
export const capabilities: DriveCapabilities = { authorizationMethods: ["cookie"], accountIdentity: "unavailable", objectIdentity: "path", reliableRevision: false, hashAlgorithms: [], rangeRead: "unknown", sourceKinds: ["webdav"] };
afterEach(() => { for (const db of connections.splice(0)) db.close(); });
async function setup() {
  const database = await CoreDatabase.open(":memory:"); connections.push(database);
  const accounts = new CloudAccounts(database), prepared = accounts.dispatch("cloud.authorization.begin", { name: "测试账号", requestKey: randomUUID(), implementationId: "test.drive" });
  accounts.dispatch("cloud.authorization.finish", { jobId: prepared.job.id, failure: null, capabilities, identityKey: null });
  const coreGeneration = randomUUID(); let hostGeneration = randomUUID();
  const request = vi.fn();
  const host = { context: (bindingGeneration: string, attemptId: string) => ({ bindingGeneration, attemptId, coreGeneration, hostGeneration }), request } as CoreHostGateway;
  const catalog = new RemoteCatalog(database, host), account = catalog.accounts()[0]!;
  function page(names: string[], complete = true, total: number | null = names.length) {
    return { entries: names.map((name) => ({ entry: { accountId: account.id, name, type: "file", size: null, modifiedAt: null, version: null }, locator: { kind: "path", segments: [name] } })), complete, nextCursor: complete ? null : "private-upstream-cookie-free-cursor", total };
  }
  const input = { accountId: account.id, parentRef: account.rootRef!, pageSize: 2 };
  return { database, accounts, prepared, catalog, account, request, host, page, input, replaceHost() { hostGeneration = randomUUID(); } };
}
describe("Core 远端目录与应用身份", () => {
  it("Core 重启到凭据注入完成之间阻断浏览，不能将恢复窗口误报为 Cookie 失效", async () => {
    const f = await setup(), catalog = new RemoteCatalog(f.database, f.host, Date.now, (binding) => f.accounts.isReady(binding));
    f.accounts.recover();
    expect(catalog.accounts()[0]!.status).toBe("UNAVAILABLE");
    await expect(catalog.list(f.input)).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
    expect(f.request).not.toHaveBeenCalled();
    f.accounts.dispatch("cloud.account.restored", { accountId: f.account.id, generation: f.prepared.candidate.binding.generation, failure: null });
    f.request.mockResolvedValue(f.page(["restored.txt"]));
    expect((await catalog.list(f.input)).items).toHaveLength(1); expect(catalog.accounts()[0]!.status).toBe("READY");
  });
  it("大小写与 Unicode 保留原名，引用刷新及 Core 重建后稳定，公开游标不泄漏路径", async () => {
    const f = await setup(); f.request.mockResolvedValue(f.page(["A.txt", "a.txt", "é.txt", "e\u0301.txt"]));
    const first = await f.catalog.list({ ...f.input, pageSize: 4 });
    expect(new Set(first.items.map((item) => item.ref)).size).toBe(4);
    expect(first.items.every((item) => item.version === null && item.size === null)).toBe(true);
    const second = await new RemoteCatalog(f.database, f.host).list({ ...f.input, pageSize: 4, refresh: true });
    expect(second.items.map((item) => item.ref)).toEqual(first.items.map((item) => item.ref));
    expect(JSON.stringify(second)).not.toMatch(/locator|segments|bindingId|generation|credential|private-upstream/);
  });
  it("分页失败保留已观察引用，不把缺失条目当删除，刷新使旧游标失效", async () => {
    const f = await setup(); f.request.mockResolvedValueOnce(f.page(["one", "two"], false, 4));
    const first = await f.catalog.list(f.input); expect(first.complete).toBe(false); expect(first.nextCursor).toMatch(/^[a-f0-9]{32}$/);
    f.request.mockRejectedValueOnce(new CloudError("NETWORK_UNAVAILABLE"));
    await expect(f.catalog.list({ ...f.input, cursor: first.nextCursor })).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    expect(f.database.connection.prepare("SELECT count(*) AS n FROM remote_entry").get()).toEqual({ n: 3 });
    f.request.mockResolvedValueOnce(f.page(["one"], true, 1)); await f.catalog.list({ ...f.input, refresh: true });
    expect(f.database.connection.prepare("SELECT count(*) AS n FROM remote_entry").get()).toEqual({ n: 3 });
    await expect(f.catalog.list({ ...f.input, cursor: first.nextCursor })).rejects.toMatchObject({ code: "REMOTE_CHANGED" });
  });
  it("路径目录改名要求重新定位，认证失败停止该账号新请求", async () => {
    const f = await setup(); f.request.mockRejectedValueOnce(new CloudError("REMOTE_NOT_FOUND"));
    await expect(f.catalog.list(f.input)).rejects.toMatchObject({ code: "REMOTE_NOT_FOUND" });
    expect(f.catalog.accounts()[0]!.status).toBe("RESELECT_REQUIRED");
    f.request.mockRejectedValueOnce(new CloudError("AUTH_REQUIRED"));
    await expect(f.catalog.list(f.input)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const count = f.request.mock.calls.length;
    await expect(f.catalog.list(f.input)).rejects.toMatchObject({ code: "AUTH_REQUIRED" }); expect(f.request).toHaveBeenCalledTimes(count);
  });
  it("跨页重复、总数变化、上游越界对象和宿主换代均不能产生完整页面", async () => {
    const f = await setup(); f.request.mockResolvedValueOnce(f.page(["one", "two"], false, 4));
    const first = await f.catalog.list(f.input);
    f.request.mockResolvedValueOnce(f.page(["one", "three"], true, 4));
    await expect(f.catalog.list({ ...f.input, cursor: first.nextCursor })).rejects.toMatchObject({ code: "REMOTE_CHANGED" });
    f.replaceHost(); await expect(f.catalog.list({ ...f.input, cursor: first.nextCursor })).rejects.toMatchObject({ code: "REMOTE_CHANGED" });
    const unsafe = f.page(["bad"]); unsafe.entries[0]!.locator.segments = ["unrelated", "bad"];
    f.request.mockResolvedValueOnce(unsafe); await expect(f.catalog.list(f.input)).rejects.toMatchObject({ code: "REMOTE_CHANGED" });
  });
  it("等待期间发生账号换代时拒绝旧页，不能用另一账号的远端引用", async () => {
    const f = await setup();
    let complete!: (value: unknown) => void; f.request.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = f.catalog.list(f.input);
    f.database.connection.prepare("UPDATE provider_binding SET generation=? WHERE id=?").run(randomUUID(), f.prepared.candidate.binding.bindingId);
    complete(f.page(["late"])); await expect(pending).rejects.toMatchObject({ code: "INTERRUPTED" });
    await expect(f.catalog.list({ ...f.input, parentRef: randomUUID() })).rejects.toMatchObject({ code: "REMOTE_NOT_FOUND" });
  });
});
