// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { DesktopApi, RemoteEntry, CloudAccount } from "@media-marshal/contracts";
import { createRendererApplication, CloudViewModel } from "./services";
import { CloudDrives } from "./pages/CloudDrives";
import { i18nReady } from "./i18n";
import { MemoryRouter } from "react-router-dom";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const disposed: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposed.splice(0)) await dispose(); document.body.innerHTML = ""; vi.useRealTimers(); });
async function mount(overrides: Partial<DesktopApi> = {}) {
  await i18nReady;
  const api = { listDownloadRoots: vi.fn(async () => []), chooseDownloadRoot: vi.fn(async () => null), listCloudAccounts: vi.fn(async () => []), authorizeCloudAccount: vi.fn(), getCloudAuthorization: vi.fn(async () => null), listRemote: vi.fn(), statRemote: vi.fn(), ...overrides } as unknown as DesktopApi;
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
    await fill('input[type="password"]', "fixture-private-cookie"); await click("取消");
    expect(document.querySelector('input[type="password"]')).toBeNull(); expect(f.api.authorizeCloudAccount).not.toHaveBeenCalled();
    await click("连接夸克账号"); expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  });
  it("提交后立即清空草稿；未返回的授权不会被 StrictMode 重放", async () => {
    let complete!: (value: unknown) => void;
    const authorize = vi.fn(() => new Promise((resolve) => { complete = resolve; }));
    const f = await mount({ authorizeCloudAccount: authorize as DesktopApi["authorizeCloudAccount"] });
    await click("连接夸克账号"); await fill('input:not([type="password"])', "内测账号"); await fill('input[type="password"]', "fixture-private-cookie");
    await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(""); expect(authorize).toHaveBeenCalledTimes(1);
    expect(f.element.textContent).not.toContain("fixture-private-cookie");
    await act(async () => { complete({ id: crypto.randomUUID(), requestKey: authorize.mock.calls[0]![0].requestKey, accountId: crypto.randomUUID(), state: "RUNNING", failure: null, updatedAt: new Date().toISOString() }); });
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
  it("未知总量、长名称与弱证据预览明确展示，加载更多失败不丢已有条目", async () => {
    const account: CloudAccount = { id: crypto.randomUUID(), name: "长目录测试", providerKind: "quark", status: "READY", capabilities: null, rootRef: crypto.randomUUID() };
    const entry: RemoteEntry = { accountId: account.id, ref: crypto.randomUUID(), parentRef: account.rootRef, name: "中文长文件名_".repeat(40) + ".mp4", type: "file", size: null, modifiedAt: null, version: null };
    let resolvePage!: (value: unknown) => void;
    const listRemote = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; })).mockRejectedValueOnce(new Error("网络暂不可用"));
    const f = await mount({ listCloudAccounts: vi.fn(async () => [account]), listRemote, statRemote: vi.fn(async () => entry) });
    await click("长目录测试已连接"); expect(f.element.textContent).toContain("正在读取目录");
    await act(async () => { resolvePage({ items: [entry], complete: false, total: null, nextCursor: "opaque-cursor" }); });
    expect(f.element.textContent).toContain("总数未知"); expect(document.querySelector(`[title="${entry.name}"]`)).toBeTruthy();
    await click("预览"); expect(f.element.querySelector(".cloud-selected-name")?.textContent).toBe(entry.name); expect(f.element.textContent).toContain("没有可靠的远端内容版本");
    await click("加载更多"); expect(f.element.textContent).toContain("网络暂不可用"); expect(f.element.querySelectorAll("tbody tr")).toHaveLength(1); expect(f.element.textContent).toContain("当前结果不完整");
  });
  it("订阅配置必须先完整预览，过滤变化使旧确认失效", async () => {
    const account: CloudAccount = { id: crypto.randomUUID(), name: "订阅测试", providerKind: "quark", status: "READY", capabilities: null, rootRef: crypto.randomUUID() };
    const entry: RemoteEntry = { accountId: account.id, ref: crypto.randomUUID(), parentRef: account.rootRef, name: "影视", type: "directory", size: null, modifiedAt: null, version: null };
    const rootId = crypto.randomUUID(), configure = vi.fn(async () => ({ id: crypto.randomUUID() }));
    const previewDownload = vi.fn(async (input) => ({ id: crypto.randomUUID(), accountId: account.id, remoteRef: entry.ref, targetGrantId: rootId, files: 1, bytes: 5, complete: true, weakComparison: true, expiresAt: new Date(Date.now() + 100000).toISOString(), state: "READY", failure: null, reuseFiles: 0, conflicts: 0, forceRedownload: false, destinationPrefix: "completed", selectionPath: "影视", layout: input.layout }));
    const f = await mount({ listCloudAccounts: async () => [account], listRemote: async () => ({ items: [entry], total: 1, complete: true, nextCursor: null }), statRemote: async () => entry, listDownloadRoots: async () => [{ id: rootId, path: "/下载", state: "AVAILABLE", availableBytes: 1000 }], previewDownload: previewDownload as DesktopApi["previewDownload"], configureCloudSubscription: configure as DesktopApi["configureCloudSubscription"] });
    await click("订阅测试已连接"); await click("预览");
    const purpose = document.querySelector<HTMLSelectElement>('[aria-label="下载方式"]')!;
    await act(async () => { purpose.value = "subscription"; purpose.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(configure).not.toHaveBeenCalled(); await fill('[aria-label="扩展名过滤"]', "mp4,mkv"); await click("预览下载范围");
    expect(previewDownload).toHaveBeenLastCalledWith(expect.objectContaining({ layout: "drive", forceRedownload: false, filters: { extensions: ["mp4", "mkv"], names: [] } }));
    expect(f.element.textContent).toContain("目标：/下载/completed/影视"); expect(f.element.textContent).toContain("同尺寸内容替换可能无法识别");
    await fill('[aria-label="扩展名过滤"]', "mp4"); expect(f.element.textContent).not.toContain("确认启用订阅"); expect(configure).not.toHaveBeenCalled();
    await click("预览下载范围"); await click("确认启用订阅"); expect(configure).toHaveBeenCalledTimes(1);
  });

  it("失效的订阅根从当前账号重新选择，修改配置携带原版本并重新确认", async () => {
    const account: CloudAccount = { id: crypto.randomUUID(), name: "重选测试", providerKind: "quark", status: "READY", capabilities: null, rootRef: crypto.randomUUID() }, oldRef = crypto.randomUUID(), rootId = crypto.randomUUID();
    const entry: RemoteEntry = { accountId: account.id, ref: crypto.randomUUID(), parentRef: account.rootRef, name: "重新定位", type: "directory", size: null, modifiedAt: null, version: null };
    const configure = vi.fn(async () => ({ id: crypto.randomUUID() })), subId = crypto.randomUUID();
    const f = await mount({ listCloudAccounts: async () => [account], listRemote: async () => ({ items: [entry], total: 1, complete: true, nextCursor: null }), statRemote: async (_account, ref) => { if (ref === oldRef) throw new Error("范围失效"); return entry; }, listDownloadRoots: async () => [{ id: rootId, path: "/下载", state: "AVAILABLE", availableBytes: 1000 }], previewDownload: async () => ({ id: crypto.randomUUID(), accountId: account.id, remoteRef: entry.ref, targetGrantId: rootId, files: 0, bytes: 0, complete: true, weakComparison: false, expiresAt: new Date(Date.now() + 100000).toISOString(), state: "READY", failure: null, reuseFiles: 0, conflicts: 0, forceRedownload: false, destinationPrefix: "completed", selectionPath: entry.name, layout: "drive" }), configureCloudSubscription: configure as DesktopApi["configureCloudSubscription"] });
    await act(async () => { await f.app.container.get(CloudViewModel).editSubscription({ id: subId, accountId: account.id, remoteRef: oldRef, targetGrantId: rootId, name: "旧范围", configurationVersion: 3, filters: { extensions: [], names: [] }, intervalSeconds: 900, state: "RESELECT_REQUIRED", enabled: false, failure: null, lastScanAt: null, nextScanAt: null, lastResult: null }); });
    expect(f.element.textContent).toContain("请在此账号重新选择目录"); expect(configure).not.toHaveBeenCalled();
    await click("预览"); await click("预览下载范围"); await click("确认更新订阅");
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: subId, configurationVersion: 3, intervalSeconds: 900 }));
  });

});
