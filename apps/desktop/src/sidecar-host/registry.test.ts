import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { planOnce, advanceDownloadState } from "@media-marshal/media-core";
import { StaticTransferRegistry } from "./registry";
import { FakeDriveProvider, FakeTransferEngine } from "./testing/fakes";
import type { SourceRequest, TransferEvent } from "@media-marshal/contracts/internal";

function source(): SourceRequest { return { binding: { accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID() }, remoteRef: randomUUID(), locator: { kind: "path", segments: ["sample.txt"] }, expectedVersion: null }; }

describe("静态 Provider/Engine 协商", () => {
  it("同一应用计划经过假实现，执行退出后仍等待 Core 文件核对", async () => {
    const provider = new FakeDriveProvider(), engine = new FakeTransferEngine();
    const registry = new StaticTransferRegistry([provider], [engine]);
    const request = source();
    const entry = { ...(await provider.stat(request)), ref: request.remoteRef, parentRef: null };
    const plan = planOnce({ jobId: randomUUID(), requestKey: randomUUID(), attemptId: randomUUID(), binding: request.binding, targetGrantId: randomUUID(), files: [{ entry, locator: request.locator, mapping: { segments: [entry.name], slotKey: "a".repeat(64) } }] });
    const prepared = await registry.prepare("test.drive", request);
    const context = { attemptId: plan.transfer.attemptId, coreGeneration: randomUUID(), hostGeneration: randomUUID(), bindingGeneration: request.binding.generation };
    const handle = await prepared.engine.start({ plan: plan.transfer, context, lease: prepared.lease, stagingDirectory: "/synthetic/not-written" });
    expect(handle.attemptId).toBe(plan.transfer.attemptId);
    expect(advanceDownloadState("QUEUED", "RUNNING", { writerStopped: true, authorized: true, rootAvailable: true })).toBe("RUNNING");
    const events: TransferEvent[] = [];
    for await (const event of engine.events(handle)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "exited", exitCode: 0 });
    expect(advanceDownloadState("RUNNING", "VERIFYING", { writerStopped: true })).toBe("VERIFYING");
    expect(() => advanceDownloadState("VERIFYING", "COMPLETED", { writerStopped: true })).toThrow();
    await Promise.all([prepared.release(), prepared.release()]);
    expect(provider.released).toBe(1); expect(engine.starts).toBe(1);
  });
  it("没有匹配 source kind 时在取得租约与写入之前失败", async () => {
    const provider = new FakeDriveProvider(), engine = new FakeTransferEngine([]);
    const registry = new StaticTransferRegistry([provider], [engine]);
    await expect(registry.prepare("test.drive", source())).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(provider.acquired).toBe(0); expect(engine.starts).toBe(0);
  });
  it("只解析显式注册的实现，未知名称不会动态加载模块或命令", async () => {
    const provider = new FakeDriveProvider(); const registry = new StaticTransferRegistry([provider], []);
    for (const name of ["/tmp/program", "shell.exec", "http://example.com", "not.registered"])
      await expect(registry.prepare(name, source())).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(provider.acquired).toBe(0);
    expect(() => new StaticTransferRegistry([provider, provider], [])).toThrow();
  });
  it("错误代际的租约必须释放，不能交给传输引擎", async () => {
    const provider = new FakeDriveProvider(), engine = new FakeTransferEngine();
    const original = provider.acquireSource.bind(provider);
    vi.spyOn(provider, "acquireSource").mockImplementation(async (input) => ({ ...await original(input), generation: randomUUID() }));
    const registry = new StaticTransferRegistry([provider], [engine]);
    await expect(registry.prepare("test.drive", source())).rejects.toMatchObject({ code: "INTERRUPTED" });
    expect(provider.released).toBe(1); expect(engine.starts).toBe(0);
  });
});
