// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { DesktopApi, HostPreferences, HostPreferencesDraft } from "@media-marshal/contracts";
import { createRendererApplication, SettingsViewModel } from "./services";
import { i18nReady } from "./i18n";
import { HostSettingsPanel } from "./components/HostSettingsPanel";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); const cleanup: (() => Promise<unknown>)[] = []; afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); document.body.innerHTML = ""; });
async function mount() {
  await i18nReady;
  let preferences: HostPreferences = { openAtLogin: false, remindOnClose: true, loginSupported: true, loginStatus: "not-registered", trayAvailable: true };
  const api = { getHostPreferences: vi.fn(async () => structuredClone(preferences)), saveHostPreferences: vi.fn(async (input: HostPreferencesDraft) => (preferences = { ...preferences, ...input, loginStatus: input.openAtLogin ? "requires-approval" : "not-registered" })), getDesktopAbout: vi.fn(async () => ({ appVersion: "0.2.1", electronVersion: "44.9.0", target: "darwin-arm64", packaged: true, components: [{ name: "项目", version: "0.2.1", license: "GPL-3.0", licenseId: "application" }] })), getLicenseText: vi.fn(async () => ({ title: "项目原文", text: "GPL 原文与来源说明" })) };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start(); const element = document.createElement("div"); document.body.append(element); const root = createRoot(element); await act(async () => root.render(<StrictMode><ContainerProvider value={app.container}><HostSettingsPanel /></ContainerProvider></StrictMode>)); let mounted = true;
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } }; cleanup.push(async () => { await unmount(); await app.stop(); }); return { app, element, api, unmount };
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((value) => value.textContent === text)!;
async function click(text: string) { expect(button(text), text).toBeTruthy(); await act(async () => button(text).click()); }
async function check(label: string) { await act(async () => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.click()); }
describe("运行方式与随包许可页面", () => {
  it("StrictMode、编辑与刷新只读，明确保存只提交一次，系统待批准不显示已启用", async () => {
    const f = await mount(); expect(f.api.saveHostPreferences).not.toHaveBeenCalled(); expect(f.api.getHostPreferences).toHaveBeenCalledTimes(2); await check("登录后自动启动"); await check("首次关闭时提醒后台运行"); await click("刷新系统状态"); expect(document.querySelector<HTMLInputElement>('[aria-label="登录后自动启动"]')!.checked).toBe(true); expect(f.api.saveHostPreferences).not.toHaveBeenCalled();
    await act(async () => { button("保存运行设置").click(); button("保存运行设置").click(); }); expect(f.api.saveHostPreferences).toHaveBeenCalledTimes(1); expect(f.api.saveHostPreferences).toHaveBeenCalledWith({ openAtLogin: true, remindOnClose: false }); expect(f.element.textContent).toContain("仍等待系统批准"); expect(f.element.textContent).not.toContain("系统已启用");
    f.api.getHostPreferences.mockResolvedValueOnce({ openAtLogin: true, remindOnClose: false, loginStatus: "enabled", loginSupported: true, trayAvailable: true }); await click("刷新系统状态"); expect(f.element.textContent).toContain("系统已启用"); expect(f.element.textContent).not.toContain("仍等待系统批准"); expect(f.api.saveHostPreferences).toHaveBeenCalledTimes(1);
  });
  it("许可只在点击后读取，失败可重试，关闭或卸载后的旧响应不重新打开", async () => {
    const f = await mount(); expect(f.api.getLicenseText).not.toHaveBeenCalled(); f.api.getLicenseText.mockRejectedValueOnce(new Error("随包许可不可读取，请重装")); await click("查看 项目 许可"); expect(f.element.textContent).toContain("随包许可不可读取"); await click("重试"); expect(f.element.textContent).toContain("GPL 原文与来源说明");
    let release!: (value: { title: string; text: string }) => void; f.api.getLicenseText.mockImplementationOnce(() => new Promise((done) => { release = done; })); await click("查看 项目 许可"); await click("关闭许可原文"); await act(async () => release({ title: "旧响应", text: "旧许可" })); expect(f.element.textContent).not.toContain("旧许可"); await f.unmount(); expect(f.app.state).toBe("running");
  });
  it("读取和保存失败保留当前草稿与具体原因，旧刷新不能覆盖已保存结果", async () => {
    const f = await mount(); await check("登录后自动启动"); f.api.saveHostPreferences.mockRejectedValueOnce(new Error("登录启动未确认，请刷新核对")); await click("保存运行设置"); expect(f.element.textContent).toContain("登录启动未确认"); expect(document.querySelector<HTMLInputElement>('[aria-label="登录后自动启动"]')!.checked).toBe(true);
    let release!: (value: HostPreferences) => void; f.api.getHostPreferences.mockImplementationOnce(() => new Promise((done) => { release = done; })); await click("刷新系统状态");
    // 直接验证同一 ViewModel 的旧查询代际，保存始终由明确动作触发。
    const { HostSettingsViewModel } = await import("./host-settings-model"); await act(async () => { await f.app.container.get(HostSettingsViewModel).save({ openAtLogin: true, remindOnClose: false }); }); await act(async () => release({ openAtLogin: false, remindOnClose: true, loginSupported: true, loginStatus: "not-registered", trayAvailable: true })); expect(f.element.textContent).toContain("等待系统批准"); expect(f.element.textContent).not.toContain("未注册登录启动");
  });
  it("代理与 Emby 非法地址在提交前给出字段原因，不调用保存或回显凭据", async () => {
    const saveSettings = vi.fn(), getSettings = vi.fn(async () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "", tmdbKeyConfigured: false, embyKeyConfigured: false })), app = createRendererApplication({ saveSettings, getSettings } as unknown as DesktopApi); await app.start(); cleanup.push(() => app.stop()); const model = app.container.get(SettingsViewModel);
    await expect(model.save({ embyUrl: "", tmdbProxy: "http://private-secret@localhost" })).rejects.toThrow("TMDB 代理"); expect(saveSettings).not.toHaveBeenCalled(); expect(model.state.error).not.toContain("private-secret");
    await expect(model.save({ embyUrl: "file:///私有路径", tmdbProxy: "" })).rejects.toThrow("Emby 地址"); expect(saveSettings).not.toHaveBeenCalled();
    await model.save({ embyUrl: "http://localhost:8096/emby", tmdbProxy: "http://127.0.0.1:7890" }); expect(saveSettings).toHaveBeenCalledTimes(1); expect(model.state.error).toBeNull();
  });
});
