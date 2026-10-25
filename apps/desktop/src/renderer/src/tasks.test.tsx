// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { DesktopApi, MediaTask, TaskPage } from "@media-marshal/contracts";
import { createRendererApplication, TasksViewModel } from "./services";
import { Tasks } from "./pages/Tasks";
import { i18nReady } from "./i18n";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); document.body.innerHTML = ""; });
const item = (): MediaTask => ({ id: crypto.randomUUID(), sourceId: crypto.randomUUID(), sourcePath: "/测试来源/中文视频.mp4", title: "测试作品", status: "DONE", deliveryStatus: "REFRESH_PENDING", targetPath: "/测试目标/中文视频.mp4", updatedAt: new Date().toISOString() });
async function mount() {
  vi.useFakeTimers(); await i18nReady;
  const task = item(), api = { listTasks: vi.fn(async (): Promise<TaskPage> => ({ items: [task], total: 51, page: 1, pageSize: 25 })), retryEmby: vi.fn(async () => ({})), openEmby: vi.fn(async () => {}) };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start();
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(<StrictMode><MemoryRouter><ContainerProvider value={app.container}><Tasks /></ContainerProvider></MemoryRouter></StrictMode>));
  let mounted = true; const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  cleanup.push(async () => { await unmount(); await app.stop(); });
  return { app, api, task, element, unmount, model: app.container.get(TasksViewModel) };
}
describe("任务分页、过滤与交付观测", () => {
  it("原 COPY 保留整理详情，修正任务和已修正历史不再进入旧候选详情", async () => {
    const f = await mount(); expect(f.element.textContent).toContain("中文视频.mp4"); expect(f.element.textContent).toContain("整理详情"); expect([...f.element.querySelectorAll("button")].some((button) => button.textContent === "修正")).toBe(true);
    f.api.listTasks.mockResolvedValue({ items: [{ ...f.task, correctedFromId: crypto.randomUUID(), activeCorrectionId: crypto.randomUUID() }], total: 1, page: 1, pageSize: 25 }); await act(async () => f.model.refresh()); expect(f.element.textContent).toContain("查看修正进度"); expect(f.element.textContent).not.toContain("整理详情");
    f.api.listTasks.mockResolvedValue({ items: [{ ...f.task, status: "CORRECTED", correctedToId: crypto.randomUUID() }], total: 1, page: 1, pageSize: 25 }); await act(async () => f.model.refresh()); expect(f.element.textContent).toContain("查看修正历史"); expect(f.element.textContent).not.toContain("整理详情"); expect(f.api.retryEmby).not.toHaveBeenCalled();
  });
  it("StrictMode 一条轮询自动显示收录状态，卸载停止查询且不提交业务命令", async () => {
    const f = await mount(); expect(f.api.listTasks).toHaveBeenCalledTimes(1);
    expect(f.element.textContent).toContain("待刷新");
    f.api.listTasks.mockResolvedValue({ items: [{ ...f.task, deliveryStatus: "COLLECTED" }], total: 51, page: 1, pageSize: 25 });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(f.element.textContent).toContain("已收录"); expect(f.api.listTasks).toHaveBeenCalledTimes(2);
    await f.unmount(); await vi.advanceTimersByTimeAsync(10000); expect(f.api.listTasks).toHaveBeenCalledTimes(2);
    expect(f.app.state).toBe("running"); expect(f.api.retryEmby).not.toHaveBeenCalled(); expect(f.api.openEmby).not.toHaveBeenCalled();
  });
  it("筛选和分页保留查询条件，旧页迟到不能覆盖新筛选，后台不重放操作", async () => {
    const f = await mount(), select = f.element.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { select.value = "DONE"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(f.api.listTasks).toHaveBeenLastCalledWith({ page: 1, pageSize: 25, status: "DONE" });
    const next = [...f.element.querySelectorAll("button")].find((button) => button.textContent === "下一页")!;
    let release!: (value: TaskPage) => void; f.api.listTasks.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await act(async () => next.click()); expect(f.api.listTasks).toHaveBeenLastCalledWith({ page: 2, pageSize: 25, status: "DONE" });
    f.api.listTasks.mockResolvedValue({ items: [{ ...f.task, status: "FAILED", title: "失败筛选的新结果" }], total: 1, page: 1, pageSize: 25 });
    await act(async () => { await f.model.refresh(1, "FAILED"); release({ items: [{ ...f.task, title: "旧页迟到" }], total: 51, page: 2, pageSize: 25 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(f.element.textContent).toContain("失败筛选的新结果"); expect(f.element.textContent).not.toContain("旧页迟到"); expect(select.value).toBe("FAILED");
    expect(f.api.listTasks).toHaveBeenLastCalledWith({ page: 1, pageSize: 25, status: "FAILED" }); expect(f.api.retryEmby).not.toHaveBeenCalled();
  });
  it("查询恢复清除离线错误而保留交付操作失败，重复点击只提交一次", async () => {
    const f = await mount(); f.api.listTasks.mockRejectedValueOnce(new Error("核心暂不可用"));
    await act(async () => { await f.model.refresh(); }); expect(f.element.textContent).toContain("核心暂不可用");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(f.element.textContent).not.toContain("核心暂不可用");
    let reject!: (error: Error) => void; f.api.retryEmby.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    let retry!: Promise<void>;
    await act(async () => { retry = f.model.delivery(f.task.id); await f.model.delivery(f.task.id); }); expect(f.api.retryEmby).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error("请先验证 Emby 连接")); await retry; await vi.advanceTimersByTimeAsync(4000); });
    expect(f.element.textContent).toContain("请先验证 Emby 连接"); expect(f.api.retryEmby).toHaveBeenCalledTimes(1);
  });
  it("应用停止后丢弃在途只读响应，缓存丢失的新应用只查询持久状态", async () => {
    const f = await mount(); let release!: (value: TaskPage) => void;
    f.api.listTasks.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const query = f.model.refresh(); await act(async () => { await f.app.stop(); release({ items: [{ ...f.task, title: "停止后迟到" }], total: 1, page: 1, pageSize: 25 }); await query; });
    expect(f.element.textContent).not.toContain("停止后迟到"); const count = f.api.listTasks.mock.calls.length;
    await f.model.refresh(); await vi.advanceTimersByTimeAsync(10000); expect(f.api.listTasks).toHaveBeenCalledTimes(count);
    const restored = await mount(); expect(restored.api.listTasks).toHaveBeenCalledTimes(1); expect(restored.api.retryEmby).not.toHaveBeenCalled(); expect(restored.api.openEmby).not.toHaveBeenCalled();
  });
});
