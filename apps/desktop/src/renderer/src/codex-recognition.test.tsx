// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import { MemoryRouter } from "react-router-dom";
import { recognitionSettingsSchema, type CodexJob, type DesktopApi, type DesktopSettings, type SettingsDraft } from "@media-marshal/contracts";
import { createRendererApplication, SettingsViewModel } from "./services";
import { CodexRecognitionViewModel } from "./codex-recognition-model";
import { CodexRecognitionActions, CodexRecognitionPanel } from "./components/CodexRecognitionPanel";
import { RecognitionSettingsPanel } from "./components/RecognitionSettingsPanel";
import { i18nReady } from "./i18n";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); document.body.innerHTML = ""; });
async function fixture(enabled = true) {
  await i18nReady;
  let settings: DesktopSettings = { language: "zh-CN", embyUrl: "http://emby.test", tmdbProxy: "", tmdbKeyConfigured: true, embyKeyConfigured: false, recognition: recognitionSettingsSchema.parse({ codexEnabled: enabled }) };
  const taskId = crypto.randomUUID(), directory = { id: "a".repeat(64), sourceId: crypto.randomUUID() };
  let jobs: CodexJob[] = [];
  const job = (): CodexJob => ({ id: crypto.randomUUID(), taskId, directory: true, organize: true, state: "RUNNING", items: [{ taskId, relativePath: "作品/S03/48.mkv", state: "PENDING", failure: null, operationId: null }], failure: null, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });
  const api = {
    getSettings: vi.fn(async () => structuredClone(settings)), saveSettings: vi.fn(async (draft: SettingsDraft) => { settings = { ...settings, ...draft }; return draft; }),
    listCodexJobs: vi.fn(async () => ({ items: structuredClone(jobs), total: jobs.length })),
    recognizeDirectoryWithCodex: vi.fn(async () => { const value = job(); jobs.unshift(value); return structuredClone(value); }),
    rematchWithCodex: vi.fn(async () => { const value = { ...job(), directory: false }; jobs.unshift(value); return value; }),
    cancelCodexJob: vi.fn(async (id: string) => { const value = jobs.find((job) => job.id === id)!; value.state = "CANCELLED"; return value; }),
    getCodexUsage: vi.fn(async () => ({ day: "2026-11-01", calls: 3, reported_calls: 2, input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, call_limit: 10 })),
  };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start();
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  cleanup.push(async () => { await act(async () => root.unmount()); await app.stop(); });
  const inspect = vi.fn(), codex = app.container.get(CodexRecognitionViewModel), model = app.container.get(SettingsViewModel);
  const mount = async (show = true) => act(async () => root.render(<ContainerProvider value={app.container}><MemoryRouter>{show && <><CodexRecognitionActions taskId={taskId} directory={directory} /><CodexRecognitionPanel onInspect={inspect} /><RecognitionSettingsPanel /></>}</MemoryRouter></ContainerProvider>));
  const button = (text: string) => [...element.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text)!;
  return { api, element, codex, model, taskId, directory, jobs: () => jobs, settings: () => settings, mount, button, inspect, setEnabled: (enabled: boolean) => { settings.recognition!.codexEnabled = enabled; } };
}

it("关闭Codex时显示设置入口与禁用原因，读取状态不提交识别", async () => {
  const f = await fixture(false); await f.mount();
  expect(f.button("批量识别目录").disabled).toBe(true); expect(f.element.textContent).toContain("Codex 尚未启用"); expect(f.element.querySelector('a[href="/settings#recognition-strategy"]')).not.toBeNull();
  expect(f.api.recognizeDirectoryWithCodex).not.toHaveBeenCalled(); expect(f.api.rematchWithCodex).not.toHaveBeenCalled();
  f.setEnabled(true); await act(async () => f.codex.refresh()); expect(f.button("批量识别目录").disabled).toBe(false);
});
it("目录入口提交持久作业，离开再进入查询原结果，逐项保留失败与重试入口", async () => {
  const f = await fixture(); await f.mount(); await act(async () => f.button("批量识别并整理").click());
  expect(f.api.recognizeDirectoryWithCodex).toHaveBeenCalledWith({ ...f.directory, organize: true, requestKey: expect.any(String) });
  expect(f.element.textContent).toContain("正在识别并校验"); expect(f.element.textContent).toContain("共 1 项");
  await f.mount(false); const job = f.jobs()[0]!; job.state = "PARTIAL_FAILED"; job.items[0]!.state = "UPDATED"; job.items[0]!.failure = "48.mkv 与哈希副本重复：S3 E48，请排除副本";
  await f.mount(); expect(f.api.recognizeDirectoryWithCodex).toHaveBeenCalledTimes(1); expect(f.element.textContent).toContain("哈希副本重复");
  await act(async () => f.button("核对此文件").click()); expect(f.inspect).toHaveBeenCalledWith(f.taskId);
  await act(async () => f.button("重试此文件").click()); expect(f.api.rematchWithCodex).toHaveBeenCalledWith({ taskId: f.taskId, directory: false, organize: true, requestKey: expect.any(String) });
});
it("保存识别配置并查询用量，之后保存连接配置不丢失识别策略", async () => {
  const f = await fixture(); await act(async () => f.model.refresh()); await f.mount();
  const input = f.element.querySelector<HTMLInputElement>("#recognition-daily-calls")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "15"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => f.button("保存识别设置").click());
  expect(f.api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ recognition: expect.objectContaining({ dailyCalls: 15, codexEnabled: true }) }));
  await act(async () => f.model.save({ language: "zh-CN", embyUrl: "http://changed.test", tmdbProxy: "" }));
  expect(f.settings().recognition!.dailyCalls).toBe(15);
  await act(async () => f.button("查看今日用量").click()); expect(f.element.textContent).toContain("已调用 3 / 10 次"); expect(f.element.textContent).toContain("含缓存 40");
});
it("请求失败保留幂等键、错误与草稿，迟到查询不覆盖新页面", async () => {
  const f = await fixture(); f.api.recognizeDirectoryWithCodex.mockRejectedValueOnce(new Error("核心暂不可用，请重试原请求")); await f.mount();
  await act(async () => f.button("批量识别目录").click()); expect(f.element.textContent).toContain("核心暂不可用");
  await act(async () => f.button("批量识别目录").click()); expect(f.api.recognizeDirectoryWithCodex.mock.calls[0]![0].requestKey).toBe(f.api.recognizeDirectoryWithCodex.mock.calls[1]![0].requestKey);
  let release!: (value: { items: CodexJob[]; total: number }) => void;
  f.api.listCodexJobs.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  let pending!: Promise<void>; await act(async () => { pending = f.codex.refresh(); }); await f.mount(false);
  await act(async () => { release({ items: [], total: 0 }); await pending; }); expect(f.codex.state.total).toBe(1);
});
