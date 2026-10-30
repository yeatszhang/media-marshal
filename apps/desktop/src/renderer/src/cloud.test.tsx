// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { DesktopApi, CloudAccount } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { CloudDrives } from "./pages/CloudDrives";
import { i18nReady } from "./i18n";
import { MemoryRouter } from "react-router-dom";

Object.assign(HTMLDialogElement.prototype, { showModal() { this.setAttribute("open", ""); }, close() { this.removeAttribute("open"); } });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const disposed: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposed.splice(0)) await dispose(); document.body.innerHTML = ""; vi.useRealTimers(); });
async function mount(overrides: Partial<DesktopApi> = {}) {
  await i18nReady;
  const api = { listDownloadRoots: vi.fn(async () => []), chooseDownloadRoot: vi.fn(async () => null), listCloudAccounts: vi.fn(async () => []), authorizeCloudAccount: vi.fn(), loginCloudAccount: vi.fn(async () => null), cancelCloudLogin: vi.fn(async () => {}), getCloudAuthorization: vi.fn(async () => null), listRemote: vi.fn(), statRemote: vi.fn(), ...overrides } as unknown as DesktopApi;
  const app = createRendererApplication(api); await app.start();
  const element = document.createElement("div"); document.body.append(element); const root: Root = createRoot(element);
  await act(async () => { root.render(<StrictMode><MemoryRouter><ContainerProvider value={app.container}><CloudDrives /></ContainerProvider></MemoryRouter></StrictMode>); });
  disposed.push(async () => { await act(async () => root.unmount()); await app.stop(); });
  return { api, element, app };
}
async function click(text: string) { const button = [...document.querySelectorAll("button")].find((value) => value.textContent === text); expect(button, text).toBeTruthy(); await act(async () => { button!.click(); }); }
async function fill(selector: string, value: string) {
  const element = document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
describe("云端页面的凭据与浏览状态", () => {
  it("取消清除输入且不提交授权，重新打开不回显 Cookie", async () => {
    const f = await mount(); await click("连接夸克账号");
    await click("手动 Cookie");
    await fill('input[type="password"]', "fixture-private-cookie"); await click("取消"); await click("放弃修改");
    expect(document.querySelector('input[type="password"]')).toBeNull(); expect(f.api.authorizeCloudAccount).not.toHaveBeenCalled();
    await click("连接夸克账号"); await click("手动 Cookie"); expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  });
  it("提交后立即清空草稿；未返回的授权不会被 StrictMode 重放", async () => {
    let complete!: (value: unknown) => void;
    const authorize = vi.fn(() => new Promise((resolve) => { complete = resolve; }));
    const f = await mount({ authorizeCloudAccount: authorize as DesktopApi["authorizeCloudAccount"] });
    await click("连接夸克账号"); await click("手动 Cookie"); await fill('input:not([type="password"])', "内测账号"); await fill('input[type="password"]', "fixture-private-cookie");
    await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(""); expect(authorize).toHaveBeenCalledTimes(1);
    expect(f.element.textContent).not.toContain("fixture-private-cookie");
    await act(async () => { complete({ id: crypto.randomUUID(), requestKey: authorize.mock.calls[0]![0].requestKey, accountId: crypto.randomUUID(), state: "RUNNING", failure: null, updatedAt: new Date().toISOString() }); });
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
  it("默认扫码仅传业务字段，等待期间不能重放；取消保留名称并可重新扫码", async () => {
    let finish!: (value: null) => void;
    const login = vi.fn<DesktopApi["loginCloudAccount"]>(() => new Promise<null>((resolve) => { finish = resolve; }));
    const cancel = vi.fn(async () => { finish(null); });
    const f = await mount({ loginCloudAccount: login, cancelCloudLogin: cancel });
    await click("连接夸克账号"); expect(document.querySelector('input[type="password"]')).toBeNull();
    await fill("input", "扫码账号"); await click("打开扫码登录");
    expect(login).toHaveBeenCalledOnce(); expect(login.mock.calls[0]![0]).toEqual({ name: "扫码账号", accountId: undefined, requestKey: expect.any(String) });
    expect(f.element.textContent).toContain("请在夸克登录窗口扫码并确认");
    await click("打开扫码登录"); expect(login).toHaveBeenCalledOnce();
    await click("取消扫码"); expect(cancel).toHaveBeenCalledWith(login.mock.calls[0]![0].requestKey);
    expect(document.querySelector<HTMLInputElement>("input")!.value).toBe("扫码账号");
    expect(f.api.authorizeCloudAccount).not.toHaveBeenCalled();
    await click("打开扫码登录"); expect(login).toHaveBeenCalledTimes(2);
    await act(async () => { finish(null); });
  });
  it("扫码失败允许显式重试；重新授权携带原账号身份", async () => {
    const account: CloudAccount = { id: crypto.randomUUID(), name: "原账号", providerKind: "quark", status: "AUTH_REQUIRED", capabilities: null };
    const login = vi.fn<DesktopApi["loginCloudAccount"]>().mockRejectedValueOnce(new Error("扫码登录已超时"))
      .mockImplementationOnce(async (input) => ({ id: crypto.randomUUID(), requestKey: input.requestKey, accountId: account.id, state: "RUNNING", failure: null, updatedAt: new Date().toISOString() }));
    const f = await mount({ listCloudAccounts: async () => [account], loginCloudAccount: login });
    await click("重新授权"); await click("打开扫码登录");
    expect(f.element.textContent).toContain("扫码登录已超时"); expect(login).toHaveBeenCalledTimes(1);
    await click("打开扫码登录"); expect(login).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: account.id, name: account.name }));
    expect(document.querySelector("form")).toBeNull(); expect(f.element.textContent).toContain("正在验证账号");
  });
  it("扫码提交响应丢失后接续查询到的授权作业，不再次打开窗口", async () => {
    const login = vi.fn<DesktopApi["loginCloudAccount"]>().mockRejectedValue(new Error("IPC 中断"));
    const f = await mount({ loginCloudAccount: login, getCloudAuthorization: async (requestKey) => ({ id: crypto.randomUUID(), accountId: crypto.randomUUID(), requestKey, state: "RUNNING", failure: null, updatedAt: new Date().toISOString() }) });
    await click("连接夸克账号"); await fill("input", "恢复查询"); await click("打开扫码登录");
    expect(login).toHaveBeenCalledOnce(); expect(document.querySelector("form")).toBeNull();
    expect(f.element.textContent).toContain("正在验证账号"); expect(f.element.textContent).not.toContain("IPC 中断");
  });
  it("账号页只管理连接，不浏览远端或提供下载和订阅配置", async () => {
    const account: CloudAccount = { id: crypto.randomUUID(), name: "已连接账号", providerKind: "quark", status: "READY", capabilities: null, rootRef: crypto.randomUUID() };
    const f = await mount({ listCloudAccounts: async () => [account] });
    expect(f.api.listRemote).not.toHaveBeenCalled(); expect(f.api.listDownloadRoots).not.toHaveBeenCalled(); expect(f.element.textContent).toContain("连接账号不会创建来源");
    expect([...document.querySelectorAll("button")].some((button) => ["选择下载目录", "预览下载范围", "确认启用订阅"].includes(button.textContent ?? ""))).toBe(false);
  });
});
