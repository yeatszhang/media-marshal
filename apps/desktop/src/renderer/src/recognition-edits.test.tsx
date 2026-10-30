// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { CoreInput, DesktopApi, Recognition, RecognitionEditPreview } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { RecognitionEditsViewModel } from "./recognition-edits-model";
import { RecognitionEditor } from "./components/RecognitionEditor";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); document.body.innerHTML = ""; });
async function mount() {
  const task: Recognition = { taskId: crypto.randomUUID(), candidateId: crypto.randomUUID(), revision: 0, matchesStale: false, state: "AWAITING_CONFIRMATION", parsed: { title: "原作品", year: 2026, type: "TV_SHOW", season: 1, episode: 2, episodeEnd: null }, matches: [], failure: null };
  const api = {
    getRecognitionTaskTargets: vi.fn(async () => ({ ruleId: null, targets: [] })), getIngestionTask: vi.fn(async () => task), previewRecognitionEdit: vi.fn(async (input: CoreInput<"ingestion.preview-recognition-edit">): Promise<RecognitionEditPreview> => ({ fingerprint: "a".repeat(64), canApply: true, warnings: [], items: [{ taskId: task.taskId, revision: 0, sourcePath: "/中文来源/Show.S01E02.mp4", before: task.parsed!, after: { ...task.parsed!, ...input.patch }, blockers: [] }] })),
    saveRecognitionEdit: vi.fn(async () => ({ updated: 1, rematchQueued: 0, items: [{ taskId: task.taskId, revision: 1 }] })), confirmOrganize: vi.fn(), previewOrganize: vi.fn(), recognizeIngestion: vi.fn(),
  };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start(); const element = document.createElement("div"); document.body.append(element); const root = createRoot(element), onSaved = vi.fn(), onClose = vi.fn();
  await act(async () => root.render(<StrictMode><ContainerProvider value={app.container}><RecognitionEditor taskIds={[task.taskId]} onClose={onClose} onSaved={onSaved} /></ContainerProvider></StrictMode>));
  let mounted = true; const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } }; cleanup.push(async () => { await unmount(); await app.stop(); });
  return { app, api, task, element, onSaved, onClose, unmount, model: app.container.get(RecognitionEditsViewModel) };
}
const field = (name: string) => document.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
async function click(name: string) { const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === name); expect(button, name).toBeTruthy(); await act(async () => button!.click()); }
async function fill(name: string, value: string) { const input = field(name); await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
describe("单条与批量识别编辑界面", () => {
  it("StrictMode 只读取，改字段不提交，预览与保存均不调用整理", async () => {
    const f = await mount(); expect(f.api.getIngestionTask).toHaveBeenCalled(); expect(f.api.previewRecognitionEdit).not.toHaveBeenCalled();
    await act(async () => field("修改解析标题").click()); await fill("新解析标题", "人工标题"); expect(f.api.saveRecognitionEdit).not.toHaveBeenCalled();
    await click("预览识别字段变化"); expect(f.api.previewRecognitionEdit).toHaveBeenCalledWith({ items: [{ taskId: f.task.taskId, expectedRevision: 0 }], patch: { title: "人工标题" } }); expect(f.element.textContent).toContain("新值：人工标题");
    await click("仅保存识别信息"); expect(f.api.saveRecognitionEdit).toHaveBeenCalledTimes(1); expect(f.onSaved).toHaveBeenCalledTimes(1); expect(f.element.textContent).toContain("已保存 1 项识别信息");
    expect(f.api.confirmOrganize).not.toHaveBeenCalled(); expect(f.api.recognizeIngestion).not.toHaveBeenCalled(); expect(f.api.previewOrganize).not.toHaveBeenCalled();
  });
  it("字段变化使预览失效，重复集逐项展示双方文件与范围，修正后重新预览解除阻断", async () => {
    const f = await mount(); await act(async () => field("修改解析标题").click()); await click("预览识别字段变化"); await fill("新解析标题", "另一作品"); expect(f.element.textContent).not.toContain("逐项变化预览");
    const preview = await f.api.previewRecognitionEdit({ items: [], patch: {} }); f.api.previewRecognitionEdit.mockResolvedValueOnce({ ...preview, canApply: false, items: [{ ...preview.items[0]!, blockers: ["与「重复文件.mp4」重复：S1 E2；请修改集号或取消选择重复文件"] }] });
    await click("预览识别字段变化"); expect(f.element.textContent).toContain("重复文件.mp4"); expect(f.element.textContent).toContain("S1 E2");
    const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "仅保存识别信息")!; expect(save.disabled).toBe(true);
    await fill("新解析标题", "修正后的作品"); await click("预览识别字段变化"); expect(save.isConnected).toBe(false); expect(f.api.saveRecognitionEdit).not.toHaveBeenCalled();
  });
  it("保存响应丢失重用原请求键，重试成功不产生新意图；卸载不停止共享应用", async () => {
    const f = await mount(); await act(async () => field("修改解析标题").click()); await click("预览识别字段变化"); f.api.saveRecognitionEdit.mockRejectedValueOnce(new Error("核心响应丢失，请重试原请求"));
    await click("仅保存识别信息"); expect(f.element.textContent).toContain("核心响应丢失"); await click("仅保存识别信息"); expect(f.api.saveRecognitionEdit.mock.calls[0]).toEqual(f.api.saveRecognitionEdit.mock.calls[1]);
    await f.unmount(); expect(f.app.state).toBe("running"); expect(f.api.confirmOrganize).not.toHaveBeenCalled();
  });
  it("关闭后迟到的预览不能覆盖另一项编辑，也不会发起保存", async () => {
    const f = await mount(); let release!: (value: RecognitionEditPreview) => void;
    const checked = await f.api.previewRecognitionEdit({ items: [], patch: {} }); f.api.previewRecognitionEdit.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const query = f.model.preview({ items: [{ taskId: f.task.taskId, expectedRevision: 0 }], patch: { title: "迟到内容" } });
    await act(async () => { f.model.close(); await f.model.open([f.task.taskId]); release(checked); await query; }); expect(f.element.textContent).not.toContain("逐项变化预览"); expect(f.api.saveRecognitionEdit).not.toHaveBeenCalled();
  });
  it("读取 100 项使用有界并发，为 Core 的 64 个等待名额保留空间", async () => {
    const f = await mount(); let active = 0, maximum = 0; f.api.getIngestionTask.mockClear();
    f.api.getIngestionTask.mockImplementation(async () => { maximum = Math.max(maximum, ++active); if (active > 8) throw new Error("读取并发超过预留额度"); await Promise.resolve(); active--; return f.task; });
    await act(async () => { await f.model.open(Array.from({ length: 100 }, () => crypto.randomUUID())); }); expect(maximum).toBe(8); expect(f.api.getIngestionTask).toHaveBeenCalledTimes(100); expect(f.element.textContent).not.toContain("读取并发超过预留额度"); expect(f.api.saveRecognitionEdit).not.toHaveBeenCalled();
  });
});
