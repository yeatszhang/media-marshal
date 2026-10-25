import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { IpcMain, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RENDERER_PREPARE_RELOAD_CHANNEL, RENDERER_RELOAD_RESULT_CHANNEL } from "@media-marshal/contracts";
import { RendererReloadController } from "./renderer-reload";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); });
function fixture() {
  const ipc = new EventEmitter(), contents = Object.assign(new EventEmitter(), {
    mainFrame: { url: "marshal://app/index.html#/sources" }, isDestroyed: vi.fn(() => false), isCrashed: vi.fn(() => false),
    getURL: vi.fn(() => "marshal://app/index.html#/sources"), send: vi.fn(), reload: vi.fn(), reloadIgnoringCache: vi.fn(),
  });
  let enabled = true; const controller = new RendererReloadController(contents as unknown as WebContents, ipc as IpcMain, () => enabled, undefined, 1000); cleanup.push(() => controller.dispose());
  const id = () => contents.send.mock.calls.at(-1)![1].id as string;
  const reply = (value: unknown = { id: id(), state: "prepared" }, sender: unknown = contents, frame: unknown = contents.mainFrame) => ipc.emit(RENDERER_RELOAD_RESULT_CHANNEL, { sender, senderFrame: frame }, value);
  return { controller, contents, ipc, id, reply, disable: () => { enabled = false; } };
}
describe("当前主窗口受控重载", () => {
  it("等待精确窗口、顶层 frame 与 nonce 的有效收据，并发触发只清理及重载一次", async () => {
    const f = fixture(), first = f.controller.request(); expect(f.controller.request(true)).toBe(first);
    expect(f.contents.send).toHaveBeenCalledTimes(1); expect(f.contents.send).toHaveBeenCalledWith(RENDERER_PREPARE_RELOAD_CHANNEL, { id: f.id() });
    f.reply({ id: randomUUID(), state: "prepared" }); f.reply(undefined, {}); f.reply(undefined, f.contents, { url: "marshal://app/index.html" });
    f.reply({ id: f.id(), state: "prepared", command: "任意动作" }); f.reply({ id: f.id(), state: "prepared", error: "x".repeat(70000) });
    expect(f.contents.reload).not.toHaveBeenCalled(); f.reply(); await first; f.reply(); expect(f.contents.reload).toHaveBeenCalledOnce(); expect(f.contents.reloadIgnoringCache).not.toHaveBeenCalled();
  });
  it("清理失败或超时不刷新，旧收据不完成新请求；忽略缓存仍经过握手", async () => {
    vi.useFakeTimers(); const f = fixture(), failed = f.controller.request(); const failedCheck = expect(failed).rejects.toThrow("清理未完成"); f.reply({ id: f.id(), state: "failed" }); await failedCheck;
    const timed = f.controller.request(), old = f.id(), timedCheck = expect(timed).rejects.toThrow("清理超时"); await vi.advanceTimersByTimeAsync(1000); await timedCheck;
    const next = f.controller.request(true); f.reply({ id: old, state: "prepared" }); expect(f.contents.reloadIgnoringCache).not.toHaveBeenCalled(); f.reply(); await next;
    expect(f.contents.reload).not.toHaveBeenCalled(); expect(f.contents.reloadIgnoringCache).toHaveBeenCalledOnce();
  });
  it("完整导航使旧请求失效，同文档和子 frame 导航不撤销当前请求", async () => {
    const f = fixture(), first = f.controller.request(), check = expect(first).rejects.toThrow("界面已导航");
    f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true }); f.contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(f.controller.request()).toBe(first); f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }); await check;
    const oldFrame = f.contents.mainFrame; f.contents.mainFrame = { url: "marshal://app/index.html" }; const next = f.controller.request(); f.reply(undefined, f.contents, oldFrame); expect(f.contents.reload).not.toHaveBeenCalled(); f.reply(); await next;
  });
  it("应用停写或窗口销毁拒绝待确认重载，移除全部生命周期监听", async () => {
    const f = fixture(), first = f.controller.request(), check = expect(first).rejects.toThrow("正在停止"); f.disable(); f.reply(); await check; expect(f.contents.reload).not.toHaveBeenCalled();
    const g = fixture(), pending = g.controller.request(), pendingCheck = expect(pending).rejects.toThrow("界面已关闭"); g.contents.emit("destroyed"); await pendingCheck;
    expect(g.ipc.listenerCount(RENDERER_RELOAD_RESULT_CHANNEL)).toBe(0); expect(g.contents.listenerCount("did-start-navigation")).toBe(0); expect(g.contents.listenerCount("render-process-gone")).toBe(0);
    await expect(g.controller.request()).rejects.toThrow("正在停止"); g.reply(); expect(g.contents.reload).not.toHaveBeenCalled();
  });
  it("Electron 确认进程中断后才允许独立恢复，不将超时当作崩溃", async () => {
    const f = fixture(), pending = f.controller.request(), check = expect(pending).rejects.toThrow("进程已中断"); f.contents.isCrashed.mockReturnValue(true); f.contents.emit("render-process-gone"); await check;
    await f.controller.request(); expect(f.contents.send).toHaveBeenCalledOnce(); expect(f.contents.reload).toHaveBeenCalledOnce();
  });
  it("不可信地址不能发起或完成重载，发送失败结束当前握手", async () => {
    const f = fixture(); f.contents.getURL.mockReturnValue("https://untrusted.example"); await expect(f.controller.request()).rejects.toThrow("不可信页面"); expect(f.contents.send).not.toHaveBeenCalled();
    f.contents.getURL.mockReturnValue("marshal://app/index.html"); const pending = f.controller.request(); f.contents.mainFrame.url = "https://untrusted.example"; f.reply(); expect(f.contents.reload).not.toHaveBeenCalled(); f.contents.mainFrame.url = "marshal://app/index.html"; f.reply(); await pending;
    f.contents.send.mockImplementationOnce(() => { throw new Error("底层敏感错误"); }); await expect(f.controller.request()).rejects.toThrow("无法联系当前界面"); expect(f.contents.reload).toHaveBeenCalledOnce();
  });
});
