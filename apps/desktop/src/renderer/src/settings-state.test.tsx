// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { DesktopApi, DesktopSettings, SettingsDraft } from "@media-marshal/contracts";
import { createRendererApplication, SettingsViewModel } from "./services";
import { SettingsPage } from "./pages/SettingsPage";
import { i18nReady } from "./i18n";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); document.body.innerHTML = ""; });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture() {
  await i18nReady;
  let settings: DesktopSettings = { language: "zh-CN", embyUrl: "http://localhost:8096", tmdbProxy: "", embyKeyConfigured: false, tmdbKeyConfigured: false };
  const api = {
    getSettings: vi.fn(async () => structuredClone(settings)),
    saveSettings: vi.fn(async (input: SettingsDraft) => { settings = { ...settings, ...input }; return input; }),
    saveCredential: vi.fn(async () => { settings = { ...settings, tmdbKeyConfigured: true }; }),
    listMediaLibraries: vi.fn(async () => []), getEmbyConfiguration: vi.fn(async () => null), listEmbyLibraries: vi.fn(async () => null),
    getHostPreferences: vi.fn(async () => ({ openAtLogin: false, remindOnClose: true, loginSupported: false, loginStatus: "unsupported", trayAvailable: true })),
    getDesktopAbout: vi.fn(async () => ({ appVersion: "test", electronVersion: "test", target: "test", packaged: false, components: [] })),
  };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start();
  const element = document.createElement("div"); document.body.append(element); let root = createRoot(element), mounted = false;
  const mount = async () => { if (!mounted) { mounted = true; await act(async () => root.render(<StrictMode><ContainerProvider value={app.container}><SettingsPage /></ContainerProvider></StrictMode>)); } };
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); root = createRoot(element); } };
  cleanup.push(async () => { await unmount(); await app.stop(); });
  return { api, app, element, model: app.container.get(SettingsViewModel), mount, unmount };
}
async function fill(id: string, value: string) { const input = document.querySelector<HTMLInputElement>(id)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
describe("设置查询、React 草稿与卸载边界", () => {
  it("StrictMode 的旧读取和错误不覆盖新结果，离开页面后不停止共享应用", async () => {
    const f = await fixture(), first = deferred<DesktopSettings>(), second = deferred<DesktopSettings>();
    f.api.getSettings.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    await f.mount(); expect(f.api.getSettings).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve({ language: "zh-CN", embyUrl: "http://new.example", tmdbProxy: "", embyKeyConfigured: true, tmdbKeyConfigured: false }));
    await act(async () => first.reject(new Error("旧页面读取失败")));
    expect(f.model.state.settings?.embyUrl).toBe("http://new.example"); expect(f.model.state.error).toBeNull(); expect(f.model.state.loading).toBe(false);
    const late = deferred<DesktopSettings>(); f.api.getSettings.mockImplementationOnce(() => late.promise); let read!: Promise<void>;
    await act(async () => { read = f.model.refresh(); }); await f.unmount();
    await act(async () => { late.resolve({ ...f.model.state.settings!, embyUrl: "http://old.example" }); await read; });
    expect(f.model.state.settings?.embyUrl).toBe("http://new.example"); expect(f.app.state).toBe("running"); expect(f.api.saveSettings).not.toHaveBeenCalled();
  });
  it("保存使在途旧查询失效，写入中重复刷新不抢回旧 DTO", async () => {
    const f = await fixture(); await f.mount(); const late = deferred<DesktopSettings>(), gate = deferred<void>();
    f.api.getSettings.mockImplementationOnce(() => late.promise); let read!: Promise<void>, save!: Promise<void>;
    await act(async () => { read = f.model.refresh(); }); const original = f.api.saveSettings.getMockImplementation()!;
    f.api.saveSettings.mockImplementationOnce(async (input) => { await gate.promise; return original(input); });
    await act(async () => { save = f.model.save({ embyUrl: "http://saved.example", tmdbProxy: "" }); }); const calls = f.api.getSettings.mock.calls.length;
    await act(async () => f.model.refresh()); expect(f.api.getSettings).toHaveBeenCalledTimes(calls);
    await act(async () => { gate.resolve(); await save; }); await act(async () => { late.resolve({ ...f.model.state.settings!, embyUrl: "http://old.example" }); await read; });
    expect(f.model.state.settings?.embyUrl).toBe("http://saved.example"); expect(f.api.saveSettings).toHaveBeenCalledOnce();
  });
  it("保存密钥或刷新状态不会覆盖未保存的地址草稿", async () => {
    const f = await fixture(); await f.mount(); await fill("#settings-emby-url", "http://draft.example"); await fill("#settings-tmdb-proxy", "http://127.0.0.1:7890");
    await fill("#settings-tmdb-key", "isolated-test-key");
    await act(async () => document.querySelector<HTMLInputElement>("#settings-tmdb-key")!.parentElement!.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => f.model.refresh());
    expect(document.querySelector<HTMLInputElement>("#settings-emby-url")!.value).toBe("http://draft.example"); expect(document.querySelector<HTMLInputElement>("#settings-tmdb-proxy")!.value).toBe("http://127.0.0.1:7890");
    expect(document.querySelector<HTMLInputElement>("#settings-tmdb-key")!.value).toBe(""); expect(f.model.state.settings?.tmdbKeyConfigured).toBe(true); expect(f.api.saveSettings).not.toHaveBeenCalled();
  });
  it("卸载或应用停止后不从旧保存续发读取，也不接受新的写入", async () => {
    const f = await fixture(); await f.mount(); const gate = deferred<void>(); f.api.saveCredential.mockImplementationOnce(() => gate.promise);
    let save!: Promise<void>; await act(async () => { save = f.model.saveKey("tmdb", "isolated-test-key"); }); const reads = f.api.getSettings.mock.calls.length;
    await f.unmount(); await act(async () => { gate.resolve(); await save; }); expect(f.api.getSettings).toHaveBeenCalledTimes(reads);
    await f.app.stop(); await expect(f.model.saveKey("emby", "never-submitted")).rejects.toThrow("界面已停止"); await f.model.refresh();
    expect(f.api.saveCredential).toHaveBeenCalledOnce(); expect(f.api.getSettings).toHaveBeenCalledTimes(reads);
  });
});
