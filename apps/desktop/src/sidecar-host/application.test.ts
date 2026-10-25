import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createSidecarApplication } from "./application";
import { FakeDriveProvider } from "./testing/fakes";
import { bindingRefSchema } from "@media-marshal/contracts/internal";
const binding = () => ({ accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID(), implementationId: "test.drive" });
describe("独立 SidecarHost Application", () => {
  it("宿主绑定先转换为严格 Provider 引用，不能混入实现选择字段", async () => {
    const configured = binding(), provider = new FakeDriveProvider();
    vi.spyOn(provider, "validateCredential").mockImplementation(async (input) => { bindingRefSchema.parse(input.binding); return { stableKey: null }; });
    const capability = vi.spyOn(provider, "capabilities");
    const runtime = createSidecarApplication({ hostGeneration: randomUUID(), coreGeneration: randomUUID(), bindings: [configured], providers: [provider], resolver: { resolve: async () => ({ guardian: "/g", openlist: "/o", rclone: "/r" }) } });
    await runtime.app.start(); await runtime.installCredential(configured, "fixture-secret");
    expect(capability).toHaveBeenCalledWith({ accountId: configured.accountId, bindingId: configured.bindingId, generation: configured.generation });
    await runtime.stop();
  });
  it("私有凭据轮换期间拒绝新传输，不能穿过账号静止窗口", async () => {
    const configured = binding(), provider = new FakeDriveProvider(); let release!: () => void;
    vi.spyOn(provider, "validateCredential").mockImplementation(async () => { await new Promise<void>((done) => { release = done; }); return { stableKey: null }; });
    const hostGeneration = randomUUID(), coreGeneration = randomUUID(), runtime = createSidecarApplication({ hostGeneration, coreGeneration, bindings: [configured], providers: [provider], resolver: { resolve: async () => ({ guardian: "/g", openlist: "/o", rclone: "/r" }) } });
    await runtime.app.start(); const installing = runtime.installCredential(configured, "fixture-secret"); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const attemptId = randomUUID(), { implementationId: _, ...ref } = configured;
    const response = await runtime.dispatch({ kind: "host.request", protocolVersion: 1, requestId: randomUUID(), idempotencyKey: attemptId, action: "transfer.start", context: { hostGeneration, coreGeneration, bindingGeneration: configured.generation, attemptId }, payload: { attemptId, targetGrantId: randomUUID(), items: [{ itemId: randomUUID(), source: { binding: ref, remoteRef: randomUUID(), locator: { kind: "path", segments: ["sample.txt"] }, expectedVersion: null }, targetSegments: ["sample.txt"], expectedSize: 10 }] } });
    expect(response).toMatchObject({ ok: false, error: { code: "INTERRUPTED" } }); expect(provider.acquired).toBe(0);
    release(); await installing; await runtime.stop();
  });
  it("关闭期间迟到的授权结果不能重新发布绑定或秘密", async () => {
    const configured = binding(), provider = new FakeDriveProvider();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), observed = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(provider, "validateCredential").mockImplementation(async () => { entered(); await gate; return { stableKey: null }; });
    const runtime = createSidecarApplication({ hostGeneration: randomUUID(), coreGeneration: randomUUID(), bindings: [configured], providers: [provider], resolver: { resolve: async () => ({ guardian: "/g", openlist: "/o", rclone: "/r" }) } });
    await runtime.app.start();
    const install = runtime.installCredential(configured, "fixture-secret"); await observed;
    const closing = runtime.stop(); release();
    await expect(install).rejects.toMatchObject({ code: "INTERRUPTED" }); await closing;
    expect(() => runtime.readCredential(configured)).toThrow();
  });
  it("未配置账号时不解析或启动外部组件", async () => {
    const resolve = vi.fn(async () => { throw new Error("不应访问资源"); });
    const runtime = createSidecarApplication({ hostGeneration: randomUUID(), coreGeneration: randomUUID(), bindings: [], resolver: { resolve } });
    await runtime.app.start(); expect(resolve).not.toHaveBeenCalled(); await runtime.stop();
  });
  it("下游初始化失败时回收已登记的组件资源", async () => {
    const disposed = vi.fn();
    const runtime = createSidecarApplication({ hostGeneration: randomUUID(), coreGeneration: randomUUID(), bindings: [binding()], resolver: { resolve: vi.fn(async () => ({ guardian: "/g", openlist: "/o", rclone: "/r" })) }, modules: [
      { id: "test.first", dependencies: ["sidecar.resources"], start(ctx) { ctx.disposables.add(disposed); } },
      { id: "test.failure", dependencies: ["test.first"], start() { throw new Error("组件初始化失败"); } },
    ] });
    await expect(runtime.app.start()).rejects.toThrow("组件初始化失败");
    expect(disposed).toHaveBeenCalledOnce(); expect(runtime.app.state).toBe("failed");
    await runtime.stop();
  });
  it("凭据仅在当前绑定的私有内存中读取，轮换与解除撤销旧引用", async () => {
    const configured = binding();
    const hostGeneration = randomUUID(), coreGeneration = randomUUID();
    const runtime = createSidecarApplication({ hostGeneration, coreGeneration, bindings: [configured], resolver: { resolve: async () => ({ guardian: "/g", openlist: "/o", rclone: "/r" }) } });
    await runtime.app.start();
    await runtime.installCredential(configured, "fixture-cookie-secret");
    expect(runtime.readCredential(configured)).toBe("fixture-cookie-secret");
    const changed = { ...configured, bindingId: randomUUID(), generation: randomUUID() }; await runtime.installCredential(changed, "rotated-fixture-secret");
    expect(() => runtime.readCredential(configured)).toThrow();
    expect(runtime.readCredential(changed)).toBe("rotated-fixture-secret");
    const response = await runtime.dispatch({ kind: "host.request", protocolVersion: 1, requestId: randomUUID(), idempotencyKey: randomUUID(), context: { coreGeneration, hostGeneration, bindingGeneration: configured.generation, attemptId: randomUUID() }, action: "provider.capabilities", payload: { accountId: configured.accountId, bindingId: configured.bindingId, generation: configured.generation } });
    expect(response).toMatchObject({ ok: false, error: { code: "INTERRUPTED" } });
    await runtime.dropCredential(configured.accountId);
    expect(() => runtime.readCredential(changed)).toThrow();
    await runtime.stop();
  });
});
