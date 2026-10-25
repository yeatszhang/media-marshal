// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider, useService } from "@yeatz/app-framework/react";
import type { DesktopApi } from "@media-marshal/contracts";
import { createRendererApplication, RuntimeViewModel } from "./services";
import { rendererGeneration, rendererStop } from "./lifecycle";
import { CloudAccountsViewModel } from "./cloud-accounts-model";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });
describe("Renderer 宿主清理", () => {
  it("启动期间的替换等待旧代资源落定，既不挂载旧页，也不重复清理", async () => {
    let release!: () => void; const gate = new Promise<void>((done) => { release = done; }), mount = vi.fn(), cleanup = vi.fn(async () => {});
    const generation = rendererGeneration(async (isStopping) => { await gate; expect(isStopping()).toBe(true); return true; }, mount, rendererStop(() => {}, cleanup));
    const stop = generation.stop(); expect(generation.stop()).toBe(stop); expect(cleanup).not.toHaveBeenCalled();
    release(); await generation.ready; await stop; expect(mount).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledOnce();
  });
  it("部分挂载失败仍释放资源，停止保留失败结果而不重新启动", async () => {
    const cleanup = vi.fn(async () => {}), generation = rendererGeneration(async () => true, () => { throw new Error("挂载失败"); }, rendererStop(() => {}, cleanup));
    await expect(generation.ready).rejects.toThrow("挂载失败"); await expect(generation.stop()).rejects.toThrow("挂载失败"); expect(cleanup).toHaveBeenCalledOnce();
  });
  it("先卸载真实 StrictMode 根释放轮询，再等待应用清理，并发停止复用同一结果", async () => {
    vi.useFakeTimers(); const getRuntime = vi.fn(async () => ({ appVersion: "test", protocolVersion: 1, core: "ready", status: null, detail: null })), app = createRendererApplication({ getRuntime } as unknown as DesktopApi); await app.start();
    const element = document.createElement("div"); document.body.append(element); const root = createRoot(element), trace: string[] = [];
    function Probe() { const model = useService(RuntimeViewModel); useEffect(() => { const release = model.watch(); return () => { trace.push("页面卸载"); release(); }; }, [model]); return <span>界面已挂载</span>; }
    await act(async () => root.render(<StrictMode><ContainerProvider value={app.container}><Probe /></ContainerProvider></StrictMode>)); trace.length = 0;
    let release!: () => void; const gate = new Promise<void>((done) => { release = done; }), stopApplication = vi.fn(async () => { trace.push("应用开始清理"); await gate; await app.stop(); trace.push("应用清理完成"); });
    const stop = rendererStop(() => root.unmount(), stopApplication); let pending!: Promise<void>, completed = false;
    await act(async () => { pending = stop(); expect(stop()).toBe(pending); void pending.then(() => { completed = true; }); });
    expect(trace).toEqual(["页面卸载", "应用开始清理"]); expect(element.textContent).toBe(""); const reads = getRuntime.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10000)); expect(getRuntime).toHaveBeenCalledTimes(reads); expect(completed).toBe(false); expect(app.state).toBe("running");
    await act(async () => { release(); await pending; }); expect(completed).toBe(true); expect(app.state).toBe("stopped"); expect(stopApplication).toHaveBeenCalledOnce(); expect(stop()).toBe(pending);
  });
  it("React 卸载失败仍清理应用，失败结果不会被下一次重试冒认成功", async () => {
    const unmount = vi.fn(() => { throw new Error("卸载失败"); }), cleanup = vi.fn(async () => {}), stop = rendererStop(unmount, cleanup), first = stop();
    await expect(first).rejects.toThrow("界面清理未完成"); expect(cleanup).toHaveBeenCalledOnce(); expect(stop()).toBe(first); await expect(stop()).rejects.toThrow(); expect(unmount).toHaveBeenCalledOnce();
  });
  it("应用清理等待已发出的扫码取消回执，迟到的登录响应不续发查询", async () => {
    let releaseCancel!: () => void, releaseLogin!: () => void;
    const api = { loginCloudAccount: vi.fn(() => new Promise<null>((done) => { releaseLogin = () => done(null); })), cancelCloudLogin: vi.fn(() => new Promise<void>((done) => { releaseCancel = done; })), listCloudAccounts: vi.fn(async () => []), getCloudAuthorization: vi.fn(async () => null) };
    const app = createRendererApplication(api as unknown as DesktopApi); await app.start(); const model = app.container.get(CloudAccountsViewModel), login = model.login("隔离扫码草稿");
    const cancel = model.cancelLogin(), stop = rendererStop(() => {}, () => app.stop()), pending = stop(); let completed = false; void pending.then(() => { completed = true; });
    try {
      // 跨过一个事件循环检查点：若 dispose 没有返回取消 Promise，应用此时已停止。
      await new Promise<void>((done) => setTimeout(done, 0)); expect(api.cancelCloudLogin).toHaveBeenCalledOnce(); expect(completed).toBe(false);
      releaseCancel(); await cancel; await pending; expect(completed).toBe(true); expect(app.state).toBe("stopped");
      releaseLogin(); await login; expect(api.listCloudAccounts).not.toHaveBeenCalled(); expect(api.getCloudAuthorization).not.toHaveBeenCalled();
    } finally { releaseCancel(); releaseLogin(); await pending; await login; }
  });
});
