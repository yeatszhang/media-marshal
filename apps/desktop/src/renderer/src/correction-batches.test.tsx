// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { CoreOutput, DesktopApi, CorrectionBatch, CorrectionPreview, CorrectionOperation } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { CorrectionBatchDraftModel, CorrectionBatchViewModel } from "./correction-batches-model";
import { CorrectionBatchDraftPage, CorrectionBatchPage, CorrectionBatchJobsPage } from "./pages/CorrectionBatches";
import { i18nReady } from "./i18n";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); document.body.innerHTML = ""; });
async function mount(mode: "draft" | "detail" | "list" | "restore" = "detail", changedScope = false) {
  vi.useFakeTimers(); await i18nReady;
  const taskId = crypto.randomUUID(), batchId = crypto.randomUUID(), targetId = crypto.randomUUID(), stamp = new Date().toISOString();
  const members = Array.from({ length: 26 }, (_, index) => ({ taskId: index ? crypto.randomUUID() : taskId, selected: index === 0 || index === 25, targetPath: `/媒体库/旧剧集/S1E${index + 1}.mkv`, selection: { tmdbId: 1, mediaType: "TV_SHOW" as const, season: 1, episode: index + 1, episodeEnd: null }, previewId: index === 0 || index === 25 ? crypto.randomUUID() : null, operation: null as CorrectionOperation | null, failure: null as string | null }));
  const batch: CorrectionBatch = { id: batchId, anchorTaskId: taskId, scope: "SAME_SEASON", configuration: { tmdbId: 2, targetId, template: "{title}/S{season:02d}E{episode:02d}.{ext}", includeAccessories: false, excludedTaskIds: members.filter((item) => !item.selected).map((item) => item.taskId) }, verificationPending: 0, state: "READY", fingerprint: "a".repeat(64), total: 26, selected: 2, previewed: 2, submitted: 0, done: 0, failed: 0, expiresAt: Date.now() + 600000, failure: null, currentTaskId: null, currentPath: null, readBytes: 0, totalBytes: 0, createdAt: stamp, updatedAt: stamp };
  const task: CoreOutput<"corrections.task"> = { taskId, status: "DONE", targetPath: members[0]!.targetPath, selection: members[0]!.selection, previousTaskId: null, nextTaskId: null, active: null, latestOperation: null, preparation: null, targets: [{ id: targetId, path: "/媒体库", available: true }], available: true };
  const previews = new Map(members.filter((item) => item.previewId).map((item) => [item.previewId!, { id: item.previewId!, taskId: item.taskId, title: "正确剧集", selection: { ...item.selection, tmdbId: 2 }, targetId, targetPath: `/媒体库/正确剧集/S1E${item.selection.episode}.mkv`, template: batch.configuration.template, includeAccessories: false, expiresAt: batch.expiresAt!, state: "READY", operationId: null, files: [{ id: crypto.randomUUID(), kind: "MAIN", fromPath: item.targetPath!, toPath: `/媒体库/正确剧集/S1E${item.selection.episode}.mkv`, recoveryPath: null, stagingPath: null, action: "MOVE", phase: null, reason: null, size: 3000 }, { id: crypto.randomUUID(), kind: "ACCESSORY", fromPath: item.targetPath!.replace(".mkv", ".srt"), toPath: item.targetPath!.replace(".mkv", ".srt"), recoveryPath: null, stagingPath: null, action: "KEEP", phase: null, reason: "未选择移动字幕，保留原位", size: 10 }], warnings: ["通用封面保留原位"] } satisfies CorrectionPreview]));
  const api = {
    getCorrectionTask: vi.fn(async () => structuredClone(task)), getOrganizePause: vi.fn(async () => ({ paused: false })),
    getCorrectionScope: vi.fn(async ({ page = 1 }) => ({ fingerprint: changedScope ? "b".repeat(64) : batch.fingerprint, total: members.length, page, items: structuredClone(members.slice((page - 1) * 25, page * 25).map((item) => ({ taskId: item.taskId, targetPath: item.targetPath, selection: item.selection, blockers: [] }))) })),
    getCorrectionBatch: vi.fn(async ({ page = 1 }) => ({ batch: structuredClone(batch), page, items: structuredClone(members.slice((page - 1) * 25, page * 25)) })),
    getCorrectionPreview: vi.fn(async (id: string) => structuredClone(previews.get(id)!)),
    getCorrection: vi.fn(async (id: string) => { const item = members.find((item) => item.operation?.id === id)!, preview = previews.get(item.previewId!)!; return { operation: structuredClone(item.operation!), files: preview.files.map((file) => ({ ...file, phase: file.action === "KEEP" ? null : item.operation!.state === "NEEDS_ATTENTION" ? "NEEDS_ATTENTION" : "DONE", reason: file.action === "KEEP" ? file.reason : item.operation!.failure })), warnings: preview.warnings }; }),
    previewCorrectionBatch: vi.fn(async () => { batch.state = "PREVIEWING"; return structuredClone(batch); }),
    confirmCorrectionBatch: vi.fn(async () => { batch.state = "CONFIRMING"; return structuredClone(batch); }),
    cancelCorrectionBatch: vi.fn(async () => { batch.state = "CANCELED"; return structuredClone(batch); }),
    retryCorrection: vi.fn(async (id: string) => { const op = members.find((item) => item.operation?.id === id)!.operation!; op.state = "RECORDED"; op.failure = null; op.done = 1; op.failed = 0; batch.state = "DONE"; batch.done = 2; batch.failed = 0; return structuredClone(op); }),
    listCorrectionBatches: vi.fn(async () => ({ total: 26, items: [structuredClone(batch)] })),
  };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start(); const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(<StrictMode><MemoryRouter initialEntries={[mode === "draft" ? `/tasks/${taskId}/correction/batch` : mode === "restore" ? `/tasks/${taskId}/correction/batch?from=${batchId}` : mode === "list" ? "/corrections/batches" : `/corrections/batches/${batchId}`]}><ContainerProvider value={app.container}><Routes><Route path="/tasks/:taskId/correction/batch" element={<CorrectionBatchDraftPage />} /><Route path="/corrections/batches/:batchId" element={<CorrectionBatchPage />} /><Route path="/corrections/batches" element={<CorrectionBatchJobsPage />} /><Route path="/tasks/:taskId/correction" element={<p>单条修正</p>} /></Routes></ContainerProvider></MemoryRouter></StrictMode>));
  let mounted = true; const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } }; cleanup.push(async () => { await unmount(); await app.stop(); });
  const operation = (index: number, failed = false): CorrectionOperation => ({ id: crypto.randomUUID(), jobId: crypto.randomUUID(), originalTaskId: members[index]!.taskId, newTaskId: crypto.randomUUID(), title: "正确剧集", state: failed ? "NEEDS_ATTENTION" : "RECORDED", total: 1, done: failed ? 0 : 1, failed: failed ? 1 : 0, failure: failed ? `S1E${index + 1}.mkv 的新位置被占用，请保留不明文件后重试` : null, waitingReason: null, cleanupPending: false, verificationPending: false, createdAt: stamp, updatedAt: stamp });
  return { app, element, taskId, task, batch, members, previews, api, unmount, operation, model: app.container.get(CorrectionBatchViewModel), draft: app.container.get(CorrectionBatchDraftModel) };
}
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === name)!;
const field = (label: string) => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
async function click(name: string) { expect(button(name), name).toBeTruthy(); await act(async () => button(name).click()); }
async function check(label: string) { expect(field(label), label).toBeTruthy(); await act(async () => field(label).click()); }
async function fill(label: string, value: string) { await act(async () => { const node = field(label); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); }
async function review(episode: number) { await click(`展开 S1 E${episode} 完整清单`); await check(`已核对 S1 E${episode} 完整清单`); }
describe("批量修正范围、完整清单与持久作业交互", () => {
  it("完整范围跨页选择，字段编辑与读取不执行，预览携带已核对范围和排除项", async () => {
    const f = await mount("draft"); expect(f.element.textContent).toContain("范围共 26 项"); await check("选择 S1 E1"); await click("下一页"); expect(field("选择 S1 E26").checked).toBe(true); await click("上一页"); expect(field("选择 S1 E1").checked).toBe(false);
    await fill("批量修正 TMDB ID", "0"); await click("核验并生成批量预览"); expect(f.element.textContent).toContain("TMDB 正整数编号"); expect(f.api.previewCorrectionBatch).not.toHaveBeenCalled();
    await fill("批量修正 TMDB ID", "2"); await click("核验并生成批量预览"); expect(f.api.previewCorrectionBatch).toHaveBeenCalledWith(expect.objectContaining({ expectedFingerprint: f.batch.fingerprint, excludedTaskIds: [f.taskId], tmdbId: 2 })); expect(f.api.confirmCorrectionBatch).not.toHaveBeenCalled(); expect(f.element.textContent).toContain("正在核验预览");
  });
  it("从原批次恢复参数和跨页排除项，读取失败提供重试且不改变原批次", async () => {
    const f = await mount("restore"); expect(field("批量修正 TMDB ID").value).toBe("2"); expect(field("批量同时修正同名附属文件").checked).toBe(false); expect(document.querySelector<HTMLTextAreaElement>('[aria-label="批量修正命名模板"]')!.value).toBe(f.batch.configuration.template); expect(field("选择 S1 E2").checked).toBe(false); expect(f.api.previewCorrectionBatch).not.toHaveBeenCalled();
    f.api.getCorrectionScope.mockRejectedValueOnce(new Error("原范围成员已变化，请核对任务")); await click("重新读取完整范围"); expect(f.element.textContent).toContain("原范围成员已变化"); expect(button("核验并生成批量预览").disabled).toBe(true); await click("重新读取完整范围"); expect(button("核验并生成批量预览").disabled).toBe(false);
  });
  it("从旧批次恢复时范围已变化，清除旧排除项并要求重新核对，不显示错误选中数量", async () => {
    const f = await mount("restore", true); expect(f.element.textContent).toContain("完整范围已变化，已恢复全选"); expect(field("选择 S1 E2").checked).toBe(true); expect(f.element.textContent).toContain("已选 26 项，排除 0 项");
    await click("核验并生成批量预览"); expect(f.api.previewCorrectionBatch).toHaveBeenCalledWith(expect.objectContaining({ expectedFingerprint: "b".repeat(64), excludedTaskIds: [] })); expect(f.api.confirmCorrectionBatch).not.toHaveBeenCalled();
  });
  it("批量预览响应不确定时复用请求键，确认不会随读取或编辑重放", async () => {
    const f = await mount("draft"); f.api.previewCorrectionBatch.mockRejectedValueOnce(new Error("响应未收到，请查询原批次")); await click("核验并生成批量预览"); expect(f.element.textContent).toContain("响应未收到"); await click("核验并生成批量预览"); expect(f.api.previewCorrectionBatch.mock.calls[0]).toEqual(f.api.previewCorrectionBatch.mock.calls[1]); expect(f.api.confirmCorrectionBatch).not.toHaveBeenCalled();
  });
  it("必须逐项展开完整清单，跨页保留核对，全部完成且明确确认后才提交一次", async () => {
    const f = await mount(); expect(button("确认并开始整批修正").disabled).toBe(true); expect(field("已核对整批并理解可能部分成功").disabled).toBe(true);
    await review(1); expect(f.element.textContent).toContain("未选择移动字幕，保留原位"); expect(f.element.textContent).toContain("已核对 1/2"); await click("下一页"); await review(26); expect(f.element.textContent).toContain("已核对 2/2"); await click("上一页"); expect(f.element.textContent).toContain("已核对 2/2"); await check("已核对整批并理解可能部分成功"); await click("确认并开始整批修正");
    expect(f.api.confirmCorrectionBatch).toHaveBeenCalledWith({ id: f.batch.id, fingerprint: f.batch.fingerprint, filesComplete: true, requestKey: expect.any(String) }); expect(f.api.confirmCorrectionBatch).toHaveBeenCalledTimes(1); expect(f.element.textContent).toContain("正在确认前复核");
    await click("取消本次批量核验"); expect(f.api.cancelCorrectionBatch).toHaveBeenCalledWith({ id: f.batch.id }); expect(f.element.textContent).toContain("核验已取消");
  });
  it("成员清单读取失败不能勾选，重试后可核对，过期和组件缺失明确阻断", async () => {
    const f = await mount(); f.api.getCorrectionPreview.mockRejectedValueOnce(new Error("该成员预览读取失败，请重新读取")); await click("展开 S1 E1 完整清单"); expect(f.element.textContent).toContain("该成员预览读取失败"); expect(field("已核对 S1 E1 完整清单").disabled).toBe(true); await tick(); expect(field("已核对 S1 E1 完整清单").disabled).toBe(false);
    f.task.available = false; await tick(); expect(f.element.textContent).toContain("安全修正组件不可用"); expect(button("确认并开始整批修正").disabled).toBe(true);
    f.batch.state = "EXPIRED"; await tick(); expect(f.element.textContent).toContain("核心已重启，请重新预览"); expect(button("确认并开始整批修正")).toBeUndefined(); expect(f.api.confirmCorrectionBatch).not.toHaveBeenCalled();
  });
  it("部分失败定位到成员与文件，重试使用原操作编号，保留已完成成员与历史入口", async () => {
    const f = await mount(); f.members[0]!.operation = f.operation(0, true); f.members[25]!.operation = f.operation(25); Object.assign(f.batch, { state: "PARTIAL_FAILED", submitted: 2, done: 1, failed: 1 }); await tick(); await click("展开 S1 E1 完整清单"); expect(f.element.textContent).toContain("新位置被占用"); expect(f.element.textContent).toContain("完成 1 项，需处理 1 项");
    await click("重试 S1 E1 原成员作业"); expect(f.api.retryCorrection).toHaveBeenCalledWith(f.members[0]!.operation!.id); expect(f.api.confirmCorrectionBatch).not.toHaveBeenCalled(); expect(f.api.previewCorrectionBatch).not.toHaveBeenCalled(); expect(f.element.textContent).toContain("选中成员的文件与历史已完成"); expect(f.element.querySelector(`a[href="/tasks/${f.members[0]!.operation!.newTaskId}/correction"]`)).toBeTruthy();
  });
  it("恢复后的目标核验等待不显示整批完成，操作失败不会被正常轮询覆盖", async () => {
    const f = await mount(); f.members[0]!.operation = { ...f.operation(0), verificationPending: true, waitingReason: "恢复备份后正在核对目标" }; Object.assign(f.batch, { state: "SUBMITTED", submitted: 2, done: 0, verificationPending: 1 }); await tick(); await click("展开 S1 E1 完整清单"); expect(f.element.textContent).toContain("历史已记账，正在核对目标"); expect(f.element.textContent).not.toContain("选中成员的文件与历史已完成");
    f.batch.state = "READY"; f.members[0]!.operation = null; await tick(); f.api.confirmCorrectionBatch.mockRejectedValueOnce(new Error("完整范围已变化，请重新预览")); await act(async () => { await f.model.confirm(); }); await tick(); expect(f.element.textContent).toContain("完整范围已变化");
  });
  it("列表分页、页面卸载和 StrictMode 只读取；旧结果迟到不能覆盖已卸载页面", async () => {
    const f = await mount("list"); await click("下一页"); expect(f.api.listCorrectionBatches).toHaveBeenLastCalledWith({ page: 2 }); expect(f.api.previewCorrectionBatch).not.toHaveBeenCalled(); await f.unmount(); const count = f.api.listCorrectionBatches.mock.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(f.api.listCorrectionBatches).toHaveBeenCalledTimes(count); expect(f.app.state).toBe("running");
    const g = await mount(); let release!: (value: CoreOutput<"corrections.batch">) => void; g.api.getCorrectionBatch.mockImplementationOnce(() => new Promise((done) => { release = done; })); let read!: Promise<void>; await act(async () => { read = g.model.refresh(); }); await g.unmount(); const snapshot = await g.api.getCorrectionBatch({ page: 1 }); release(snapshot); await act(async () => { await read; }); expect(g.element.textContent).toBe(""); expect(g.api.confirmCorrectionBatch).not.toHaveBeenCalled();
  });
});
