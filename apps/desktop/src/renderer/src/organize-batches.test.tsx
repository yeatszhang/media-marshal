// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { DesktopApi, OrganizeBatch, Recognition, CoreOutput } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { OrganizeBatchesViewModel } from "./organize-batches-model";
import { OrganizeBatchEditor, OrganizeBatchPanel } from "./components/OrganizeBatchPanel";
import { i18nReady } from "./i18n";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); document.body.innerHTML = ""; });
async function mount(draftOpen = false) {
  vi.useFakeTimers(); await i18nReady;
  const tasks: Recognition[] = [1, 2].map((episode) => ({ taskId: crypto.randomUUID(), candidateId: crypto.randomUUID(), sourcePath: `/中文来源/作品.S01E0${episode}.mkv`, revision: 3, state: "AWAITING_CONFIRMATION", parsed: { title: "测试作品", year: 2026, type: "TV_SHOW", season: 1, episode, episodeEnd: null }, matches: [], failure: null }));
  const stamp = new Date().toISOString(), batch: OrganizeBatch = { id: crypto.randomUUID(), state: "READY", total: 2, previewed: 2, blocked: 0, submitted: 0, done: 0, failed: 0, expiresAt: Date.now() + 600000, failure: null, createdAt: stamp, updatedAt: stamp };
  const detail: CoreOutput<"ingestion.organize-batch"> = { batch, page: 1, items: tasks.map((task, index) => ({ taskId: task.taskId, sourcePath: task.sourcePath!, state: "READY", selection: { tmdbId: 7, mediaType: "TV_SHOW", season: 1, episode: index + 1 }, preview: { id: crypto.randomUUID(), taskId: task.taskId, title: "测试作品", mediaType: "TV_SHOW", sourcePath: task.sourcePath!, targetPath: `/媒体库/作品/S01E0${index + 1}.mkv`, size: 100, season: 1, episode: index + 1, episodeEnd: null, expiresAt: batch.expiresAt, operationId: null, accessories: [] }, accessoryCount: 1, operationId: null, operationState: null, errors: [], waitingReason: null })) };
  const api = { getIngestionTask: vi.fn(async (id: string) => tasks.find((task) => task.taskId === id)!), listOrganizeBatches: vi.fn(async () => ({ items: [batch], total: 1 })), getOrganizeBatch: vi.fn(async () => detail), getOrganizeBatchAssets: vi.fn(async () => ({ items: [{ sourcePath: "/中文来源/对白.srt", targetPath: "/媒体库/对白.srt", size: 20 }] })), previewOrganizeBatch: vi.fn(async () => batch), confirmOrganizeBatch: vi.fn(async () => ({ ...batch, state: "CONFIRMING" as const })), cancelOrganizeBatch: vi.fn(async () => ({ ...batch, state: "CANCELLED" as const })), confirmOrganize: vi.fn() };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start(); const element = document.createElement("div"); document.body.append(element); const root = createRoot(element), onClose = vi.fn(), onInspect = vi.fn();
  await act(async () => root.render(<StrictMode><ContainerProvider value={app.container}><OrganizeBatchEditor taskIds={tasks.map((task) => task.taskId)} work={{ tmdbId: 7, mediaType: "TV_SHOW" }} onClose={onClose} /><OrganizeBatchPanel draftOpen={draftOpen} onInspect={onInspect} /></ContainerProvider></StrictMode>));
  let mounted = true; const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } }; cleanup.push(async () => { await unmount(); await app.stop(); });
  return { app, api, tasks, batch, detail, element, onClose, onInspect, unmount, model: app.container.get(OrganizeBatchesViewModel) };
}
const field = (name: string) => document.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === name)!;
async function click(name: string) { expect(button(name), name).toBeTruthy(); await act(async () => button(name).click()); }
async function fill(name: string, value: string) { await act(async () => { const input = field(name); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
describe("共同作品草稿与批量整理确认界面", () => {
  it("候选填入、季集编辑和取消选择仅影响草稿，明确预览后保存意图且不确认 COPY", async () => {
    const f = await mount(true); await click("查看本批逐项计划"); expect(field("确认本批文件完整并核对计划").disabled).toBe(true); expect(f.element.textContent).toContain("当前有未提交的整理草稿"); expect(field("共同 TMDB 作品 ID").value).toBe("7"); await fill(`季号 ${f.tasks[0]!.sourcePath}`, "2"); await act(async () => field(`保留整理文件 ${f.tasks[1]!.sourcePath}`).click());
    expect(f.api.previewOrganizeBatch).not.toHaveBeenCalled(); await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); expect(f.api.confirmOrganizeBatch).not.toHaveBeenCalled(); await click("生成所选文件的整理预览");
    expect(f.api.previewOrganizeBatch).toHaveBeenCalledWith({ requestKey: expect.any(String), includeAccessories: true, items: [{ taskId: f.tasks[0]!.taskId, expectedRevision: 3, selection: { tmdbId: 7, mediaType: "TV_SHOW", season: 2, episode: 1, episodeEnd: null } }] }); expect(f.onClose).toHaveBeenCalledTimes(1); expect(f.api.confirmOrganize).not.toHaveBeenCalled(); expect(f.api.confirmOrganizeBatch).not.toHaveBeenCalled();
  });
  it("失败重试沿同一预览标识，阻断明细定位双方文件，修正草稿可发起新预览", async () => {
    const f = await mount(); f.api.previewOrganizeBatch.mockRejectedValueOnce(new Error("预览响应丢失，请重试原草稿")); await click("生成所选文件的整理预览"); await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(f.element.textContent).toContain("预览响应丢失"); await click("生成所选文件的整理预览"); expect(f.api.previewOrganizeBatch.mock.calls[0]).toEqual(f.api.previewOrganizeBatch.mock.calls[1]);
    f.detail.batch = { ...f.batch, state: "BLOCKED", blocked: 2 }; f.detail.items.forEach((item) => item.errors = ["作品.S01E01.mkv 与作品.S01E02.mkv 重叠：S1 E2；请修正或取消重复文件"]); await act(async () => f.model.inspect(f.batch.id)); expect(f.element.textContent).toContain("S1 E2"); expect(button("确认提交本批 COPY（2）")).toBeUndefined();
    await fill(`起始集号 ${f.tasks[0]!.sourcePath}`, "3"); await click("生成所选文件的整理预览"); expect(f.api.previewOrganizeBatch.mock.calls[2]).not.toEqual(f.api.previewOrganizeBatch.mock.calls[1]);
  });
  it("完整确认是必要动作，附属文件按需读取，轮询和重载查询不重放变更", async () => {
    const f = await mount(); await click("查看本批逐项计划"); expect(button("确认提交本批 COPY（2）").disabled).toBe(true); expect(f.api.getOrganizeBatchAssets).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>('.organize-batch-item button')!.click()); expect(f.api.getOrganizeBatchAssets).toHaveBeenCalledWith({ id: f.batch.id, taskId: f.tasks[0]!.taskId }); expect(f.element.textContent).toContain("对白.srt");
    await act(async () => field("确认本批文件完整并核对计划").click()); await click("确认提交本批 COPY（2）"); expect(f.api.confirmOrganizeBatch).toHaveBeenCalledWith({ id: f.batch.id, requestKey: expect.any(String), filesComplete: true }); await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(f.api.confirmOrganizeBatch).toHaveBeenCalledTimes(1);
    await f.unmount(); const n = f.api.listOrganizeBatches.mock.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(f.api.listOrganizeBatches).toHaveBeenCalledTimes(n); expect(f.app.state).toBe("running");
  });
  it("取消只停止后续提交，晚到预览不能关闭后来打开的草稿", async () => {
    const f = await mount(); await click("停止本批后续处理"); expect(f.api.cancelOrganizeBatch).toHaveBeenCalledWith(f.batch.id); expect(f.element.textContent).toContain("已经提交的 COPY 和文件继续保留");
    let resolve!: (batch: OrganizeBatch) => void; f.api.previewOrganizeBatch.mockImplementationOnce(() => new Promise((done) => { resolve = done; })); await click("生成所选文件的整理预览"); await f.unmount(); await act(async () => resolve(f.batch)); expect(f.onClose).not.toHaveBeenCalled();
  });
});
