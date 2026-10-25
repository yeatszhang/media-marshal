// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { CoreOutput, DesktopApi } from "@media-marshal/contracts";
import { createRendererApplication, LibraryViewModel } from "./services";
import { LibrarySetup } from "./pages/LibrarySetup";
import { i18nReady } from "./i18n";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); document.body.innerHTML = ""; });
async function mount() {
  vi.useFakeTimers(); await i18nReady;
  const target = { mediaType: "TV_SHOW" as const, targetId: crypto.randomUUID(), path: "/本机/中文剧集目标", available: true };
  let configuration: CoreOutput<"emby.configuration"> = { serverId: "server-fixture", version: 3, address: "http://localhost:8096", verified: false, libraries: [{ targetId: target.targetId, libraryId: "library-tv", libraryPath: target.path }] };
  const api = {
    listMediaLibraries: vi.fn(async () => [target]), getEmbyConfiguration: vi.fn(async () => configuration),
    chooseMediaTarget: vi.fn(async () => [target]),
    listEmbyLibraries: vi.fn(async () => ({ serverId: "server-fixture", version: "4.9-fixture", libraries: [{ id: "library-tv", name: "原有剧集库", type: "tvshows", paths: [target.path] }] })),
    connectEmby: vi.fn(async () => { configuration = { ...configuration!, verified: true }; return configuration; }),
  };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start();
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(<StrictMode><ContainerProvider value={app.container}><LibrarySetup /></ContainerProvider></StrictMode>));
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()); } };
  cleanup.push(async () => { await unmount(); await app.stop(); });
  const button = (text: string) => [...element.querySelectorAll("button")].find((value) => value.textContent === text)!;
  return { app, api, element, target, model: app.container.get(LibraryViewModel), unmount, button,
    verified() { configuration = { ...configuration!, verified: true }; } };
}
describe("已有 Emby 媒体目标与验证状态", () => {
  it("StrictMode 只保留一条查询轮询，重启后的复核结果自动显示，卸载不停止应用", async () => {
    const f = await mount(); expect(f.element.textContent).toContain("连接尚未验证"); expect(f.api.getEmbyConfiguration).toHaveBeenCalledTimes(1);
    f.verified(); await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(f.element.textContent).toContain("连接已验证"); expect(f.api.getEmbyConfiguration).toHaveBeenCalledTimes(2);
    await f.unmount(); await vi.advanceTimersByTimeAsync(10000);
    expect(f.api.getEmbyConfiguration).toHaveBeenCalledTimes(2); expect(f.app.state).toBe("running");
    expect(f.api.connectEmby).not.toHaveBeenCalled(); expect(f.api.chooseMediaTarget).not.toHaveBeenCalled();
  });
  it("只有剧集目标也可读取并绑定已有库，轮询不重放验证与扫描", async () => {
    const f = await mount(); await act(async () => f.button("读取 Emby 媒体库").click());
    const select = f.element.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { select.value = JSON.stringify(["library-tv", f.target.path]); select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => f.button("验证并保存（触发扫描）").click());
    expect(f.api.connectEmby).toHaveBeenCalledExactlyOnceWith({ serverId: "server-fixture", libraries: [{ targetId: f.target.targetId, libraryId: "library-tv", libraryPath: f.target.path }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(f.api.connectEmby).toHaveBeenCalledTimes(1); expect(f.api.chooseMediaTarget).not.toHaveBeenCalled();
  });
  it("后台查询恢复只清除查询错误，不隐藏绑定失败，原生取消不更改有效连接", async () => {
    const f = await mount(); f.api.getEmbyConfiguration.mockRejectedValueOnce(new Error("核心暂不可用"));
    await act(async () => { await f.model.refresh(); }); expect(f.element.textContent).toContain("核心暂不可用");
    await act(async () => { await f.model.refresh(); }); expect(f.element.textContent).not.toContain("核心暂不可用");
    f.verified(); await act(async () => { await f.model.refresh(); });
    f.api.connectEmby.mockRejectedValueOnce(new Error("所选 Emby 库类型不匹配"));
    await act(async () => { await f.model.connect({ serverId: "server-fixture", libraries: [{ targetId: f.target.targetId, libraryId: "library-tv", libraryPath: f.target.path }] }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(f.element.textContent).toContain("所选 Emby 库类型不匹配");
    await act(async () => f.button("选择剧集目录").click());
    expect(f.api.chooseMediaTarget).toHaveBeenCalledExactlyOnceWith("TV_SHOW"); expect(f.api.connectEmby).toHaveBeenCalledTimes(1);
    expect(f.element.textContent).toContain(f.target.path); expect(f.element.textContent).toContain("连接已验证");
  });
});
