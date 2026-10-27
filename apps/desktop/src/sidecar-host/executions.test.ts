import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ExecutionUncertainError, type TransferPlan, type ExecutionContext, type TransferEvent } from "@media-marshal/contracts/internal";
import { StaticTransferRegistry } from "./registry";
import { FakeDriveProvider, FakeTransferEngine } from "./testing/fakes";
import { HostExecutions } from "./executions";
function fixture() {
  const provider = new FakeDriveProvider(), engine = new FakeTransferEngine(), registry = new StaticTransferRegistry([provider], [engine]);
  const binding = { accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID() }, attemptId = randomUUID();
  const plan: TransferPlan = { attemptId, targetGrantId: randomUUID(), items: [{ itemId: randomUUID(), source: { binding, remoteRef: randomUUID(), locator: { kind: "stable-id", objectKey: "opaque-object" }, expectedVersion: null }, targetSegments: ["sample.txt"], expectedSize: 10 }] };
  const context: ExecutionContext = { attemptId, bindingGeneration: binding.generation, coreGeneration: randomUUID(), hostGeneration: randomUUID() };
  const events: TransferEvent[] = [], host = new HostExecutions(registry, () => provider.implementationId, async () => "/synthetic/staging", ({ event }) => events.push(event));
  return { provider, engine, plan, context, host, events };
}
describe("宿主长传输的句柄、停止与未知状态", () => {
  it("先返回稳定句柄，准备期间重复 start 共享原执行，后续输入变化不改变快照", async () => {
    const f = fixture(); let release!: () => void;
    vi.spyOn(f.provider, "acquireSource").mockImplementation(async (input) => { await new Promise<void>((resolve) => { release = resolve; }); return { leaseId: randomUUID(), generation: input.binding.generation, kind: "webdav", endpoint: "http://127.0.0.1:5244/dav/", root: "/", credentialHandle: randomUUID(), file: { remoteRef: input.remoteRef, segments: ["sample.txt"] } }; });
    const start = vi.spyOn(f.engine, "start"), handle = f.host.start(f.plan, f.context);
    expect(f.host.start(f.plan, f.context)).toEqual(handle); expect(f.host.status(f.plan.attemptId).state).toBe("RUNNING");
    await vi.waitFor(() => expect(release).toBeTypeOf("function")); f.plan.items[0]!.targetSegments[0] = "changed.txt"; release();
    await vi.waitFor(() => expect(f.host.status(f.plan.attemptId).state).toBe("EXITED"));
    expect(start).toHaveBeenCalledTimes(1); expect(start.mock.calls[0]![0].plan.items[0]!.targetSegments).toEqual(["sample.txt"]);
    expect(f.provider.released).toBe(1); expect(f.events.at(-1)).toMatchObject({ type: "exited", exitCode: 0 });
    await f.host.dispose();
  });
  it("准备租约期间停止后不启动原生写入，停止应答等待清理完成", async () => {
    const f = fixture(); let release!: () => void;
    const original = f.provider.acquireSource.bind(f.provider);
    vi.spyOn(f.provider, "acquireSource").mockImplementation(async (input) => { await new Promise<void>((resolve) => { release = resolve; }); return original(input); });
    const handle = f.host.start(f.plan, f.context); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const stopping = f.host.stop(handle); expect(f.host.status(f.plan.attemptId).state).toBe("RUNNING"); release(); await stopping;
    expect(f.engine.starts).toBe(0); expect(f.host.status(f.plan.attemptId).state).toBe("STOPPED"); expect(f.provider.released).toBe(1);
  });
  it("未知写入者不能被标为退出，也不能释放旧授权或领取同账号新执行", async () => {
    const f = fixture(); vi.spyOn(f.engine, "start").mockRejectedValue(new ExecutionUncertainError());
    const handle = f.host.start(f.plan, f.context); await vi.waitFor(() => expect(f.host.status(f.plan.attemptId).state).toBe("UNCERTAIN"));
    expect(f.provider.released).toBe(0); expect(f.events.some((event) => event.type === "exited")).toBe(false);
    await expect(f.host.stop(handle)).rejects.toBeInstanceOf(ExecutionUncertainError);
    const attemptId = randomUUID(); expect(() => f.host.start({ ...f.plan, attemptId }, { ...f.context, attemptId })).toThrow();
  });
  it("事件流中断必须先停止执行；无法确认停止时保持未知状态", async () => {
    const f = fixture(); vi.spyOn(f.engine, "events").mockImplementation(async function* () { throw new Error("合成事件失败"); });
    vi.spyOn(f.engine, "stop").mockRejectedValue(new ExecutionUncertainError());
    f.host.start(f.plan, f.context); await vi.waitFor(() => expect(f.host.status(f.plan.attemptId).state).toBe("UNCERTAIN"));
    expect(f.engine.stop).toHaveBeenCalledOnce(); expect(f.provider.released).toBe(0);
  });
});
