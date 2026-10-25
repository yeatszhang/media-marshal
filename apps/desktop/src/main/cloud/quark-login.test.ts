import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { BrowserWindow, session } from "electron";
import type { CloudAuthorization } from "@media-marshal/contracts";
import { QuarkLoginController } from "./quark-login";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeContents extends EventEmitter {
    setWindowOpenHandler = vi.fn();
  }
  class FakeWindow extends EventEmitter {
    static windows: FakeWindow[] = [];
    webContents = new FakeContents();
    destroyed = false;
    loadURL = vi.fn(async () => {});
    show = vi.fn(); focus = vi.fn();
    constructor(readonly options: unknown) { super(); FakeWindow.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const fromPartition = vi.fn(() => Object.assign(new EventEmitter(), {
    cookies: Object.assign(new EventEmitter(), { get: vi.fn(async () => []) }),
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    getUserAgent: () => "Chrome/144 Electron/44", setUserAgent: vi.fn(),
    clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}),
  }));
  return { BrowserWindow: FakeWindow, session: { fromPartition } };
});

const controllers: QuarkLoginController[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.stop(); vi.clearAllMocks(); vi.useRealTimers(); });
function fixture() {
  const parent = new BrowserWindow(), input = { name: "扫码测试", requestKey: randomUUID() };
  const job: CloudAuthorization = { id: randomUUID(), accountId: randomUUID(), requestKey: input.requestKey, state: "RUNNING", failure: null, updatedAt: new Date().toISOString() };
  const authorize = vi.fn(async () => job), lookup = vi.fn(async (): Promise<CloudAuthorization | null> => null);
  const controller = new QuarkLoginController(authorize, lookup); controllers.push(controller);
  return { parent, input, job, authorize, lookup, controller };
}
async function opened(f: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(session.fromPartition).toHaveBeenCalled());
  const isolated = vi.mocked(session.fromPartition).mock.results.at(-1)!.value as any;
  const login = (BrowserWindow as any).windows.at(-1) as any;
  expect(login).not.toBe(f.parent);
  return { isolated, login };
}
async function signIn(isolated: any) {
  isolated.cookies.get.mockResolvedValue([{ name: "__pus", value: "fixture-private-pus" }, { name: "__puus", value: "fixture-private-puus" }]);
  isolated.cookies.emit("changed");
}

describe("夸克网页登录的 Main 凭据边界", () => {
  it("独立内存会话、安全窗口和目标地址 Cookie；重复活动请求只授权一次", async () => {
    const f = fixture(), first = f.controller.login(f.input, f.parent), second = f.controller.login(f.input, f.parent);
    expect(second).toBe(first);
    const { isolated, login } = await opened(f);
    expect(session.fromPartition).toHaveBeenCalledWith(expect.stringMatching(/^quark-login-/), { cache: false });
    expect(login.options.webPreferences).toMatchObject({ session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
    expect(login.options.webPreferences).not.toHaveProperty("preload");
    expect(isolated.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
    const permission = vi.fn(); isolated.setPermissionRequestHandler.mock.calls[0][0]({}, "media", permission); expect(permission).toHaveBeenCalledWith(false);
    expect(login.webContents.setWindowOpenHandler.mock.calls[0][0]({ url: "https://evil.test" })).toEqual({ action: "deny" });
    for (const address of ["file:///tmp/private", "http://pan.quark.cn", "https://quark.cn.evil.test", "https://user:secret@pan.quark.cn", "https://pan.quark.cn:1234"]) {
      const event = { preventDefault: vi.fn() }; login.webContents.emit("will-navigate", event, address); expect(event.preventDefault).toHaveBeenCalled();
    }
    const allowed = { preventDefault: vi.fn() }; login.webContents.emit("will-redirect", allowed, "https://passport.quark.cn/"); expect(allowed.preventDefault).not.toHaveBeenCalled();
    const download = { preventDefault: vi.fn() }; isolated.emit("will-download", download); expect(download.preventDefault).toHaveBeenCalled();
    await signIn(isolated);
    expect(await first).toEqual(f.job); expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.authorize).toHaveBeenCalledWith({ ...f.input, cookie: "__pus=fixture-private-pus; __puus=fixture-private-puus" });
    expect(isolated.cookies.get).toHaveBeenCalledWith({ url: "https://pan.quark.cn/" });
    expect(JSON.stringify(await second)).not.toContain("fixture-private");
    expect(login.isDestroyed()).toBe(true); expect(isolated.clearStorageData).toHaveBeenCalledOnce(); expect(isolated.clearCache).toHaveBeenCalledOnce();
    expect(isolated.cookies.listenerCount("changed")).toBe(0); expect(f.parent.listenerCount("hide")).toBe(0);
  });

  it("Cookie 分批到达不会漏掉并发变更，且不接受只有一个登录 Cookie", async () => {
    const f = fixture(), result = f.controller.login(f.input, f.parent), { isolated } = await opened(f);
    let read!: (value: unknown) => void;
    isolated.cookies.get.mockImplementationOnce(() => new Promise((resolve) => { read = resolve; }));
    isolated.cookies.emit("changed");
    await signIn(isolated);
    read([{ name: "__pus", value: "incomplete" }]);
    expect(await result).toEqual(f.job); expect(f.authorize).toHaveBeenCalledOnce();
  });

  it("取消只匹配当前请求，关闭后清理会话并允许重新打开", async () => {
    const f = fixture(), result = f.controller.login(f.input, f.parent), { isolated, login } = await opened(f);
    f.controller.cancel(randomUUID()); expect(login.isDestroyed()).toBe(false);
    await expect(f.controller.login({ ...f.input, requestKey: randomUUID() }, f.parent)).rejects.toMatchObject({ code: "CONFLICT" });
    f.controller.cancel(f.input.requestKey); expect(await result).toBeNull(); expect(f.authorize).not.toHaveBeenCalled();
    expect(isolated.clearStorageData).toHaveBeenCalledOnce();
    const next = f.controller.login({ ...f.input, requestKey: randomUUID() }, f.parent);
    await vi.waitFor(() => expect(session.fromPartition).toHaveBeenCalledTimes(2));
    (BrowserWindow as any).windows.at(-1).destroy(); expect(await next).toBeNull();
  });

  it.each(["hide", "reload", "crash"])("%s 中断窗口时不提交授权", async (cause) => {
    const f = fixture(), result = f.controller.login(f.input, f.parent), { isolated, login } = await opened(f);
    const checked = result.catch((error) => error);
    if (cause === "hide") f.parent.emit("hide");
    else if (cause === "reload") f.parent.webContents.emit("did-start-navigation", {}, "marshal://app/index.html", false, true);
    else login.webContents.emit("render-process-gone", {}, {});
    const value = await checked; expect(cause === "crash" ? value.code : value).toBe(cause === "crash" ? "INTERRUPTED" : null);
    expect(f.authorize).not.toHaveBeenCalled(); expect(isolated.clearStorageData).toHaveBeenCalledOnce();
  });

  it("五分钟超时和加载失败只返回固定提示，不回显网络错误", async () => {
    const f = fixture(); vi.useFakeTimers();
    const result = f.controller.login(f.input, f.parent), checked = expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000); await checked;
    expect(f.authorize).not.toHaveBeenCalled();
    vi.useRealTimers(); vi.clearAllMocks();
    const next = f.controller.login({ ...f.input, requestKey: randomUUID() }, f.parent), failure = expect(next).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE", message: "夸克登录页面加载失败，请检查网络后重试。" });
    const { login } = await opened(f);
    login.webContents.emit("did-fail-load", {}, -105, "cookie=fixture-private", "https://pan.quark.cn/", true);
    await failure;
  });

  it("已提交请求只查询原作业；退出时取消尚未结束的登录", async () => {
    const f = fixture(); f.lookup.mockResolvedValueOnce(f.job);
    expect(await f.controller.login(f.input, f.parent)).toEqual(f.job); expect(session.fromPartition).not.toHaveBeenCalled();
    const pending = f.controller.login({ ...f.input, requestKey: randomUUID() }, f.parent); await opened(f);
    await f.controller.stop(); expect(await pending).toBeNull();
    await expect(f.controller.login(f.input, f.parent)).rejects.toMatchObject({ code: "INTERRUPTED" });
  });
});
