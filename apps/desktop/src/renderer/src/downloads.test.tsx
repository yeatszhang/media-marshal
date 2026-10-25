// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { DesktopApi, DownloadJob } from "@media-marshal/contracts";
import { createRendererApplication, DownloadsViewModel } from "./services";
import { Downloads } from "./pages/Downloads";
import { i18nReady } from "./i18n";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); document.body.innerHTML = ""; });
const job = (state: DownloadJob["state"] = "RUNNING"): DownloadJob => ({ id: crypto.randomUUID(), accountId: crypto.randomUUID(), name: "中文超长下载文件名".repeat(20), state, failure: null, updatedAt: new Date().toISOString(), progress: { bytes: 12, bytesPerSecond: 3, totalBytes: null, completedItems: 0, totalItems: null } });
async function mount(initial: DownloadJob[]) {
  await i18nReady; let items = initial;
  const api = { getCloudDownloadPause: vi.fn(async () => ({ paused: false, pausing: false })), listDownloads: vi.fn(async () => ({ items, total: items.length })), controlDownload: vi.fn(async ({ jobId, operation }: { jobId: string; operation: string }) => { items = items.map((item) => item.id === jobId ? { ...item, state: operation === "pause" ? "PAUSED" : "RUNNING" } : item); return { jobId }; }), openDownloadDirectory: vi.fn(async () => {}), previewDownload: vi.fn(), confirmDownload: vi.fn() } as unknown as DesktopApi;
  const app = createRendererApplication(api); await app.start(); const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(<StrictMode><ContainerProvider value={app.container}><Downloads /></ContainerProvider></StrictMode>));
  cleanup.push(async () => { await act(async () => root.unmount()); await app.stop(); });
  return { app, api, model: app.container.get(DownloadsViewModel), element };
}
describe("下载队列交互与观测边界", () => {
  it("未知总量不显示百分比，暂停只发一次业务意图，页面查询不重放下载", async () => {
    const f = await mount([job()]); expect(f.element.textContent).toContain("12 B / 未知"); expect(f.element.querySelector("progress")).toBeNull();
    const pause = [...f.element.querySelectorAll("button")].find((button) => button.textContent === "暂停下载")!;
    await act(async () => pause.click()); expect(f.api.controlDownload).toHaveBeenCalledTimes(1); expect(f.element.textContent).toContain("已暂停");
    expect(f.api.previewDownload).not.toHaveBeenCalled(); expect(f.api.confirmDownload).not.toHaveBeenCalled();
  });
  it("迟到查询不能覆盖新完成状态，完成成果独立显示待整理", async () => {
    const current = job(), f = await mount([current]); let resolve!: (value: unknown) => void;
    vi.mocked(f.api.listDownloads).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const old = f.model.refresh(); vi.mocked(f.api.listDownloads).mockResolvedValueOnce({ items: [{ ...current, state: "COMPLETED", progress: { ...current.progress, bytes: 12, totalBytes: 12, completedItems: 1, totalItems: 1 } }], total: 1 });
    await act(async () => { await f.model.refresh(); resolve({ items: [{ ...current, state: "RUNNING" }], total: 1 }); await old; });
    expect(f.element.textContent).toContain("下载完成"); expect(f.element.textContent).toContain("当前待接入");
    expect([...f.element.querySelectorAll("button")].some((button) => button.textContent === "暂停下载")).toBe(false);
    const open = [...f.element.querySelectorAll("button")].find((button) => button.textContent === "打开完成目录")!; await act(async () => open.click()); expect(f.api.openDownloadDirectory).toHaveBeenCalledWith(current.id);
  });
  it("分页查询带页码，恢复与旧执行核对期间不提供第二个恢复入口", async () => {
    const f = await mount([job("RECONCILING")]);
    expect(f.element.textContent).toContain("等待旧执行停止或核对文件"); expect([...f.element.querySelectorAll("button")].some((button) => button.textContent === "恢复下载")).toBe(false);
    await act(async () => { await f.model.refresh(2); }); expect(f.api.listDownloads).toHaveBeenLastCalledWith({ page: 2, pageSize: 25 });
  });
});
