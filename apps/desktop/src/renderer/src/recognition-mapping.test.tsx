// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ContainerProvider } from "@yeatz/app-framework/react";
import { recognitionRuleConfigurationSchema, type CoreOutput, type DesktopApi, type RecognitionRule, type SourceScan } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { RecognitionViewModel } from "./recognition-model";
import { RecognitionDraftProvider } from "./recognition-draft-context";
import { RecognitionPage } from "./pages/Recognition";
import { i18nReady } from "./i18n";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); Object.assign(HTMLDialogElement.prototype, { showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); }, close(this: HTMLDialogElement) { this.removeAttribute("open"); } });
const cleanup: (() => Promise<void>)[] = []; afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); document.body.innerHTML = ""; });
const button = (name: string) => { const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === name); expect(node, name).toBeTruthy(); return node!; };
async function click(name: string) { await act(async () => button(name).click()); }
async function fill(name: string, value: string) { const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${name}"]`)!; expect(input, name).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); }
function fixture() {
  const input = { id: crypto.randomUUID(), version: 1, path: "/已有输入 中文", kind: "ordinary" as const, available: true }, media = { ...input, id: crypto.randomUUID(), path: "/电影媒体目标 中文 长路径".repeat(10), kind: "media" as const }, rows = new Map<string, RecognitionRule>(), previews = new Map<string, CoreOutput<"recognition.get-preview">>(); const stamp = new Date().toISOString(); let paused = false; const scans: SourceScan[] = [];
  const binding = (value: typeof input | typeof media) => ({ id: value.id, version: value.version, path: value.path });
  const api = {
    listMediaLibraries: vi.fn<DesktopApi["listMediaLibraries"]>(async () => [{ targetId: media.id, mediaType: "MOVIE", configuredMediaTypes: ["MOVIE"], path: media.path, available: true }, { targetId: input.id, mediaType: "TV_SHOW", configuredMediaTypes: ["TV_SHOW"], path: "/剧集库", available: true }]),
    listRecognitionRules: vi.fn(async () => structuredClone([...rows.values()])), listConfigurationDirectories: vi.fn(async () => [input, media]), getDefaultDownloadDirectory: vi.fn(async () => ({ version: 1, directory: binding(input) })), getOrganizePause: vi.fn(async () => ({ paused })), setOrganizePause: vi.fn(async (value: { paused: boolean }) => ({ paused: paused = value.paused })),
    chooseConfigurationDirectory: vi.fn(async (kind: string) => kind === "ordinary" ? input : media), listIngestionCandidates: vi.fn(async () => ({ items: [], total: 0 })), listIngestionScans: vi.fn(async () => ({ items: structuredClone(scans), total: scans.length })),
    saveRecognitionRule: vi.fn<DesktopApi["saveRecognitionRule"]>(async (value) => { const configuration = recognitionRuleConfigurationSchema.parse(value.configuration), old = rows.get(value.id); const row: RecognitionRule = { id: value.id, version: old?.version ?? 0, draftRevision: value.expectedDraftRevision + 1, lifecycleRevision: old?.lifecycleRevision ?? 0, draft: configuration, snapshot: old?.snapshot ?? null, paused: old?.paused ?? true, deletedAt: null, reviewReasons: [], createdAt: stamp, updatedAt: stamp, runtime: old?.runtime ?? { claimed: false, sourceId: null, failure: null, unavailableInputs: 0, automaticAuthorized: false } }; rows.set(row.id, row); return structuredClone(row); }),
    previewRecognitionRule: vi.fn<DesktopApi["previewRecognitionRule"]>(async (value) => { const row = rows.get(value.id)!;  const result: CoreOutput<"recognition.get-preview"> = { id: crypto.randomUUID(), ruleId: row.id, state: "READY", expiresAt: Date.now() + 900000, automaticAuthorized: false, snapshot: { ruleId: row.id, ruleVersion: row.version + 1, configuration: structuredClone(row.draft), inputDirectory: binding(input), inputMode: "managed-completed", defaultDirectoryVersion: 1, targets: row.draft.targets.map((target) => ({ targetId: target.id, directory: binding(media), embyBinding: null })) } }; previews.set(result.id, result); return structuredClone(result); }),
    getRecognitionConfigurationPreview: vi.fn<DesktopApi["getRecognitionConfigurationPreview"]>(async (id) => structuredClone(previews.get(id)!)),
    confirmRecognitionRule: vi.fn<DesktopApi["confirmRecognitionRule"]>(async (value) => { const p = previews.get(value.previewId)!, row = rows.get(p.ruleId)!; row.version = p.snapshot.ruleVersion; row.snapshot = p.snapshot; row.paused = false; row.runtime = { claimed: true, sourceId: row.runtime?.sourceId ?? crypto.randomUUID(), failure: null, unavailableInputs: 0, automaticAuthorized: false }; p.state = "APPLIED"; return structuredClone(row); }),
    controlRecognitionRule: vi.fn<DesktopApi["controlRecognitionRule"]>(async (value) => { const row = rows.get(value.id)!; row.lifecycleRevision++; row.paused = value.operation !== "resume"; if (value.operation === "remove") row.deletedAt = stamp; if (value.operation === "restore") row.deletedAt = null; return structuredClone(row); }), scanRecognitionRule: vi.fn<DesktopApi["scanRecognitionRule"]>(async (value) => { const job: SourceScan = { id: crypto.randomUUID(), sourceId: value.id, sourceName: rows.get(value.id)!.snapshot!.configuration.name, ownerKind: "recognition", state: "COMPLETED", discovered: 0, failed: 0, failure: null, createdAt: stamp, updatedAt: stamp }; scans.unshift(job); return job; }),
    authorizeRecognitionAutomatic: vi.fn<DesktopApi["authorizeRecognitionAutomatic"]>(async (value) => { const row = rows.get(value.id)!; row.runtime!.automaticAuthorized = true; return structuredClone(row); }), confirmOrganize: vi.fn(), recognizeIngestion: vi.fn(),
  };
  return { input, media, rows, previews, api };
}
async function mount(path = "/recognition", setup?: (value: ReturnType<typeof fixture>) => void) {
  await i18nReady; const f = fixture(); setup?.(f); const app = createRendererApplication(f.api as unknown as DesktopApi); await app.start(); const element = document.createElement("div"); document.body.append(element); let root = createRoot(element), mounted = true;
  const render = () => act(async () => root.render(<StrictMode><ContainerProvider value={app.container}><RecognitionDraftProvider><MemoryRouter initialEntries={[path]}><RecognitionPage /></MemoryRouter></RecognitionDraftProvider></ContainerProvider></StrictMode>)); const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } }; const remount = async () => { await unmount(); root = createRoot(element); mounted = true; await render(); }; await render(); cleanup.push(async () => { await unmount(); await app.stop(); }); return { ...f, app, element, unmount, remount };
}
it("识别统一使用设置目录，不提供输入目录或客户端选择", async () => {
  const f = await mount(); await click("添加识别规则"); await fill("识别规则名称", "统一目录识别");
  expect(document.querySelector('[aria-label="识别输入目录"]')).toBeNull();
  expect(document.querySelector('[aria-label="识别输入客户端"]')).toBeNull();
  expect(f.element.textContent).toContain(f.input.path);
  expect(document.querySelector('a[href="/settings"]')).not.toBeNull();
  await click("保存识别草稿并预览");
  expect(f.api.saveRecognitionRule.mock.calls[0]![0].configuration).toMatchObject({ input: { kind: "default" }, client: "custom" });
  expect(f.api.chooseConfigurationDirectory).not.toHaveBeenCalled();
  await click("确认识别配置范围"); expect(f.api.confirmRecognitionRule).toHaveBeenCalledTimes(1);
});
it("下载目录未设置时展示设置入口，配置错误保留草稿", async () => {
  const f = await mount("/recognition", (f) => { f.api.getDefaultDownloadDirectory.mockResolvedValue({ version: 0, directory: null } as never); f.api.previewRecognitionRule.mockRejectedValue(new Error("尚未设置本地下载目录，请前往设置")); });
  await click("添加识别规则"); await fill("识别规则名称", "等待目录");
  expect(f.element.textContent).toContain("尚未设置本地下载目录");
  await click("保存识别草稿并预览"); expect(f.rows.size).toBe(1); expect(f.api.confirmRecognitionRule).not.toHaveBeenCalled();
});

it("只读展示设置页电影和剧集目录，保存与预览直接使用同一配置", async () => {
  const f = await mount(); await click("添加识别规则"); await fill("识别规则名称", "混合输入分库");
  const mapping = document.querySelector('[aria-label="按媒体类型映射"]')!;
  expect(mapping.textContent).toContain(f.media.path); expect(mapping.textContent).toContain("/剧集库");
  expect(mapping.querySelector("input,select,button")).toBeNull();
  await click("保存识别草稿并预览");
  expect(f.api.saveRecognitionRule.mock.calls[0]![0].configuration.targets).toEqual([
    expect.objectContaining({ name: "电影媒体库", mediaType: "MOVIE", directoryId: f.media.id, template: null }),
    expect.objectContaining({ name: "剧集媒体库", mediaType: "TV_SHOW", directoryId: f.input.id, template: null }),
  ]);
  expect(f.element.textContent).toContain("电影媒体库 · 电影"); expect(f.element.textContent).toContain("剧集媒体库 · 剧集");
  expect(f.api.chooseConfigurationDirectory).not.toHaveBeenCalled(); expect(f.api.confirmRecognitionRule).not.toHaveBeenCalled();
  const targets = f.api.saveRecognitionRule.mock.calls[0]![0].configuration.targets;
  await click("编辑并预览识别规则"); await fill("识别规则名称", "尚未保存的新名称");
  await act(async () => { await f.app.container.get(RecognitionViewModel).refresh(); });
  expect(document.querySelector<HTMLInputElement>('[aria-label="识别规则名称"]')!.value).toBe("尚未保存的新名称");
  await click("保存识别草稿并预览"); expect(f.api.saveRecognitionRule.mock.calls.at(-1)![0].configuration.targets).toEqual(targets);
});
it("范围预览失败后重试复用目标身份，避免重复创建相同设置目标", async () => {
  const f = await mount(); await click("添加识别规则"); await fill("识别规则名称", "重试识别预览");
  f.api.previewRecognitionRule.mockRejectedValueOnce(new Error("目录暂不可用，请恢复磁盘后重新预览"));
  await click("保存识别草稿并预览");
  const targets = f.api.saveRecognitionRule.mock.calls[0]![0].configuration.targets;
  await click("保存识别草稿并预览");
  expect(f.api.saveRecognitionRule.mock.calls.at(-1)![0].configuration.targets).toEqual(targets);
  expect(f.element.textContent).toContain("待确认范围");
});
it("设置未配置目标时展示缺失提示，不把历史目标当作当前设置", async () => {
  const f = await mount("/recognition", (f) => { f.api.listMediaLibraries.mockResolvedValue([{ targetId: f.media.id, mediaType: "MOVIE", path: f.media.path, available: true }]); });
  await click("添加识别规则"); await fill("识别规则名称", "尚无默认目标");
  expect(document.querySelector('[aria-label="按媒体类型映射"]')!.textContent).toContain("尚未设置媒体库目录");
  await click("保存识别草稿并预览"); expect(f.api.saveRecognitionRule.mock.calls[0]![0].configuration.targets).toEqual([]);
});
it("编辑期间设置目录变更使用新目录，查询失败不能保存旧映射", async () => {
  const f = await mount(); await click("添加识别规则"); await fill("识别规则名称", "跟随设置");
  f.api.listMediaLibraries.mockResolvedValue([{ targetId: f.input.id, mediaType: "MOVIE", configuredMediaTypes: ["MOVIE"], path: "/新的电影库", available: false }]);
  await act(async () => { await f.app.container.get(RecognitionViewModel).refresh(); });
  expect(document.querySelector('[aria-label="按媒体类型映射"]')!.textContent).toContain("/新的电影库（原目录不可用");
  f.api.listMediaLibraries.mockRejectedValueOnce(new Error("媒体库目录读取失败"));
  await act(async () => { await f.app.container.get(RecognitionViewModel).refresh(); });
  expect(button("保存识别草稿并预览").disabled).toBe(true);
  await act(async () => { await f.app.container.get(RecognitionViewModel).refresh(); });
  await click("保存识别草稿并预览");
  expect(f.api.saveRecognitionRule.mock.calls[0]![0].configuration.targets).toEqual([expect.objectContaining({ directoryId: f.input.id, mediaType: "MOVIE" })]);
});
it("扫描面板接入独立识别，扫描成功立即展示作业，完成后可重新扫描", async () => {
  const f = await mount(); await click("添加识别规则"); await fill("识别规则名称", "手动重新扫描"); await click("保存识别草稿并预览");
  expect(button("重新扫描 · 手动重新扫描").disabled).toBe(true);
  expect(f.element.textContent).toContain("请先保存并确认识别配置范围，再重新扫描");
  await click("确认识别配置范围");
  await click("重新扫描 · 手动重新扫描");
  const rule = [...f.rows.values()][0]!;
  expect(f.api.scanRecognitionRule).toHaveBeenCalledWith(expect.objectContaining({ id: rule.id, expectedVersion: 1, expectedDraftRevision: 1, expectedLifecycleRevision: 0 }));
  const panel = document.querySelector('[aria-label="手动目录扫描"]')!;
  expect(panel.textContent).toContain("扫描完成"); expect(panel.textContent).toContain("本次核对媒体项 0");
  const retry = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "重新扫描")!;
  await act(async () => retry.click());
  expect(f.api.scanRecognitionRule).toHaveBeenCalledTimes(2);
  expect(f.api.scanRecognitionRule.mock.calls[0]![0].requestKey).not.toBe(f.api.scanRecognitionRule.mock.calls[1]![0].requestKey);
  await click("暂停此识别规则"); expect(button("重新扫描 · 手动重新扫描").disabled).toBe(true);
  expect(f.element.textContent).toContain("识别规则已暂停，请先恢复此规则再重新扫描");
});
it("重新扫描失败展示原因，响应丢失重试复用请求键，页面重载只查询", async () => {
  const f = await mount(); await click("添加识别规则"); await fill("识别规则名称", "扫描重试"); await click("保存识别草稿并预览"); await click("确认识别配置范围");
  f.api.scanRecognitionRule.mockRejectedValueOnce(new Error("扫描重试：原磁盘暂不可用，请连接原磁盘后重新扫描"));
  await click("重新扫描 · 扫描重试");
  expect(document.querySelector('[aria-label="手动目录扫描"]')!.textContent).toContain("原磁盘暂不可用，请连接原磁盘");
  await click("重新扫描 · 扫描重试");
  expect(f.api.scanRecognitionRule.mock.calls[0]).toEqual(f.api.scanRecognitionRule.mock.calls[1]);
  await f.remount(); expect(f.api.scanRecognitionRule).toHaveBeenCalledTimes(2);
  expect(f.element.textContent).toContain("扫描完成");
});
it("首次样本授权需要明确勾选且绑定当前版本，普通查询与重载不重放授权", async () => {
  const id = crypto.randomUUID(), sample = crypto.randomUUID(); const f = await mount(`/recognition?rule=${id}&sample=${sample}`, (f) => { const configuration = recognitionRuleConfigurationSchema.parse({ name: "有条件自动", input: { kind: "directory", directoryId: f.input.id }, targets: [], automatic: true }); const stamp = new Date().toISOString(); f.rows.set(id, { id, version: 3, draftRevision: 4, lifecycleRevision: 0, draft: configuration, snapshot: { ruleId: id, ruleVersion: 3, configuration, inputDirectory: { id: f.input.id, version: 1, path: f.input.path }, inputMode: "managed-completed", defaultDirectoryVersion: 1, targets: [] }, paused: false, deletedAt: null, reviewReasons: [], createdAt: stamp, updatedAt: stamp, runtime: { claimed: true, sourceId: crypto.randomUUID(), unavailableInputs: 0, failure: null, automaticAuthorized: false } }); });
  expect(document.querySelector(".editor-surface")).toBeNull();
  expect(button("确认首次样本自动授权").disabled).toBe(true); await act(async () => document.querySelector<HTMLInputElement>('[aria-label="已核对首次样本并授权当前规则版本"]')!.click()); await click("确认首次样本自动授权"); expect(f.api.authorizeRecognitionAutomatic).toHaveBeenCalledWith(expect.objectContaining({ id, expectedVersion: 3, samplePreviewId: sample, accepted: true })); await f.remount(); expect(f.api.authorizeRecognitionAutomatic).toHaveBeenCalledTimes(1); expect(f.api.confirmOrganize).not.toHaveBeenCalled();
  await click("暂停全部识别整理"); await click("暂停此识别规则"); await click("恢复此识别规则"); expect(f.element.textContent).toContain("全部识别整理已暂停"); expect(f.api.setOrganizePause).toHaveBeenCalledTimes(1);
});

it("编辑已确认规则移除旧预览并聚焦，轮询不覆盖未保存修改", async () => {
  const f = await mount();
  await click("添加识别规则"); await fill("识别规则名称", "可编辑规则"); await click("保存识别草稿并预览"); await click("确认识别配置范围");
  expect(document.querySelector('[aria-label="识别规则表单"]')).toBeNull();
  await click("编辑并预览识别规则");
  expect(document.querySelector('[aria-label="识别配置范围预览"]')).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('[aria-label="识别规则名称"]'));
  await fill("识别规则名称", "编辑后的规则");
  await act(async () => { await f.app.container.get(RecognitionViewModel).refresh(); });
  expect(document.querySelector<HTMLInputElement>('[aria-label="识别规则名称"]')!.value).toBe("编辑后的规则");
  await click("保存识别草稿并预览");
  expect(f.api.saveRecognitionRule.mock.calls.at(-1)![0]).toMatchObject({ expectedVersion: 1, expectedDraftRevision: 1, configuration: { name: "编辑后的规则" } });
  expect(document.querySelector('[aria-label="识别配置范围预览"]')).not.toBeNull();
});

it("删除规则清除表单、预览和接入区，恢复入口保持折叠且恢复后仍暂停", async () => {
  const f = await mount();
  await click("添加识别规则"); await fill("识别规则名称", "待删除规则"); await click("保存识别草稿并预览"); await click("确认识别配置范围");
  await click("暂停此识别规则"); await click("删除识别规则…"); await click("确认删除识别规则");
  expect(document.querySelector('[aria-label="识别配置范围预览"]')).toBeNull();
  expect(document.querySelector('[aria-label="识别规则表单"]')).toBeNull();
  expect(document.querySelector('[aria-label="规则接入与文件任务"]')).toBeNull();
  expect(document.querySelector('article[aria-label="识别规则 待删除规则"]')).toBeNull();
  expect(document.querySelector(".recognition-archive")?.hasAttribute("open")).toBe(false);
  await click("恢复已删除识别规则");
  expect(document.querySelector('article[aria-label="识别规则 待删除规则"]')?.textContent).toContain("识别已暂停");
  expect(document.querySelector(".recognition-archive")).toBeNull();
  expect(f.api.confirmRecognitionRule).toHaveBeenCalledTimes(1);
});

it("已删除规则的旧链接不会重新打开编辑器、过期预览或自动授权", async () => {
  const id = crypto.randomUUID();
  const f = await mount(`/recognition?rule=${id}&configurationPreview=${crypto.randomUUID()}`, (f) => {
    const configuration = recognitionRuleConfigurationSchema.parse({ name: "旧链接已删除规则", input: { kind: "directory", directoryId: f.input.id }, targets: [], automatic: true });
    const stamp = new Date().toISOString();
    f.rows.set(id, { id, version: 0, draftRevision: 1, lifecycleRevision: 1, draft: configuration, snapshot: null, paused: true, deletedAt: stamp, reviewReasons: [], createdAt: stamp, updatedAt: stamp, runtime: { claimed: true, sourceId: null, unavailableInputs: 0, failure: null, automaticAuthorized: false } });
    // 首次列表返回前预览可能已发起读取，返回已删除规则对应的过期快照。
    f.api.getRecognitionConfigurationPreview.mockResolvedValue({ id: crypto.randomUUID(), ruleId: id, state: "EXPIRED", expiresAt: 0, automaticAuthorized: false, snapshot: { ruleId: id, ruleVersion: 1, configuration, inputDirectory: { id: f.input.id, version: 1, path: f.input.path }, inputMode: "managed-completed", defaultDirectoryVersion: 1, targets: [] } });
  });
  expect(document.querySelector('[aria-label="识别规则表单"]')).toBeNull();
  expect(document.querySelector('[aria-label="识别配置范围预览"]')).toBeNull();
  expect(document.querySelector('[aria-label="首次样本自动授权"]')).toBeNull();
  await f.remount();
  expect(document.querySelector('[aria-label="识别规则表单"]')).toBeNull();
  expect(f.api.controlRecognitionRule).not.toHaveBeenCalled();
});
