import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const fakes = vi.hoisted(() => ({ start: vi.fn(async () => ({ id: "fixture", running: true })), stop: vi.fn(async () => {}), shutdown: vi.fn(async () => {}), ping: vi.fn(async () => false) }));
vi.mock("node:fs/promises", () => ({ writeFile: vi.fn(async () => {}) }));
vi.mock("../../main/cloud/private-files", () => ({ ensurePrivateDirectory: vi.fn(async () => {}), ensurePrivateFile: vi.fn(async () => {}) }));
vi.mock("../guardian", () => ({ ManagedGuardian: class { launch = async () => {}; start = fakes.start; stop = fakes.stop; shutdown = fakes.shutdown; } }));
vi.mock("./client", () => ({ OpenListClient: class { ping = fakes.ping; } }));
import { OpenListRuntime } from "./runtime";

describe("启动时间与重试预算", () => {
  it("子进程存在但服务始终不就绪时有限停止，不保留可用客户端", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new OpenListRuntime({ privateRoot: "/private-fixture", hostGeneration: randomUUID(), binaries: { guardian: "/guardian", openlist: "/openlist", rclone: "/rclone" }, port: async () => 45000 });
      const rejected = expect(runtime.start()).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(10000); await rejected;
      expect(fakes.start).toHaveBeenCalledTimes(3); expect(fakes.stop).toHaveBeenCalledTimes(3); expect(fakes.shutdown).toHaveBeenCalledOnce();
      expect(() => runtime.client).toThrow();
    } finally { vi.useRealTimers(); }
  });
});
