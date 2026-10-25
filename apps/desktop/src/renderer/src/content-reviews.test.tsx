// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import { MemoryRouter } from "react-router-dom";
import { sourceConfigurationSchema, type ContentReview, type DesktopApi, type SourceRule } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { ContentReviewsViewModel } from "./content-reviews-model";
import { ContentReviewsPanel } from "./components/ContentReviewsPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); document.body.innerHTML = ""; vi.useRealTimers(); });
async function mount() {
  vi.useFakeTimers(); const sourceId = crypto.randomUUID(), stamp = new Date().toISOString();
  const configuration = sourceConfigurationSchema.parse({ type: "local", name: "已有中文输入", sourcePath: "/输入", organization: { targetPath: "/媒体库" } });
  const source: SourceRule = { id: sourceId, type: "local", version: 1, draftRevision: 1, draft: configuration, configuration, paused: false, reviewRequired: false, localSourceId: sourceId, subscriptionId: null, ingestionSourceId: null, createdAt: stamp, updatedAt: stamp };
  let rows: ContentReview[] = [];
  const job = (): ContentReview => ({ id: crypto.randomUUID(), sourceId, sourceVersion: 1, state: "RUNNING", total: 1, checked: 0, changed: 0, baselined: 0, failed: 0, currentPath: "中文长名称_".repeat(20) + ".mp4", failure: null, createdAt: stamp, updatedAt: stamp });
  const api = {
    listContentReviews: vi.fn(async () => ({ items: structuredClone(rows), total: rows.length })),
    listContentReviewFiles: vi.fn(async () => ({ total: 1, items: [{ relativePath: "已复核.mp4", state: "CHANGED" as const, candidateId: crypto.randomUUID(), failure: null }] })),
    reviewIngestionContent: vi.fn(async () => { const row = job(); rows = [row]; return row; }),
    cancelContentReview: vi.fn(async (id: string) => { rows = rows.map((row) => row.id === id ? { ...row, state: "CANCELLED", currentPath: null } : row); return rows.find((row) => row.id === id)!; }),
  };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start(); const model = app.container.get(ContentReviewsViewModel);
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(<StrictMode><MemoryRouter><ContainerProvider value={app.container}><ContentReviewsPanel sources={[source]} /></ContainerProvider></MemoryRouter></StrictMode>));
  cleanup.push(async () => { await act(async () => root.unmount()); await app.stop(); });
  return { element, api, source, model, job, setRows(value: ContentReview[]) { rows = value; } };
}
const click = async (name: string) => { const button = [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === name)!; expect(button).toBeTruthy(); await act(async () => button.click()); };
describe("只读内容复核界面", () => {
  it("StrictMode 与轮询只查询，命令响应丢失保留请求标识，取消仅作用指定作业", async () => {
    const f = await mount(); expect(f.api.reviewIngestionContent).not.toHaveBeenCalled(); expect(f.api.cancelContentReview).not.toHaveBeenCalled();
    const row = f.job(); f.api.reviewIngestionContent.mockImplementationOnce(async () => { f.setRows([row]); throw new Error("复核响应丢失，请重试查询"); });
    await click("开始全量内容复核"); expect(f.element.textContent).toContain("复核响应丢失");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(f.element.textContent).toContain("正在复核"); expect(f.element.textContent).toContain("复核响应丢失"); expect(f.api.reviewIngestionContent).toHaveBeenCalledOnce();
    f.api.reviewIngestionContent.mockResolvedValueOnce(row); await click("开始全量内容复核"); expect(f.api.reviewIngestionContent.mock.calls[1]).toEqual(f.api.reviewIngestionContent.mock.calls[0]);
    await click("查看逐项结果"); expect(f.element.textContent).toContain("已复核.mp4"); expect(f.element.textContent).toContain("发现内容变化");
    await click("取消复核"); expect(f.api.cancelContentReview).toHaveBeenCalledWith(row.id); expect(f.element.textContent).toContain("已取消");
    expect(f.element.querySelector('progress[aria-label="内容复核进度"]')).toBeNull();
  });
  it("关闭结果或切换作业后迟到查询不能覆盖当前选择，错误显示文件对象", async () => {
    const f = await mount(), first = f.job(), second = { ...f.job(), state: "PARTIAL_FAILED" as const, checked: 1, failed: 1, failure: "一个文件无法读取，请核对权限" }; f.setRows([first, second]); await act(async () => f.model.refresh());
    let finish!: (value: Awaited<ReturnType<DesktopApi["listContentReviewFiles"]>>) => void;
    f.api.listContentReviewFiles.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let old!: Promise<void>; await act(async () => { old = f.model.showFiles(first.id); });
    await act(async () => { await f.model.showFiles(second.id); }); await act(async () => { finish({ total: 1, items: [{ relativePath: "迟到结果.mp4", state: "FAILED", candidateId: null, failure: "旧作业错误" }] }); await old; });
    expect(f.model.state.detail?.id).toBe(second.id); expect(f.element.textContent).not.toContain("迟到结果.mp4"); expect(f.element.textContent).toContain("一个文件无法读取");
    await click("收起结果"); expect(f.element.querySelector('[aria-label="内容复核逐项结果"]')).toBeNull(); expect(f.api.reviewIngestionContent).not.toHaveBeenCalled();
  });
  it("查询分页保留原作业标识，来源暂停时禁用开始按钮并解释首次基线", async () => {
    const f = await mount(); f.source.paused = true; const row = f.job(); f.setRows([row]); await act(async () => f.model.refresh());
    const start = [...f.element.querySelectorAll("button")].find((node) => node.textContent === "开始全量内容复核")!; expect(start.disabled).toBe(true);
    expect(f.element.textContent).toContain("已暂停"); expect(f.element.textContent).toContain("首次只建立内容基线");
    await act(async () => { await f.model.showFiles(row.id, 2); }); expect(f.api.listContentReviewFiles).toHaveBeenLastCalledWith({ id: row.id, page: 2 });
    expect(f.api.reviewIngestionContent).not.toHaveBeenCalled();
  });
});
