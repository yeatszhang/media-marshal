import { describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { NativeProcessOwnership, type NativeIdentity, type ProcessInspector } from "./process-ownership";

const root = resolve("private-fixture"), session = join(root, "sessions", "90b64e6d-1fd8-433c-a928-87bc718654ea");
const binaries = { guardian: resolve("bin/guardian"), openlist: resolve("bin/openlist"), rclone: resolve("bin/rclone") };
const processOf = (pid: number, program: keyof typeof binaries): NativeIdentity => ({ pid, parent: program === "guardian" ? 10 : 20, created: "2026-10-24T00:00:00", executable: binaries[program], command: `${binaries[program]} ${program === "guardian" ? "--runtime-root=" : "--config "}${session}` });
function fixture(entries: NativeIdentity[]) {
  const living = new Map(entries.map((entry) => [entry.pid, entry]));
  const inspector: ProcessInspector = {
    identify: vi.fn(async (pid) => living.get(pid)), candidates: vi.fn(async () => [...living.values()]),
    kill: vi.fn(async (identity) => { living.delete(identity.pid); }),
  };
  return { owner: new NativeProcessOwnership(root, binaries, inspector), inspector, living };
}
describe("原生进程的 OS 所有权", () => {
  it("先停止守护，再核验并清理未曾送达启动消息的旧孩子", async () => {
    const { owner, inspector, living } = fixture([processOf(21, "rclone"), processOf(20, "guardian"), processOf(22, "openlist")]);
    await owner.reap();
    expect(living.size).toBe(0);
    expect(vi.mocked(inspector.kill).mock.calls[0]![0].pid).toBe(20);
    expect(inspector.candidates).toHaveBeenCalledTimes(2);
  });
  it("同一命令标识但可执行程序不匹配时不杀进程，并阻止接管", async () => {
    const { owner, inspector } = fixture([{ ...processOf(21, "rclone"), executable: resolve("foreign/rclone") }]);
    await expect(owner.reap()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(inspector.kill).not.toHaveBeenCalled();
  });
  it("OS 查询失败不算已退出，伪造父子关系不能登记", async () => {
    const { owner, inspector } = fixture([processOf(20, "guardian")]);
    await expect(owner.register("guardian", 20, 999, binaries.guardian)).rejects.toMatchObject({ code: "CONFLICT" });
    vi.mocked(inspector.candidates).mockRejectedValue(new Error("OS 查询不可用"));
    await expect(owner.reap()).rejects.toThrow();
    expect(inspector.kill).not.toHaveBeenCalled();
  });
  it("退出消息必须经 OS 核验，PID 被复用后不会继承旧所有权", async () => {
    const { owner, living } = fixture([processOf(20, "guardian")]);
    await owner.register("guardian", 20, 10, binaries.guardian);
    await expect(owner.stopped("guardian")).rejects.toMatchObject({ code: "CONFLICT" });
    living.set(20, { ...processOf(20, "guardian"), created: "later" });
    await owner.stopped("guardian"); expect(owner.parent("guardian")).toBeUndefined();
  });
});
