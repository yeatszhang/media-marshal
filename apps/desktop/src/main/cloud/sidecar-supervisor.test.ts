import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const { fork } = vi.hoisted(() => ({ fork: vi.fn(() => { throw new Error("不应启动宿主"); }) }));
vi.mock("electron", () => ({ utilityProcess: { fork }, MessageChannelMain: class {} }));
import { SidecarSupervisor } from "./sidecar-supervisor";

describe("Main 的按需宿主入口", () => {
  it("空账号列表不 fork、不要求已安装组件，核心仍可挂接", async () => {
    const supervisor = new SidecarSupervisor({ workerPath: "/not-present", appPath: "/not-present", resourceRoot: "/not-present", privateRoot: "/not-present" });
    supervisor.attachCore(randomUUID(), () => {});
    await supervisor.start([]); await supervisor.stop();
    expect(fork).not.toHaveBeenCalled();
  });
  it("资源清单缺失时在 fork 前拒绝，不执行系统同名工具", async () => {
    const supervisor = new SidecarSupervisor({ workerPath: "/not-present", appPath: "/not-present", resourceRoot: "/not-present", privateRoot: "/not-present" });
    supervisor.attachCore(randomUUID(), () => {});
    await expect(supervisor.start([{ accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID(), implementationId: "test.drive" }])).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
    expect(fork).not.toHaveBeenCalled();
  });
});
