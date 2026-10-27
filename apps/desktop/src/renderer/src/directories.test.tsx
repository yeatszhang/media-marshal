// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { DesktopApi, CoreOutput, RecognitionBatch } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { DirectoryQueuePanel } from "./components/DirectoryQueuePanel";
import { i18nReady } from "./i18n";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); document.body.innerHTML = ""; });
async function mount() {
  vi.useFakeTimers(); await i18nReady; const sourceId = crypto.randomUUID(), candidateId = crypto.randomUUID(), taskId = crypto.randomUUID(), stamp = new Date().toISOString();
  const directory = { id: "a".repeat(64), sourceId, sourceName: "来源一", relativePath: "中文剧集目录", total: 101, ready: 1, awaiting: 100, bytes: 1010 };
  const detail: CoreOutput<"ingestion.directory"> = { directory, items: [{ candidate: { id: candidateId, sourceId, relativePath: "中文剧集目录/01.mp4", size: 10, state: "READY", taskId: null, reason: null, requiresConfirmation: true, updatedAt: stamp }, task: null }, { candidate: { id: crypto.randomUUID(), sourceId, relativePath: "中文剧集目录/02.mp4", size: 10, state: "QUEUED", taskId, reason: null, requiresConfirmation: true, updatedAt: stamp }, task: { taskId, candidateId: crypto.randomUUID(), state: "AWAITING_CONFIRMATION", parsed: null, matches: [], failure: null } }], options: [{ tmdbId: 7, mediaType: "TV_SHOW", title: "目录作品", originalTitle: null, year: 2026, confidence: 0.8, evidence: "filename", explanation: "2/101 个文件有此候选，仍须逐项检查", supportedFiles: 2, common: false }] };
  const job: RecognitionBatch = { id: crypto.randomUUID(), state: "PENDING", total: 1, submitted: 0, failed: 0, recognitionFailed: 0, pending: 1, createdAt: stamp, updatedAt: stamp };
  const api = { listIngestionDirectories: vi.fn(async () => ({ items: [directory], total: 1 })), getIngestionDirectory: vi.fn(async () => detail), listRecognitionBatches: vi.fn(async () => ({ items: [job], total: 1 })), listRecognitionBatchItems: vi.fn(async () => ({ items: [{ candidateId, relativePath: "01.mp4", state: "PENDING", taskId: null, taskState: null, failure: null, waitingReason: "等待原磁盘恢复" }], total: 1 })), recognizeIngestionBatch: vi.fn(async () => job), cancelRecognitionBatch: vi.fn(async () => ({ ...job, state: "CANCELLED" })), confirmOrganize: vi.fn() };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start(); const element = document.createElement("div"); document.body.append(element); const root = createRoot(element), inspect = vi.fn(), edit = vi.fn(), organize = vi.fn();
  await act(async () => root.render(<StrictMode><ContainerProvider value={app.container}><DirectoryQueuePanel onInspect={inspect} onEdit={edit} onOrganize={organize} /></ContainerProvider></StrictMode>));
  let mounted = true; const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } }; cleanup.push(async () => { await unmount(); await app.stop(); });
  return { app, api, directory, candidateId, taskId, element, edit, organize, inspect, unmount };
}
async function click(name: string) { const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === name); expect(node, name).toBeTruthy(); await act(async () => node!.click()); }
describe("目录摘要与持久识别批次界面", () => {
  it("目录摘要覆盖整组但只提交明确选择的本页未识别文件，摘要和字段选择不执行 COPY", async () => {
    const f = await mount(); expect(f.api.recognizeIngestionBatch).not.toHaveBeenCalled(); await click("查看目录文件"); expect(f.element.textContent).toContain("整组 101 项"); expect(f.element.textContent).toContain("部分文件支持"); expect(f.element.textContent).not.toContain("全部文件的共同候选");
    await click("选择本页可处理文件"); await click("编辑所选识别信息（1）"); expect(f.edit).toHaveBeenCalledWith([f.taskId]); expect(f.api.recognizeIngestionBatch).not.toHaveBeenCalled();
    await click("用于所选文件生成计划（1）"); expect(f.organize).toHaveBeenCalledWith([f.taskId], { tmdbId: 7, mediaType: "TV_SHOW" }); expect(f.api.confirmOrganize).not.toHaveBeenCalled();
    await click("提交所选文件识别（1）"); expect(f.api.recognizeIngestionBatch).toHaveBeenCalledWith({ candidateIds: [f.candidateId], requestKey: expect.any(String) }); expect(f.element.textContent).toContain("等待原磁盘恢复"); expect(f.api.confirmOrganize).not.toHaveBeenCalled();
    const count = f.api.recognizeIngestionBatch.mock.calls.length; await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); expect(f.api.recognizeIngestionBatch).toHaveBeenCalledTimes(count);
  });
  it("响应丢失重试同一请求键，轮询不清除操作错误，不重放旧批次", async () => {
    const f = await mount(); await click("查看目录文件"); await click("选择本页可处理文件"); f.api.recognizeIngestionBatch.mockRejectedValueOnce(new Error("提交响应丢失，请重试原请求")); await click("提交所选文件识别（1）"); await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(f.element.textContent).toContain("提交响应丢失");
    await click("提交所选文件识别（1）"); expect(f.api.recognizeIngestionBatch.mock.calls[0]).toEqual(f.api.recognizeIngestionBatch.mock.calls[1]); expect(f.api.recognizeIngestionBatch).toHaveBeenCalledTimes(2);
  });
  it("取消只停止后续提交，切页清理本页选择，卸载释放轮询而不停止共享应用", async () => {
    const f = await mount(); await click("查看目录文件"); await click("选择本页可处理文件"); await click("下一页文件"); expect(f.element.textContent).toContain("提交所选文件识别（0）"); await click("停止后续识别提交"); expect(f.api.cancelRecognitionBatch).toHaveBeenCalledTimes(1); expect(f.element.textContent).toContain("已经提交的识别任务保留");
    await f.unmount(); const count = f.api.listRecognitionBatches.mock.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(f.api.listRecognitionBatches).toHaveBeenCalledTimes(count); expect(f.app.state).toBe("running");
  });
});
