import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createSidecarApplication } from "./application";
const binding = () => ({ accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID(), implementationId: "test.drive" });
describe("独立 SidecarHost Application", () => {
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
    runtime.installCredential(configured, "fixture-cookie-secret");
    expect(runtime.readCredential(configured)).toBe("fixture-cookie-secret");
    const changed = { ...configured, bindingId: randomUUID(), generation: randomUUID() }; runtime.installCredential(changed, "rotated-fixture-secret");
    expect(() => runtime.readCredential(configured)).toThrow();
    expect(runtime.readCredential(changed)).toBe("rotated-fixture-secret");
    const response = await runtime.dispatch({ kind: "host.request", protocolVersion: 1, requestId: randomUUID(), idempotencyKey: randomUUID(), context: { coreGeneration, hostGeneration, bindingGeneration: configured.generation, attemptId: randomUUID() }, action: "provider.capabilities", payload: { accountId: configured.accountId, bindingId: configured.bindingId, generation: configured.generation } });
    expect(response).toMatchObject({ ok: false, error: { code: "INTERRUPTED" } });
    runtime.dropCredential(configured.accountId);
    expect(() => runtime.readCredential(changed)).toThrow();
    await runtime.stop();
  });
});
