import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { CloudError } from "@media-marshal/contracts";
import type { BindingRef, SourceRequest } from "@media-marshal/contracts/internal";
import { OpenListQuarkProvider } from "./provider";
import { OpenListApiError } from "./client";
import { SourceCredentialBroker } from "../source-credentials";

const binding = (): BindingRef => ({ accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID() });
const file = (name = "电影 + 中文.mp4") => ({ name, size: 123, is_dir: false, modified: "2026-10-24T10:20:30+08:00", sign: "fixture-sign", raw_url: "https://invalid.example/?token=fixture-token", hash_info: { md5: "a".repeat(32) } });
function fixture() {
  let id = 0;
  const storages = new Map<number, { id: number; mount_path: string; driver: string; addition: string }>();
  const state: { entries: ReturnType<typeof file>[]; failure?: Error } = { entries: [file(), file("换行\n名称.txt")] };
  const api = vi.fn(async (_method: string, path: string, body?: any): Promise<unknown> => {
    if (path === "/api/admin/storage/create") {
      const value = { id: ++id, ...body }; storages.set(id, value);
      if (JSON.parse(body.addition).cookie === "invalid") throw new OpenListApiError(500, 200, "authentication", id);
      return { id };
    }
    if (path.startsWith("/api/admin/storage/delete?id=")) { storages.delete(Number(path.split("=")[1])); return null; }
    if (path.startsWith("/api/admin/storage/get?id=")) return storages.get(Number(path.split("=")[1]));
    if (state.failure) throw state.failure;
    if (path === "/api/fs/list") return { content: state.entries.slice((body.page - 1) * body.per_page, body.page * body.per_page), total: state.entries.length, readme: "fixture-private-readme" };
    if (path === "/api/fs/get") return state.entries.find((value) => value.name === body.path.split("/").at(-1));
    throw new Error("未知测试动作");
  });
  const gateway = { client: { origin: "http://127.0.0.1:5244", api }, readOnlyAccess: vi.fn(async (scope: string) => ({ username: "fixture-reader", password: "fixture-reader-secret", mountPath: "/m_" + scope.replaceAll("-", "") })) };
  const broker = new SourceCredentialBroker(), refreshed = vi.fn(async () => {});
  return { provider: new OpenListQuarkProvider(gateway, broker, refreshed), broker, gateway, state, storages, refreshed };
}
function source(ref: BindingRef, name = "电影 + 中文.mp4"): SourceRequest { return { binding: ref, remoteRef: randomUUID(), locator: { kind: "path", segments: [name] }, expectedVersion: null }; }
describe("OpenList 普通夸克 Provider", () => {
  it("只声明实测能力，私有签名、URL 和 Cookie 不进入元数据或租约", async () => {
    const { provider, broker } = fixture(), ref = binding();
    expect(await provider.validateCredential({ binding: ref, cookie: "fixture-cookie" })).toEqual({ stableKey: null });
    expect(await provider.capabilities(ref)).toMatchObject({ accountIdentity: "unavailable", objectIdentity: "path", reliableRevision: false, hashAlgorithms: [] });
    const request = source(ref), metadata = await provider.stat(request);
    expect(metadata).toMatchObject({ size: 123, version: { kind: "weak", size: 123 } });
    const lease = await provider.acquireSource({ ...request, expectedVersion: metadata.version });
    expect(JSON.stringify([metadata, lease])).not.toMatch(/fixture-cookie|fixture-token|fixture-sign|fixture-reader-secret|hash_info|raw_url/);
    expect(broker.read(lease.credentialHandle, ref.generation).password).toBe("fixture-reader-secret");
    await provider.releaseSource(lease.leaseId); expect(() => broker.read(lease.credentialHandle, ref.generation)).toThrow();
  });
  it("失效凭据删除失败候选，不覆盖已经验证的绑定", async () => {
    const { provider, storages } = fixture(), ref = binding();
    await provider.validateCredential({ binding: ref, cookie: "fixture-cookie" });
    const candidate = { ...ref, bindingId: randomUUID(), generation: randomUUID() };
    await expect(provider.validateCredential({ binding: candidate, cookie: "invalid" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(storages.size).toBe(1); expect((await provider.stat(source(ref))).size).toBe(123);
    await expect(provider.validateCredential({ binding: ref, cookie: "another-cookie" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("分页游标绑定代际、根和页尺寸，半页失败与总数变化不能声称完整", async () => {
    const { provider, state, gateway } = fixture(), ref = binding(); await provider.validateCredential({ binding: ref, cookie: "fixture-cookie" });
    const query = { binding: ref, parentRef: randomUUID(), locator: { kind: "path" as const, segments: [] }, cursor: null, pageSize: 1 };
    const first = await provider.list(query); expect(first.complete).toBe(false); expect(first.nextCursor).toBeTruthy();
    const next = await provider.list({ ...query, cursor: first.nextCursor }); expect(next.complete).toBe(true); expect(next.entries[0]!.entry.name).toContain("\n");
    const calls = gateway.client.api.mock.calls.length;
    await expect(provider.list({ ...query, cursor: first.nextCursor, pageSize: 2 })).rejects.toMatchObject({ code: "INVALID_REQUEST" }); expect(gateway.client.api).toHaveBeenCalledTimes(calls);
    state.entries.push(file("new.bin")); await expect(provider.list({ ...query, cursor: first.nextCursor })).rejects.toMatchObject({ code: "REMOTE_CHANGED" });
    state.failure = new OpenListApiError(429, 429, "rate-limit"); await expect(provider.list(query)).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 30 });
  });
  it("500 未知响应保持组件错误，不能一律要求重新登录", async () => {
    const { provider, state } = fixture(), ref = binding(); await provider.validateCredential({ binding: ref, cookie: "fixture-cookie" });
    state.failure = new OpenListApiError(500, 200);
    await expect(provider.stat(source(ref))).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
    state.failure = undefined; state.entries = [{} as any];
    await expect(provider.stat(source(ref))).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
  });
  it("500 缺失必须刷新父目录核实；文件仍在或分页失败时不宣告删除", async () => {
    const f = fixture(), ref = binding(); await f.provider.validateCredential({ binding: ref, cookie: "fixture-cookie" }); const original = f.gateway.client.api.getMockImplementation()!;
    f.gateway.client.api.mockImplementation(async (method, path, body) => { if (path === "/api/fs/get") throw new OpenListApiError(500, 200, "not-found"); return original(method, path, body); });
    await expect(f.provider.stat(source(ref))).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    expect(f.gateway.client.api).toHaveBeenCalledWith("POST", "/api/fs/list", expect.objectContaining({ refresh: true, per_page: 100 }));
    f.gateway.client.api.mockImplementation(async (method, path, body) => { if (path === "/api/fs/get") throw new OpenListApiError(404, 404, "not-found"); return original(method, path, body); });
    await expect(f.provider.stat(source(ref))).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    f.state.entries = []; await expect(f.provider.stat(source(ref))).rejects.toMatchObject({ code: "REMOTE_NOT_FOUND" });
    f.state.entries = Array.from({ length: 101 }, (_, i) => file(`${i}.txt`));
    f.gateway.client.api.mockImplementation(async (method, path, body) => { if (path === "/api/fs/get") throw new OpenListApiError(500, 200, "not-found"); if (path === "/api/fs/list" && body.page === 2) throw new CloudError("NETWORK_UNAVAILABLE"); return original(method, path, body); });
    await expect(f.provider.stat(source(ref))).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    f.state.failure = new OpenListApiError(500, 200, "not-found"); await expect(f.provider.stat(source(ref))).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
  });
  it("新版 Cookie 只通过私有回调更新；新私有实例可从权威凭据重建", async () => {
    const first = fixture(), ref = binding(); await first.provider.validateCredential({ binding: ref, cookie: "fixture-cookie" });
    const storage = [...first.storages.values()][0]!; storage.addition = JSON.stringify({ cookie: "fixture-refreshed-cookie" });
    await first.provider.stat(source(ref)); expect(first.refreshed).toHaveBeenCalledWith(ref, "fixture-refreshed-cookie");
    const rebuilt = fixture(); await rebuilt.provider.validateCredential({ binding: ref, cookie: "fixture-refreshed-cookie" });
    expect((await rebuilt.provider.stat(source(ref))).version?.kind).toBe("weak");
    await rebuilt.provider.disconnect(ref); await expect(rebuilt.provider.stat(source(ref))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
  it("错误账号引用和传输前版本变化均在发放租约前拒绝", async () => {
    const { provider } = fixture(), ref = binding(); await provider.validateCredential({ binding: ref, cookie: "fixture-cookie" });
    await expect(provider.stat(source({ ...ref, accountId: randomUUID() }))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(provider.acquireSource({ ...source(ref), expectedVersion: { kind: "weak", size: 999, modifiedAt: null } })).rejects.toMatchObject({ code: "REMOTE_CHANGED" });
  });
});
