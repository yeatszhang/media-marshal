import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { CoreHostBridge } from "@media-marshal/contracts/internal/rpc";
import { PROTOCOL_VERSION } from "@media-marshal/contracts";

interface TestChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  alive: boolean;
  killExits: boolean;
  graceful: boolean;
}
interface TestPort extends EventEmitter { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
const harness = vi.hoisted(() => ({ children: [] as TestChild[], ports: [] as TestPort[], autoReady: true, fork: vi.fn() }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  harness.fork.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), alive: true, killExits: true, graceful: true,
      kill: vi.fn(), postMessage: vi.fn(),
    });
    child.once("exit", () => { child.alive = false; });
    child.kill.mockImplementation(() => { if (child.alive && child.killExits) child.emit("exit", 1); });
    harness.children.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  return {
    utilityProcess: { fork: harness.fork },
    MessageChannelMain: class {
      port1: TestPort;
      port2 = {};
      constructor() {
        const child = harness.children.at(-1)!;
        this.port1 = Object.assign(new EventEmitter(), { postMessage: vi.fn(), close: vi.fn(), start: vi.fn() });
        const port = this.port1;
        port.postMessage.mockImplementation((message) => {
          if (message.kind === "shutdown" && child.alive && child.graceful) queueMicrotask(() => child.emit("exit", 0));
        });
        child.postMessage.mockImplementation((message) => {
          if (message.kind === "initialize" && harness.autoReady) queueMicrotask(() => port.emit("message", { data: { kind: "ready", protocolVersion: PROTOCOL_VERSION } }));
        });
        harness.ports.push(port);
      }
    },
  };
});
import { CoreSupervisor } from "./core-supervisor";

const supervisors: CoreSupervisor[] = [];
function fixture(bridge?: CoreHostBridge) {
  const supervisor = new CoreSupervisor("/fixture/worker.js", "/fixture/profile", bridge);
  supervisors.push(supervisor);
  return supervisor;
}
beforeEach(() => { vi.useFakeTimers(); harness.autoReady = true; harness.fork.mockClear(); harness.children.length = 0; harness.ports.length = 0; });
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    const stopped = supervisor.stop();
    for (const child of harness.children) if (child.alive) child.emit("exit", 0);
    await stopped;
  }
  vi.useRealTimers();
});

describe("Core 生命周期与恢复栅栏", () => {
  it("原生资源仅进入初始化私有通道，资源准备期间停止后不能拉起迟到核心", async () => {
    const launch = { manifestPath: "/fixture/resources/native-files/manifest.json", manifestSha256: "a".repeat(64) }, supervisor = new CoreSupervisor("/fixture/worker.js", "/fixture/profile", undefined, undefined, async () => launch); supervisors.push(supervisor); await supervisor.start();
    expect(harness.children[0]!.postMessage.mock.calls[0]![0]).toMatchObject({ kind: "initialize", nativeFiles: launch }); await supervisor.stop();
    let release!: (value: typeof launch) => void; const late = new CoreSupervisor("/fixture/worker.js", "/fixture/profile", undefined, undefined, () => new Promise((done) => { release = done; })); supervisors.push(late); const starting = expect(late.start()).rejects.toMatchObject({ code: "INTERRUPTED" }); await vi.waitFor(() => expect(release).toBeTypeOf("function")); await late.stop(); release(launch); await starting; expect(harness.fork).toHaveBeenCalledTimes(1);
  });
  it("启动前备份失败不创建 Core，显式重启重新检查且不能绕过失败", async () => {
    const supervisor = fixture(), check = vi.fn(async () => { throw new Error("模拟备份不可写"); }); supervisor.beforeStart = check;
    await expect(supervisor.start()).rejects.toThrow("模拟备份不可写");
    expect(supervisor.state).toBe("failed"); expect(harness.fork).not.toHaveBeenCalled();
    await expect(supervisor.request("sources.list", {})).rejects.toMatchObject({ code: "CORE_UNAVAILABLE" });
    await expect(supervisor.restart()).rejects.toThrow("模拟备份不可写"); expect(check).toHaveBeenCalledTimes(2); expect(harness.fork).not.toHaveBeenCalled();
    supervisor.beforeStart = vi.fn(async () => {}); await supervisor.restart(); expect(harness.fork).toHaveBeenCalledTimes(1); expect(supervisor.state).toBe("ready");
    harness.children[0]!.emit("exit", 1); await vi.advanceTimersByTimeAsync(1000); expect(supervisor.beforeStart).toHaveBeenCalledTimes(2); expect(harness.fork).toHaveBeenCalledTimes(2);
  });
  it("备份检查期间退出后，迟到检查成功也不能创建 Core", async () => {
    const supervisor = fixture(); let release!: () => void;
    supervisor.beforeStart = () => new Promise<void>((resolve) => { release = resolve; });
    const starting = expect(supervisor.start()).rejects.toMatchObject({ code: "INTERRUPTED" });
    await supervisor.stop(); release(); await starting; expect(harness.fork).not.toHaveBeenCalled(); expect(supervisor.state).toBe("stopping");
  });
  it("停止期间迟到握手不能恢复 ready，强杀确认退出后才允许显式恢复", async () => {
    harness.autoReady = false;
    const supervisor = fixture(); supervisor.onReady = vi.fn(async () => {});
    const starting = expect(supervisor.start()).rejects.toMatchObject({ code: "CORE_UNAVAILABLE" });
    await vi.waitFor(() => expect(harness.children).toHaveLength(1));
    const child = harness.children[0]!; child.graceful = false; child.killExits = false;
    const stopped = supervisor.stop();
    harness.ports[0]!.emit("message", { data: { kind: "ready", protocolVersion: PROTOCOL_VERSION } });
    await starting; expect(supervisor.onReady).not.toHaveBeenCalled(); expect(supervisor.state).toBe("stopping");
    await vi.advanceTimersByTimeAsync(8000); expect(child.kill).toHaveBeenCalled();
    child.emit("exit", 1); await stopped; await vi.advanceTimersByTimeAsync(60000);
    expect(harness.fork).toHaveBeenCalledTimes(1);
    harness.autoReady = true; await supervisor.restart();
    expect(harness.fork).toHaveBeenCalledTimes(2); expect(supervisor.state).toBe("ready"); expect(supervisor.onReady).toHaveBeenCalledTimes(1);
  });
  it.each(["协议不符", "握手超时"])("%s 后确认旧核心退出前不启动第二个实例", async (mode) => {
    harness.autoReady = false;
    const supervisor = fixture(), starting = expect(supervisor.start()).rejects.toMatchObject({ code: mode === "握手超时" ? "TIMEOUT" : "CORE_UNAVAILABLE" });
    await vi.waitFor(() => expect(harness.ports).toHaveLength(1));
    const child = harness.children[0]!; child.killExits = false;
    if (mode === "握手超时") await vi.advanceTimersByTimeAsync(15000);
    else harness.ports[0]!.emit("message", { data: { kind: "ready", protocolVersion: PROTOCOL_VERSION + 1 } });
    await starting;
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(supervisor.start()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.fork).toHaveBeenCalledTimes(1);
    child.emit("exit", 1); harness.autoReady = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.fork).toHaveBeenCalledTimes(2); expect(supervisor.state).toBe("ready");
  });

  it("崩溃立即中断等待的写请求，宿主回收完成后才恢复且不重放命令", async () => {
    let release!: () => void;
    const reaped = new Promise<void>((resolve) => { release = resolve; });
    const bridge: CoreHostBridge = { generation: randomUUID(), attachCore: vi.fn(), receiveCore: vi.fn(() => false), detachCore: vi.fn(() => reaped) };
    const supervisor = fixture(bridge); supervisor.onReady = vi.fn(async () => {}); await supervisor.start();
    const port = harness.ports[0]!, pending = expect(supervisor.request("settings.save", { language: "zh-CN", embyUrl: "", tmdbProxy: "" })).rejects.toMatchObject({ code: "INTERRUPTED" });
    const original = port.postMessage.mock.calls.find(([value]) => value.kind === "request")![0];
    harness.children[0]!.emit("exit", 1); await pending;
    await vi.advanceTimersByTimeAsync(10000);
    expect(harness.fork).toHaveBeenCalledTimes(1);
    release(); await vi.advanceTimersByTimeAsync(1000);
    expect(harness.fork).toHaveBeenCalledTimes(2); expect(supervisor.onReady).toHaveBeenCalledTimes(2);
    port.emit("message", { data: { kind: "response", protocolVersion: PROTOCOL_VERSION, requestId: original.requestId, ok: true, result: {} } });
    expect(harness.ports[1]!.postMessage.mock.calls.filter(([value]) => value.kind === "request")).toEqual([]);
  });

  it.each(["公共", "私有"])("%s请求执行等待超时向原核心发送严格取消收据，不重放原动作", async (kind) => {
    const supervisor = fixture(); await supervisor.start(); const port = harness.ports[0]!;
    const response = expect(kind === "公共" ? supervisor.request("settings.save", { language: "zh-CN", embyUrl: "", tmdbProxy: "" }) : supervisor.requestPrivate("media.observations.reset", {})).rejects.toMatchObject({ code: "TIMEOUT" });
    const request = port.postMessage.mock.calls.find(([value]) => ["request", "core.private.request"].includes(value.kind))![0];
    await vi.advanceTimersByTimeAsync(15000); await response;
    expect(port.postMessage.mock.calls.filter(([value]) => value.kind === "core.request.cancel").map(([value]) => value)).toEqual([{ kind: "core.request.cancel", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, reason: "TIMEOUT" }]);
    port.emit("message", { data: kind === "公共" ? { kind: "response", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, ok: true, result: {} } : { kind: "core.private.response", requestId: request.requestId, ok: true, result: {} } });
    expect(port.postMessage.mock.calls.filter(([value]) => ["request", "core.private.request"].includes(value.kind))).toHaveLength(1);
  });
  it("取消仅对应原等待，发送前取消不发消息，成功和核心中断均解除信号监听", async () => {
    const supervisor = fixture(); await supervisor.start(); const port = harness.ports[0]!, before = new AbortController(); before.abort();
    await expect(supervisor.request("settings.get", {}, before.signal)).rejects.toMatchObject({ code: "INTERRUPTED" }); expect(port.postMessage.mock.calls.filter(([value]) => value.kind === "request")).toHaveLength(0);
    const controller = new AbortController(), response = expect(supervisor.requestPrivate("media.observations.reset", {}, controller.signal)).rejects.toMatchObject({ code: "INTERRUPTED" }); controller.abort(); await response;
    const successful = new AbortController(), result = supervisor.request("settings.get", {}, successful.signal), request = port.postMessage.mock.calls.filter(([value]) => value.kind === "request").at(-1)![0];
    port.emit("message", { data: { kind: "response", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, ok: true, result: { language: "zh-CN", embyUrl: "", tmdbProxy: "" } } }); await result; successful.abort();
    const interrupted = new AbortController(), pending = expect(supervisor.request("settings.get", {}, interrupted.signal)).rejects.toMatchObject({ code: "INTERRUPTED" }); harness.children[0]!.emit("exit", 1); await pending; interrupted.abort();
    expect(port.postMessage.mock.calls.filter(([value]) => value.kind === "core.request.cancel")).toHaveLength(1);
  });

  it("自动恢复最多三次，达到上限保留失败状态，由显式重启重新开始", async () => {
    const supervisor = fixture(); await supervisor.start();
    for (let attempt = 1; attempt <= 3; attempt++) {
      harness.children.at(-1)!.emit("exit", 1); await vi.advanceTimersByTimeAsync(attempt * 1000);
      expect(harness.fork).toHaveBeenCalledTimes(attempt + 1); expect(supervisor.state).toBe("ready");
    }
    harness.children.at(-1)!.emit("exit", 1); await vi.advanceTimersByTimeAsync(60000);
    expect(harness.fork).toHaveBeenCalledTimes(4); expect(supervisor.state).toBe("failed");
    await supervisor.restart(); expect(harness.fork).toHaveBeenCalledTimes(5); expect(supervisor.state).toBe("ready");
  });

  it("旧宿主停止结果不确定时阻断自动恢复", async () => {
    const bridge: CoreHostBridge = { generation: randomUUID(), attachCore: vi.fn(), receiveCore: vi.fn(() => false), detachCore: vi.fn(async () => { throw new Error("停止证据缺失"); }) };
    const supervisor = fixture(bridge); await supervisor.start(); harness.children[0]!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(harness.fork).toHaveBeenCalledTimes(1); expect(supervisor.state).toBe("failed"); expect(supervisor.detail).toContain("停止");
  });

  it("请求等待超时不撤销执行、不重发，迟到结果不占用后续请求", async () => {
    const supervisor = fixture(); await supervisor.start(); const port = harness.ports[0]!;
    const pending = expect(supervisor.request("settings.save", { language: "zh-CN", embyUrl: "", tmdbProxy: "" })).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(15000); await pending;
    expect(port.postMessage.mock.calls.filter(([value]) => value.kind === "request")).toHaveLength(1);
    const query = supervisor.request("sources.list", {}), request = port.postMessage.mock.calls.filter(([value]) => value.kind === "request").at(-1)![0];
    port.emit("message", { data: { kind: "response", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, ok: true, result: [] } });
    await expect(query).resolves.toEqual([]); expect(harness.fork).toHaveBeenCalledTimes(1);
  });
});
