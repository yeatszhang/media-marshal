// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { CoreOutput, DesktopApi } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { SeasonQueuePanel } from "./components/SeasonQueuePanel";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); document.body.innerHTML = ""; });
async function mount() {
  vi.useFakeTimers(); const taskId = crypto.randomUUID(), sourceId = crypto.randomUUID(), candidateId = crypto.randomUUID(), group = { id: "a".repeat(64), sourceId, sourceName: "剧集来源", title: "同名候选需核对", tmdbId: 7, season: 0, total: 101, bytes: 1000 };
  const detail: CoreOutput<"ingestion.season"> = { season: group, items: [{ candidate: { id: candidateId, sourceId, relativePath: "特别篇/原片.mkv", size: 10, state: "QUEUED", taskId, reason: null, requiresConfirmation: true, updatedAt: new Date().toISOString() }, task: { taskId, candidateId, state: "AWAITING_CONFIRMATION", parsed: { title: "原名称", type: "TV_SHOW", year: null, season: 0, episode: 1, episodeEnd: 2 }, matches: [], failure: null } }] };
  const api = { listIngestionSeasons: vi.fn(async () => ({ items: [group], total: 26 })), getIngestionSeason: vi.fn(async () => structuredClone(detail)), previewOrganizeBatch: vi.fn(), confirmOrganizeBatch: vi.fn() };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start(); const element = document.createElement("div"); document.body.append(element); const root = createRoot(element), organize = vi.fn(), edit = vi.fn(), inspect = vi.fn();
  await act(async () => root.render(<StrictMode><ContainerProvider value={app.container}><SeasonQueuePanel onOrganize={organize} onEdit={edit} onInspect={inspect} /></ContainerProvider></StrictMode>)); let mounted = true; const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } }; cleanup.push(async () => { await unmount(); await app.stop(); }); return { app, api, element, group, taskId, organize, edit, inspect, unmount };
}
async function click(name: string) { const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === name); expect(node, name).toBeTruthy(); await act(async () => node!.click()); }
describe("季集候选分组的明确选择", () => {
  it("分组只是候选索引，特别篇与合并集保留，明确选择后只填入所选任务草稿", async () => {
    const f = await mount(); expect(f.element.textContent).toContain("特别篇 S0"); expect(f.element.textContent).toContain("一个文件可能支持多个作品候选"); await click("查看本季候选文件"); expect(f.element.textContent).toContain("S0 E1–2"); expect(f.element.textContent).toContain("整组 101 项"); await click("选择本页待确认文件"); await click("编辑本季所选识别（1）"); expect(f.edit).toHaveBeenCalledWith([f.taskId]); await click("预览本季所选文件（1）"); expect(f.organize).toHaveBeenCalledWith([f.taskId], { tmdbId: 7, mediaType: "TV_SHOW" }); expect(f.api.previewOrganizeBatch).not.toHaveBeenCalled(); expect(f.api.confirmOrganizeBatch).not.toHaveBeenCalled();
  });
  it("分页清除当前选择，组消失展示原因与刷新动作，不重放写命令", async () => {
    const f = await mount(); await click("查看本季候选文件"); await click("选择本页待确认文件"); await click("下一页季集文件"); expect(f.api.getIngestionSeason).toHaveBeenLastCalledWith({ id: f.group.id, sourceId: f.group.sourceId, page: 2 }); expect(f.element.textContent).toContain("预览本季所选文件（0）"); f.api.getIngestionSeason.mockRejectedValueOnce(new Error("此季集候选组已变化，请刷新")); await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(f.element.textContent).toContain("此季集候选组已变化"); expect(f.element.querySelector('[aria-label="季集候选文件与确认范围"]')).toBeNull(); expect(f.organize).not.toHaveBeenCalled();
  });
  it("StrictMode 与卸载只维护只读轮询，共享应用不停止", async () => {
    const f = await mount(); expect(f.api.listIngestionSeasons).toHaveBeenCalledTimes(2); await f.unmount(); const count = f.api.listIngestionSeasons.mock.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(f.api.listIngestionSeasons).toHaveBeenCalledTimes(count); expect(f.app.state).toBe("running"); expect(f.api.confirmOrganizeBatch).not.toHaveBeenCalled();
  });
});
