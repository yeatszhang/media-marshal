// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { CoreOutput, DesktopApi, CorrectionPreview, CorrectionPreparation, CorrectionOperation } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { CorrectionViewModel } from "./corrections-model";
import { CorrectionPage, CorrectionJobsPage } from "./pages/Corrections";
import { i18nReady } from "./i18n";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); document.body.innerHTML = ""; });
async function mount(options: { restored?: boolean; unavailable?: boolean; jobs?: boolean } = {}) {
  vi.useFakeTimers(); await i18nReady;
  const taskId = crypto.randomUUID(), targetId = crypto.randomUUID(), previewId = crypto.randomUUID(), operationId = crypto.randomUUID(), newTaskId = crypto.randomUUID(), stamp = new Date().toISOString();
  const files: CorrectionPreview["files"] = [{ id: crypto.randomUUID(), kind: "MAIN", fromPath: "/媒体库/旧作品/旧片.mkv", toPath: "/媒体库/新作品/新片.mkv", recoveryPath: null, stagingPath: null, size: 3000, action: "MOVE", phase: null, reason: null }, { id: crypto.randomUUID(), kind: "ACCESSORY", fromPath: "/媒体库/旧作品/旧片.zh.srt", toPath: "/媒体库/新作品/新片.zh.srt", recoveryPath: null, stagingPath: null, size: 300, action: "MOVE", phase: null, reason: null }];
  const preview: CorrectionPreview = { id: previewId, taskId, title: "新作品", selection: { tmdbId: 2, mediaType: "MOVIE", season: null, episode: null, episodeEnd: null }, targetId, targetPath: files[0]!.toPath, template: "{title}/{title}.{ext}", includeAccessories: false, expiresAt: Date.now() + 600000, state: "READY", operationId: null, files, warnings: ["通用封面留在原目录"] };
  const operation: CorrectionOperation = { id: operationId, jobId: crypto.randomUUID(), originalTaskId: taskId, newTaskId, state: "PLANNED", title: "新作品", total: 2, done: 0, failed: 0, failure: null, waitingReason: null, cleanupPending: true, createdAt: stamp, updatedAt: stamp };
  const preparation: CorrectionPreparation = { id: crypto.randomUUID(), taskId, kind: "PREVIEW", state: "READY", previewId, operationId: null, currentPath: files[0]!.fromPath, readBytes: 3000, totalBytes: 3000, failure: null, createdAt: stamp, updatedAt: stamp };
  const task: CoreOutput<"corrections.task"> = { taskId, status: "DONE", targetPath: files[0]!.fromPath, selection: { tmdbId: 1, mediaType: "MOVIE", season: null, episode: null, episodeEnd: null }, previousTaskId: null, nextTaskId: null, active: null, latestOperation: null, preparation: options.restored ? preparation : null, targets: [{ id: targetId, path: "/媒体库", available: true }], available: !options.unavailable };
  const detail: CoreOutput<"corrections.get"> = { operation, files: structuredClone(files), warnings: [] };
  const api = { getCorrectionTask: vi.fn(async () => structuredClone(task)), getCorrectionPreview: vi.fn(async () => structuredClone(preview)), getCorrection: vi.fn(async () => structuredClone(detail)), getOrganizePause: vi.fn(async () => ({ paused: false })), listCorrections: vi.fn(async () => ({ items: [operation], total: 26 })), previewCorrection: vi.fn(async () => { task.preparation = { ...preparation, id: crypto.randomUUID(), state: "PENDING", previewId: null }; return structuredClone(task.preparation); }), confirmCorrection: vi.fn(async () => { task.active = operation; task.latestOperation = operation; task.preparation = { ...preparation, kind: "CONFIRM", operationId, previewId: null }; return structuredClone(task.preparation); }), cancelCorrectionPreparation: vi.fn(async () => { task.preparation = { ...task.preparation!, state: "CANCELED" }; return structuredClone(task.preparation); }), retryCorrection: vi.fn(async () => { operation.state = "RECORDED"; operation.done = 2; operation.failed = 0; operation.failure = null; task.active = null; task.status = "CORRECTED"; task.nextTaskId = newTaskId; return structuredClone(operation); }) };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start(); const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(<StrictMode><MemoryRouter initialEntries={[options.jobs ? "/corrections" : `/tasks/${taskId}/correction`]}><ContainerProvider value={app.container}><Routes><Route path="/tasks/:taskId/correction" element={<CorrectionPage />} /><Route path="/corrections" element={<CorrectionJobsPage />} /></Routes></ContainerProvider></MemoryRouter></StrictMode>));
  let mounted = true; const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } }; cleanup.push(async () => { await unmount(); await app.stop(); });
  return { app, element, api, task, preview, preparation, operation, detail, unmount, model: app.container.get(CorrectionViewModel) };
}
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === name)!;
const input = (label: string) => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
async function click(name: string) { expect(button(name), name).toBeTruthy(); await act(async () => button(name).click()); }
async function fill(label: string, value: string) { await act(async () => { const field = input(label); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); }
describe("单条修正参数、确认、恢复与失败处理", () => {
  it("剧集季集错误定位到字段，修正其他字段不掩盖剩余错误，有效输入才请求预览", async () => {
    const f = await mount(); await act(async () => { const select = document.querySelector<HTMLSelectElement>('[aria-label="修正媒体类型"]')!; select.value = "TV_SHOW"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await fill("修正季号", "错误季号"); await fill("修正起始集号", "5"); await fill("修正结束集号（合并集可选）", "3"); await click("核验并预览修正"); expect(f.element.textContent).toContain("季号须为 0～999"); expect(f.element.textContent).toContain("结束集号须不小于起始集号"); expect(f.api.previewCorrection).not.toHaveBeenCalled();
    await fill("修正结束集号（合并集可选）", "5"); expect(f.element.textContent).toContain("季号须为 0～999"); await fill("修正季号", "0"); await click("核验并预览修正"); expect(f.api.previewCorrection).toHaveBeenCalledWith(expect.objectContaining({ selection: { tmdbId: 1, mediaType: "TV_SHOW", season: 0, episode: 5, episodeEnd: 5 } })); expect(f.api.confirmCorrection).not.toHaveBeenCalled();
  });
  it("预览响应不确定时重试同一请求键，成功返回后再预览生成新请求", async () => {
    const f = await mount(); f.api.previewCorrection.mockRejectedValueOnce(new Error("核验请求响应未收到，请查询原状态")); await click("核验并预览修正"); await tick(); expect(f.element.textContent).toContain("响应未收到"); await click("核验并预览修正"); expect(f.api.previewCorrection.mock.calls[0]).toEqual(f.api.previewCorrection.mock.calls[1]); expect(f.api.confirmCorrection).not.toHaveBeenCalled();
  });
  it("编辑和读取不提交文件操作，核验未完成不能确认，修改参数立即使旧预览失效", async () => {
    const f = await mount(); await fill("修正 TMDB ID", "0"); await click("核验并预览修正"); expect(f.element.textContent).toContain("TMDB 正整数编号"); expect(f.api.previewCorrection).not.toHaveBeenCalled();
    await fill("修正 TMDB ID", "2"); await click("核验并预览修正"); expect(f.element.textContent).toContain("等待读取文件"); expect(f.api.confirmCorrection).not.toHaveBeenCalled(); expect(button("确认并开始修正")).toBeUndefined();
    f.task.preparation = { ...f.preparation }; await tick(); expect(f.element.textContent).toContain("/媒体库/新作品/新片.mkv"); expect(button("确认并开始修正").disabled).toBe(true);
    await fill("修正 TMDB ID", "3"); await tick(); expect(button("确认并开始修正")).toBeUndefined(); expect(f.api.confirmCorrection).not.toHaveBeenCalled(); await click("核验并预览修正"); expect(f.api.previewCorrection.mock.calls[0]![0].requestKey).not.toBe(f.api.previewCorrection.mock.calls[1]![0].requestKey);
  });
  it("恢复预览还原作品与模板，完整确认后逐文件显示失败，重试只提交原作业编号", async () => {
    const f = await mount({ restored: true }); expect(input("修正 TMDB ID").value).toBe("2"); expect(document.querySelector<HTMLTextAreaElement>('[aria-label="修正命名模板"]')!.value).toBe("{title}/{title}.{ext}"); expect(input("同时修正同名附属文件").checked).toBe(false); expect(f.api.previewCorrection).not.toHaveBeenCalled();
    await act(async () => input("已核对完整修正文件清单").click()); await click("确认并开始修正"); expect(f.api.confirmCorrection).toHaveBeenCalledWith({ previewId: f.preview.id, requestKey: expect.any(String), filesComplete: true });
    Object.assign(f.operation, { state: "NEEDS_ATTENTION", done: 1, failed: 1, failure: "新片.zh.srt 的目标被占用，请保留不明文件并处理后重试" }); f.detail.files[0]!.phase = "DONE"; Object.assign(f.detail.files[1]!, { phase: "NEEDS_ATTENTION", reason: "新片.zh.srt 的目标被占用", recoveryPath: "/媒体库/.media-marshal/relocations/测试/source" }); await tick(); expect(f.element.textContent).toContain("1/2 项文件完成"); expect(f.element.textContent).toContain("新片.zh.srt 的目标被占用"); expect(f.element.textContent).toContain("查看恢复核对位置");
    await click("核对并重试原修正"); expect(f.api.retryCorrection).toHaveBeenCalledWith(f.operation.id); expect(f.api.confirmCorrection).toHaveBeenCalledTimes(1); expect(f.element.textContent).toContain("媒体文件与历史已完成"); expect(f.element.querySelector(`a[href="/tasks/${f.operation.newTaskId}/correction"]`)).toBeTruthy();
  });
  it("取消只发送核验编号，轮询和卸载不重放确认，页面释放后应用保持运行", async () => {
    const f = await mount(); await click("核验并预览修正"); const id = f.task.preparation!.id; await click("取消本次核验"); expect(f.api.cancelCorrectionPreparation).toHaveBeenCalledWith(id); expect(f.element.textContent).toContain("核验已取消"); await tick(); expect(f.api.confirmCorrection).not.toHaveBeenCalled();
    await f.unmount(); const count = f.api.getCorrectionTask.mock.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(f.api.getCorrectionTask).toHaveBeenCalledTimes(count); expect(f.app.state).toBe("running");
  });
  it("已记账作业的现存文件核对失败，不显示本次媒体已经成功的提示", async () => {
    const f = await mount(); f.task.status = "CORRECTED"; f.task.nextTaskId = f.operation.newTaskId; f.task.latestOperation = f.operation; Object.assign(f.operation, { state: "RECORDED", done: 2, failure: "恢复备份后媒体目标证据不符，请保留现存文件并核对" }); await tick();
    expect(f.element.textContent).toContain("历史已记账，仍需核对"); expect(f.element.textContent).toContain("下方完成状态来自原步骤记录"); expect(f.element.textContent).not.toContain("媒体文件与历史已完成；Emby"); expect(button("核对并重试原修正")).toBeTruthy();
  });
  it("过期、组件缺失和查询失败提供具体下一步，轮询不能覆盖操作失败", async () => {
    const f = await mount({ restored: true }); f.preview.state = "EXPIRED"; await tick(); expect(f.element.textContent).toContain("预览已过期或核心已重启"); expect(button("确认并开始修正")).toBeUndefined();
    f.task.available = false; await tick(); expect(button("核验并预览修正").matches(":disabled")).toBe(true); expect(f.element.textContent).toContain("安全修正组件不可用"); f.task.available = true; await tick(); f.api.previewCorrection.mockRejectedValueOnce(new Error("媒体原卷离线，请连接原盘后重试")); await click("核验并预览修正"); await tick(); expect(f.element.textContent).toContain("媒体原卷离线"); expect(f.api.confirmCorrection).not.toHaveBeenCalled();
    f.api.getCorrectionTask.mockRejectedValueOnce(new Error("核心正在恢复，请稍后刷新")); await tick(); expect(f.element.textContent).toContain("核心正在恢复"); expect(button("核验并预览修正").matches(":disabled")).toBe(true);
  });
  it("已修正任务只读历史，作业分页不走旧整理或自动重试", async () => {
    const f = await mount({ jobs: true }); expect(f.element.textContent).toContain("等待执行"); await click("下一页"); expect(f.api.listCorrections).toHaveBeenLastCalledWith({ page: 2 }); expect(f.api.confirmCorrection).not.toHaveBeenCalled(); await f.unmount();
    const g = await mount(); g.task.status = "CORRECTED"; g.task.nextTaskId = crypto.randomUUID(); g.task.latestOperation = g.operation; g.operation.state = "RECORDED"; await tick(); expect(button("核验并预览修正")).toBeUndefined(); expect(g.element.textContent).toContain("此任务已修正"); expect(g.api.retryCorrection).not.toHaveBeenCalled();
  });
  it("旧请求迟到与应用停止后的结果不能覆盖当前任务", async () => {
    const f = await mount(); let release!: (value: CoreOutput<"corrections.task">) => void; f.api.getCorrectionTask.mockImplementationOnce(() => new Promise((done) => { release = done; })); let read!: Promise<void>; await act(async () => { read = f.model.refresh(); });
    await f.unmount(); await f.app.stop(); release({ ...f.task, targetPath: "/不应出现的迟到路径" }); await act(async () => { await read; }); expect(f.element.textContent).not.toContain("迟到路径"); const count = f.api.getCorrectionTask.mock.calls.length; await f.model.refresh(); await vi.advanceTimersByTimeAsync(3000); expect(f.api.getCorrectionTask).toHaveBeenCalledTimes(count);
  });
});
