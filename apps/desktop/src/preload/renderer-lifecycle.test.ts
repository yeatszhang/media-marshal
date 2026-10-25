import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RENDERER_PREPARE_RELOAD_CHANNEL, RENDERER_RELOAD_RESULT_CHANNEL } from "@media-marshal/contracts";
import { rendererReloadBridge } from "./renderer-lifecycle";
function fixture() {
  let receive!: (event: unknown, value: unknown) => void;
  const port = { on: vi.fn((_channel: string, listener: typeof receive) => { receive = listener; }), send: vi.fn() };
  const register = rendererReloadBridge(port); return { register, port, prepare: (value: unknown) => receive({}, value) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
describe("Preload 固定清理握手", () => {
  it("只在异步清理成功后回传固定收据，重复 nonce 不重复调用清理", async () => {
    const f = fixture(), id = randomUUID(); let release!: () => void; const cleanup = vi.fn(() => new Promise<void>((done) => { release = done; })); f.register(cleanup);
    expect(f.port.on).toHaveBeenCalledWith(RENDERER_PREPARE_RELOAD_CHANNEL, expect.any(Function)); f.prepare({ id }); f.prepare({ id }); await flush();
    expect(cleanup).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledWith(); expect(f.port.send).not.toHaveBeenCalled();
    const other = randomUUID(); f.prepare({ id: other }); expect(f.port.send).toHaveBeenCalledWith(RENDERER_RELOAD_RESULT_CHANNEL, { id: other, state: "failed" });
    release(); await flush(); expect(f.port.send).toHaveBeenLastCalledWith(RENDERER_RELOAD_RESULT_CHANNEL, { id, state: "prepared" });
  });
  it("清理失败不传递异常原文，非法请求和缺少注册不能冒认成功", async () => {
    const f = fixture(), id = randomUUID(); f.prepare({ id, action: "任意动作" }); f.prepare({ id: "非法标识" }); expect(f.port.send).not.toHaveBeenCalled();
    f.prepare({ id }); await flush(); expect(f.port.send).toHaveBeenLastCalledWith(RENDERER_RELOAD_RESULT_CHANNEL, { id, state: "failed" });
    f.register(async () => { throw new Error("私有路径与密钥不能出现在握手"); }); f.prepare({ id: randomUUID() }); await flush(); expect(f.port.send.mock.calls.at(-1)![1].state).toBe("failed"); expect(JSON.stringify(f.port.send.mock.calls)).not.toContain("私有路径");
  });
  it("注册唯一、释放幂等，旧释放不能清除新回调，已销毁 IPC 不产生拒绝", async () => {
    const f = fixture(), old = f.register(async () => {}); expect(() => f.register(async () => {})).toThrow("只能注册一个"); old(); old(); const next = vi.fn(async () => {}); f.register(next); old();
    f.port.send.mockImplementation(() => { throw new Error("文档已销毁"); }); expect(() => f.prepare({ id: randomUUID() })).not.toThrow(); await flush(); expect(next).toHaveBeenCalledOnce();
  });
});
