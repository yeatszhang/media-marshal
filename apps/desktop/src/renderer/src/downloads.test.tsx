// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import { cloudFailure, CloudError, type DownloadItemIssue, type DesktopApi, type DownloadJob } from "@media-marshal/contracts";
import { createRendererApplication, DownloadsViewModel } from "./services";
import { Downloads } from "./pages/Downloads";
import { i18nReady } from "./i18n";
import { MemoryRouter } from "react-router-dom";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); document.body.innerHTML = ""; });
const job = (state: DownloadJob["state"] = "RUNNING"): DownloadJob => ({ id: crypto.randomUUID(), accountId: crypto.randomUUID(), name: "中文超长下载文件名".repeat(20), state, failure: null, updatedAt: new Date().toISOString(), progress: { bytes: 12, bytesPerSecond: 3, totalBytes: null, completedItems: 0, totalItems: null } });
async function mount(initial: DownloadJob[]) {
  await i18nReady; let items = initial;
  const api = { getCloudDownloadPause: vi.fn(async () => ({ paused: false, pausing: false })), listDownloads: vi.fn(async () => ({ items, total: items.length })), controlDownload: vi.fn(async ({ jobId, operation }: { jobId: string; operation: string }) => { items = items.map((item) => item.id === jobId ? { ...item, state: operation === "pause" ? "PAUSED" : "RUNNING" } : item); return { jobId }; }), openDownloadDirectory: vi.fn(async () => {}), previewDownload: vi.fn(), confirmDownload: vi.fn() } as unknown as DesktopApi;
  const app = createRendererApplication(api); await app.start(); const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(<StrictMode><MemoryRouter><ContainerProvider value={app.container}><Downloads /></ContainerProvider></MemoryRouter></StrictMode>));
  cleanup.push(async () => { await act(async () => root.unmount()); await app.stop(); });
  return { app, api, model: app.container.get(DownloadsViewModel), element };
}
describe("下载队列交互与观测边界", () => {
  it("本地移除与成功下载分别说明，读取或 StrictMode 重挂载不发重传请求", async () => {
    const completed = job("COMPLETED"), f = await mount([{ ...completed, localRemovedFiles: 1, progress: { ...completed.progress, completedItems: 1, totalItems: 1 } }]);
    expect(f.element.textContent).toContain("已同步，本地已移除"); expect(f.element.textContent).toContain("预览并确认强制重新下载");
    expect(f.api.previewDownload).not.toHaveBeenCalled(); expect(f.api.confirmDownload).not.toHaveBeenCalled(); expect(f.api.controlDownload).not.toHaveBeenCalled();
  });
  it("未知总量不显示百分比，暂停只发一次业务意图，页面查询不重放下载", async () => {
    const f = await mount([job()]); expect(f.element.textContent).toContain("12 B / 未知"); expect(f.element.querySelector("progress")).toBeNull();
    const pause = [...f.element.querySelectorAll("button")].find((button) => button.textContent === "暂停下载")!;
    await act(async () => pause.click()); expect(f.api.controlDownload).toHaveBeenCalledTimes(1); expect(f.element.textContent).toContain("已暂停");
    expect(f.api.previewDownload).not.toHaveBeenCalled(); expect(f.api.confirmDownload).not.toHaveBeenCalled();
  });
  it("暂停后的有效进度说明回退原因，部分完成不能宣称整项下载完成", async () => {
    const paused = job("PAUSED"), f = await mount([{ ...paused, progress: { bytes: 1072898, totalBytes: 85969558511, bytesPerSecond: 0, completedItems: 6, totalItems: 95 }, ingestion: { organization: "NOT_ENABLED", pending: 0, candidates: 0, organized: 0, collected: 0, needsAttention: 0 } }]);
    expect(f.element.textContent).toContain("有效进度 1.0 MiB / 80.07 GiB · <0.1%");
    expect(f.element.textContent).toContain("已完成 6 / 95 项");
    expect(f.element.textContent).toContain("临时进度不再计入");
    expect(f.element.textContent).toContain("已完成的文件可在完成目录查看");
    expect(f.element.textContent).not.toContain("下载完成，");
    expect(f.element.querySelector("progress")?.value).toBe(1072898);
    expect(f.element.querySelector("progress")?.max).toBe(85969558511);
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
    await act(async () => { await f.model.refresh(2); }); expect(f.api.listDownloads).toHaveBeenCalledWith({ page: 2, pageSize: 25 });
    expect(f.api.listDownloads).toHaveBeenLastCalledWith({ page: 1, pageSize: 25 });
  });
  it("末页任务取消后自动回到最后有效页，全部取消后显示空列表", async () => {
    const f = await mount([job()]);
    vi.mocked(f.api.listDownloads).mockResolvedValueOnce({ items: [job()], total: 26 });
    await act(async () => { await f.model.refresh(2); });
    vi.mocked(f.api.listDownloads).mockResolvedValueOnce({ items: [], total: 25 }).mockResolvedValueOnce({ items: [job()], total: 25 });
    await act(async () => { await f.model.control(f.model.state.items[0]!.id, "cancel"); });
    expect(f.model.state.page).toBe(1); expect(f.model.state.total).toBe(25); expect(f.model.state.items).toHaveLength(1);
    expect(f.api.listDownloads).toHaveBeenLastCalledWith({ page: 1, pageSize: 25 });
    vi.mocked(f.api.listDownloads).mockResolvedValueOnce({ items: [], total: 0 });
    await act(async () => { await f.model.control(f.model.state.items[0]!.id, "cancel"); });
    expect(f.model.state.total).toBe(0); expect(f.element.querySelector(".download-job")).toBeNull();
  });
  it("只下载与归属待核对分别说明，不把未启用的整理显示为待入库", async () => {
    const completed = job("COMPLETED"), progress = { ...completed.progress, completedItems: 1, totalItems: 1 }, counts = { pending: 0, candidates: 0, organized: 0, collected: 0, needsAttention: 0 };
    const f = await mount([{ ...completed, progress, ingestion: { ...counts, organization: "NOT_ENABLED" } }, { ...completed, id: crypto.randomUUID(), progress, ingestion: { ...counts, pending: 1, organization: "REVIEW_REQUIRED" } }]);
    expect(f.element.textContent).toContain("未启用整理"); expect(f.element.textContent).toContain("整理归属待核对"); expect(f.element.textContent).not.toContain("当前待接入");
    expect(f.api.confirmDownload).not.toHaveBeenCalled(); expect(f.api.previewDownload).not.toHaveBeenCalled();
  });
});


describe("逐文件异常反馈与核对", () => {
  const issue = (changes: Partial<DownloadItemIssue> = {}): DownloadItemIssue => ({ itemId: crypto.randomUUID(), relativePath: "剧集/超长目录/第01集.mkv", state: "RECONCILING", stage: "COMMIT", failure: cloudFailure(new CloudError("CONFLICT")), checking: false, canReconcile: true, blockedReason: null, ...changes });
  it("传输与部分异常分别说明，核对成功移除异常且不发重传请求", async () => {
    const current = job(), f = await mount([{ ...current, issueCount: 1, failure: cloudFailure(new CloudError("CONFLICT")) }]), detail = issue();
    const list = vi.fn(async () => ({ items: [detail], total: 1 })), reconcile = vi.fn(async () => ({ jobId: current.id }));
    f.api.listDownloadIssues = list; f.api.reconcileDownload = reconcile;
    expect(f.element.textContent).toContain("其他文件继续处理，1 项异常待处理");
    const directory = [...f.element.querySelectorAll("button")].find((button) => button.textContent === "打开完成目录")!;
    await act(async () => directory.click()); expect(f.api.openDownloadDirectory).toHaveBeenCalledWith(current.id);
    const panel = f.element.querySelector<HTMLDetailsElement>(".download-issues")!;
    await act(async () => { panel.open = true; panel.dispatchEvent(new Event("toggle")); });
    expect(f.element.textContent).toContain(detail.relativePath); expect(f.element.textContent).toContain("历史记录未保存具体冲突条件");
    expect(f.element.textContent).not.toContain("操作存在冲突，请查询当前状态");
    list.mockResolvedValue({ items: [], total: 0 });
    vi.mocked(f.api.listDownloads).mockResolvedValue({ items: [{ ...current, state: "COMPLETED", issueCount: 0 }], total: 1 });
    const button = [...f.element.querySelectorAll("button")].find((button) => button.textContent === "重新核对此文件")!;
    await act(async () => button.click());
    expect(reconcile).toHaveBeenCalledWith({ jobId: current.id, itemId: detail.itemId });
    expect(f.element.querySelector(".download-issues")).toBeNull();
    expect(f.api.confirmDownload).not.toHaveBeenCalled(); expect(f.api.controlDownload).not.toHaveBeenCalled();
  });
  it("失败定位到对应文件，刷新明细保留操作失败；停止证据不足直接说明禁用原因", async () => {
    const f = await mount([{ ...job("RECONCILING"), issueCount: 2 }]);
    const blocked = issue({ itemId: crypto.randomUUID(), relativePath: "另一集.mkv", canReconcile: false, blockedReason: "尚未确认原下载执行已停止，请等待停止核对。" });
    f.api.listDownloadIssues = vi.fn(async () => ({ items: [issue({ itemId: "fda060cb-655c-4caf-9967-f27399f65d0c" }), blocked], total: 2 }));
    f.api.reconcileDownload = vi.fn(async () => { throw new Error("目标已被其他文件占用，请移走占用文件后重新核对"); });
    const panel = f.element.querySelector<HTMLDetailsElement>(".download-issues")!;
    await act(async () => { panel.open = true; panel.dispatchEvent(new Event("toggle")); });
    const buttons = [...panel.querySelectorAll("button")].filter((button) => button.textContent === "重新核对此文件");
    expect(buttons[1]?.disabled).toBe(true); expect(panel.textContent).toContain("尚未确认原下载执行已停止");
    await act(async () => buttons[0]!.click()); expect(buttons[0]!.closest("li")?.textContent).toContain("目标已被其他文件占用");
    expect(buttons[1]!.closest("li")?.textContent).not.toContain("目标已被其他文件占用");
  });
  it("分页获取全部异常，核对中的条目显示进度并阻止重复提交", async () => {
    const f = await mount([{ ...job(), issueCount: 11 }]);
    const list = vi.fn(async () => ({ items: [issue({ checking: true, canReconcile: false })], total: 11 })); f.api.listDownloadIssues = list;
    const panel = f.element.querySelector<HTMLDetailsElement>(".download-issues")!;
    await act(async () => { panel.open = true; panel.dispatchEvent(new Event("toggle")); });
    expect(panel.textContent).toContain("正在核对已有文件"); expect(panel.querySelector('button[aria-label^="重新核对"]')).toBeNull();
    await act(async () => [...panel.querySelectorAll("button")].find((button) => button.textContent === "下一页异常")!.click());
    expect(list).toHaveBeenLastCalledWith({ jobId: f.model.state.items[0]!.id, page: 2, pageSize: 10 });
  });
});
