// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { CoreOutput, DesktopApi, OrganizePreview } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { Ingestion } from "./pages/Ingestion";
import { i18nReady } from "./i18n";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); document.body.innerHTML = ""; });
async function mount() {
  vi.useFakeTimers(); await i18nReady; const taskId = crypto.randomUUID(), candidateId = crypto.randomUUID(), sourceId = crypto.randomUUID();
  const task: CoreOutput<"ingestion.task"> = { taskId, candidateId, sourcePath: "/来源/待确认片.mkv", state: "AWAITING_CONFIRMATION", parsed: { title: "待确认片", year: 2026, type: "MOVIE", season: null, episode: null, episodeEnd: null }, matches: [{ tmdbId: 7, mediaType: "MOVIE", title: "正确影片", originalTitle: null, year: 2026, confidence: 0.8, evidence: "filename", explanation: "人工核对候选" }], failure: null };
  const api = { listIngestionCandidates: vi.fn(async () => ({ total: 1, items: [{ id: candidateId, sourceId, taskId, relativePath: "待确认片.mkv", size: 20, state: "QUEUED", reason: null, requiresConfirmation: true, updatedAt: new Date().toISOString() }] })), listSourceRules: vi.fn(async () => []), getIngestionTask: vi.fn(async () => structuredClone(task)), listOrganizeBatches: vi.fn(async () => ({ items: [], total: 0 })), listContentReviews: vi.fn(async () => ({ items: [], total: 0 })), listIngestionScans: vi.fn(async () => ({ items: [], total: 0 })), previewOrganize: vi.fn(async (): Promise<OrganizePreview> => ({ id: crypto.randomUUID(), taskId, sourcePath: "/来源/待确认片.mkv", targetPath: "/媒体库/正确影片/正确影片.mkv", title: "正确影片", mediaType: "MOVIE", season: null, episode: null, episodeEnd: null, size: 20, expiresAt: Date.now() + 5000, operationId: null, accessories: [] })), confirmOrganize: vi.fn(async () => ({ operationId: crypto.randomUUID() })), previewOrganizeBatch: vi.fn() };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start(); const element = document.createElement("div"); document.body.append(element); let root = createRoot(element), mounted = true;
  const render = () => act(async () => root.render(<StrictMode><MemoryRouter initialEntries={[{ pathname: "/review", state: { taskId } }]}><ContainerProvider value={app.container}><Ingestion /></ContainerProvider></MemoryRouter></StrictMode>));
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  const remount = async () => { await unmount(); root = createRoot(element); mounted = true; await render(); };
  await render(); cleanup.push(async () => { await unmount(); await app.stop(); }); return { api, element, app, task, unmount, remount };
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)!;
async function click(text: string) { expect(button(text), text).toBeTruthy(); await act(async () => button(text).click()); }
async function preview() { await click("选择此作品"); await click("预览 COPY 计划"); }
describe("单条整理与分组草稿的确认边界", () => {
  it("离页释放待处理轮询，共享应用保留；重新挂载只恢复核心 DTO，不重放识别或 COPY", async () => {
    const f = await mount(); expect(f.element.textContent).toContain("正确影片"); await f.unmount(); const reads = f.api.listIngestionCandidates.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000); expect(f.api.listIngestionCandidates).toHaveBeenCalledTimes(reads); expect(f.app.state).toBe("running");
    f.api.getIngestionTask.mockResolvedValue({ ...f.task, matches: [{ ...f.task.matches[0]!, title: "核心恢复后的候选作品" }] });
    await f.remount(); expect(f.element.textContent).toContain("核心恢复后的候选作品"); expect(f.api.listIngestionCandidates.mock.calls.length).toBeGreaterThan(reads);
    expect(f.api.previewOrganize).not.toHaveBeenCalled(); expect(f.api.confirmOrganize).not.toHaveBeenCalled(); expect(f.api.previewOrganizeBatch).not.toHaveBeenCalled();
  });
  it("预览过期立即显示原因且禁用完整性确认，重新预览必须重新勾选，不自动提交", async () => {
    const f = await mount(); await preview(); const complete = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.parentElement!.textContent!.includes("我已在下载器中确认"))!; await act(async () => complete.click()); expect(button("确认 COPY 整理").disabled).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(f.element.textContent).toContain("整理预览已过期，请重新预览"); expect(complete.disabled).toBe(true); expect(button("确认 COPY 整理").disabled).toBe(true); expect(f.api.confirmOrganize).not.toHaveBeenCalled();
    await click("预览 COPY 计划"); expect(complete.checked).toBe(false); expect(complete.disabled).toBe(false); expect(button("确认 COPY 整理").disabled).toBe(true);
  });
  it("打开分组草稿清除单条旧预览和确认勾选，编辑不触发任何 COPY", async () => {
    const f = await mount(); await preview(); await act(async () => document.querySelector<HTMLInputElement>('[aria-label="选择识别任务 待确认片.mkv"]')!.click()); await click("预览所选文件整理（1）"); expect(f.element.textContent).toContain("共同作品与逐文件计划"); expect(button("确认 COPY 整理")).toBeUndefined(); expect(f.api.confirmOrganize).not.toHaveBeenCalled(); expect(f.api.previewOrganizeBatch).not.toHaveBeenCalled();
  });
});
