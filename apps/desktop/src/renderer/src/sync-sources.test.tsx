// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route, Link } from "react-router-dom";
import { ContainerProvider } from "@yeatz/app-framework/react";
import { syncSourceConfigurationSchema, type CoreOutput, type DesktopApi, type SyncSourceRule } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { SyncDraftProvider } from "./sync-draft-context";
import { SyncSources } from "./pages/SyncSources";
import { SyncViewModel } from "./sync-model";
import { i18nReady } from "./i18n";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(HTMLDialogElement.prototype, { showModal() { this.setAttribute("open", ""); }, close() { this.removeAttribute("open"); } });
const cleanup: (() => Promise<void>)[] = []; afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); document.body.innerHTML = ""; });
const button = (name: string) => { const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === name); expect(value, name).toBeTruthy(); return value!; };
const field = (name: string) => document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${name}"]`)!;
async function click(name: string) { await act(async () => button(name).click()); }
async function fill(name: string, value: string) { const input = field(name); expect(input, name).toBeTruthy(); const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); }
async function mount(path = "/sources", setup?: (fixture: ReturnType<typeof fixture>) => void) {
  await i18nReady; const f = fixture(); setup?.(f); const app = createRendererApplication(f.api as unknown as DesktopApi); await app.start();
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(<StrictMode><ContainerProvider value={app.container}><SyncDraftProvider><MemoryRouter initialEntries={[path]}><Routes><Route path="/sources" element={<SyncSources />} /><Route path="/cloud" element={<Link to="/sources">返回来源</Link>} /></Routes></MemoryRouter></SyncDraftProvider></ContainerProvider></StrictMode>));
  cleanup.push(async () => { await act(async () => root.unmount()); await app.stop(); }); return { ...f, app, element };
}
function fixture() {
  const input = { id: crypto.randomUUID(), version: 1, path: "/中文 输入", kind: "ordinary" as const, available: true }, target = { ...input, id: crypto.randomUUID(), path: "/中文 目标".repeat(20), kind: "managed" as const }, rows = new Map<string, SyncSourceRule>(), previews = new Map<string, CoreOutput<"sync.preview">>();
  const binding = (value: typeof input | typeof target) => ({ id: value.id, version: value.version, path: value.path });
  const stamp = new Date().toISOString(), account = { id: crypto.randomUUID(), rootRef: crypto.randomUUID(), name: "隔离账号", status: "READY" as const, providerKind: "quark" as const, capabilities: null }, directory = { accountId: account.id, ref: crypto.randomUUID(), parentRef: account.rootRef, name: "中文 目录", type: "directory" as const, size: null, modifiedAt: null, version: null };
  const api = {
    listSyncSources: vi.fn(async () => structuredClone([...rows.values()])), listConfigurationDirectories: vi.fn(async () => [input, target]), getDefaultDownloadDirectory: vi.fn(async () => ({ version: 1, directory: binding(target) })), listCloudAccounts: vi.fn(async () => [{ ...account }]), listSyncJobs: vi.fn(async () => ({ items: [], total: 0 })), getCloudDownloadPause: vi.fn(async () => ({ paused: false })), chooseConfigurationDirectory: vi.fn(async (kind: string) => kind === "ordinary" ? input : target),
    saveSyncSource: vi.fn<DesktopApi["saveSyncSource"]>(async (value) => { const configuration = syncSourceConfigurationSchema.parse(value.configuration), old = rows.get(value.id); const row: SyncSourceRule = { id: value.id, version: old?.version ?? 0, draftRevision: value.expectedDraftRevision + 1, lifecycleRevision: 0, draft: configuration, snapshot: old?.snapshot ?? null, paused: true, deletedAt: null, reviewReasons: [], createdAt: stamp, updatedAt: stamp, runtime: { claimed: false, nextScanAt: null, failure: null } }; rows.set(row.id, row); return structuredClone(row); }),
    previewSyncSource: vi.fn<DesktopApi["previewSyncSource"]>(async (value) => { const row = rows.get(value.id)!; if (!(await api.getDefaultDownloadDirectory()).directory) throw new Error("尚未设置默认下载目录，请选择具体目录"); const preview: CoreOutput<"sync.preview"> = { id: crypto.randomUUID(), sourceId: row.id, mode: value.mode ?? "configuration", state: "READY", snapshot: { sourceId: row.id, sourceVersion: row.version + 1, configuration: row.draft, inputDirectory: row.draft.type === "local" ? binding(input) : null, targetDirectory: binding(target), defaultDirectoryVersion: 1 }, expiresAt: Date.now() + 900000, files: 1, bytes: 100, complete: true, observing: 0, conflicts: 0, reused: 0, removed: 0, force: false, failure: null, download: null, jobId: null }; previews.set(preview.id, preview); return structuredClone(preview); }),
    getSyncPreview: vi.fn<DesktopApi["getSyncPreview"]>(async (id) => structuredClone(previews.get(id)!)), listSyncPreviewFiles: vi.fn<DesktopApi["listSyncPreviewFiles"]>(async () => ({ items: [{ relativePath: "原片.mp4", targetPath: target.path + "/completed/原片.mp4", size: 100, state: "READY" as const, reason: null }], total: 1 })),
    confirmSyncSource: vi.fn<DesktopApi["confirmSyncSource"]>(async (value) => { const preview = previews.get(value.previewId)!, row = rows.get(preview.sourceId)!; row.snapshot = preview.snapshot; row.version = preview.snapshot.sourceVersion; row.paused = false; row.runtime!.claimed = true; preview.state = "APPLIED"; return { rule: structuredClone(row), jobId: null }; }), controlSyncSource: vi.fn(), setCloudDownloadPause: vi.fn(), retrySyncJob: vi.fn(), removeSyncJob: vi.fn(), getSyncJob: vi.fn(), listSyncJobFiles: vi.fn(),
    listRemote: vi.fn(async () => ({ items: [directory], nextCursor: null, total: 1, complete: true })), statRemote: vi.fn(async () => directory),
  };
  return { api, input, target, rows, previews, account, directory };
}
it("本地来源没有媒体或整理开关；取消原生目录不改变草稿，有序规则逐项保存", async () => {
  const f = await mount(); await click("添加同步来源"); await fill("来源名称", "独立本地同步"); f.api.chooseConfigurationDirectory.mockResolvedValueOnce(null as never); await click("选择本地输入目录"); expect(field("本地输入目录").value).toBe(""); await click("选择本地输入目录");
  expect(document.body.textContent).not.toContain("媒体类型"); expect(document.body.textContent).not.toContain("下载后整理到媒体库");
  await click("添加过滤规则"); await fill("规则 1 表达式", "*.mkv"); await click("添加过滤规则"); await fill("规则 2 表达式", "**"); await fill("规则 2 动作", "exclude"); await click("保存草稿并预览");
  expect(f.api.saveSyncSource).toHaveBeenCalledTimes(1); expect(f.api.saveSyncSource.mock.calls[0]![0].configuration).toMatchObject({ type: "local", inputDirectoryId: f.input.id, filters: [{ action: "include", pattern: "*.mkv" }, { action: "exclude", pattern: "**" }] }); expect(f.api.confirmSyncSource).not.toHaveBeenCalled();
  await click("确认配置范围"); expect(f.api.confirmSyncSource).toHaveBeenCalledTimes(1); expect(document.body.textContent).toContain("范围已确认");
});
it("缺默认目录时保留已保存草稿且不确认、不执行", async () => {
  const f = await mount("/sources", (f) => f.api.getDefaultDownloadDirectory.mockResolvedValue({ version: 0, directory: null } as never)); await click("添加同步来源"); await fill("来源名称", "等默认目录"); await click("选择本地输入目录"); await click("保存草稿并预览"); expect(document.body.textContent).toContain("尚未设置默认下载目录"); expect(f.rows.size).toBe(1); expect(f.api.confirmSyncSource).not.toHaveBeenCalled();
});
it("完整预览仍有冲突时高亮计数和文件，翻页保留按钮拦截原因，修复后恢复确认", async () => {
  let conflicted = true;
  const f = await mount("/sources", (f) => {
    f.api.getSyncPreview.mockImplementation(async (id) => ({ ...structuredClone(f.previews.get(id)!), files: 26, state: conflicted ? "BLOCKED" : "READY", conflicts: conflicted ? 1 : 0 }));
    f.api.listSyncPreviewFiles.mockImplementation(async (query?: { page?: number }) => ({ total: 26, items: [{ relativePath: query?.page === 2 ? "其他文件.mp4" : "冲突原片.mp4", targetPath: f.target.path + "/completed/原片.mp4", size: 100, state: (conflicted && query?.page !== 2 ? "CONFLICT" : "READY") as "CONFLICT" | "READY", reason: conflicted && query?.page !== 2 ? "目标文件已存在，请核对目标路径" : null }] }));
  });
  await click("添加同步来源"); await fill("来源名称", "冲突反馈"); await click("选择本地输入目录"); await click("保存草稿并预览");
  expect(document.querySelector(".sync-conflict-count")?.textContent).toBe("冲突 1");
  expect(document.querySelector(".sync-file-blocked")?.textContent).toContain("冲突原片.mp4");
  expect(document.querySelector(".sync-file-blocked")?.textContent).toContain("目标文件已存在，请核对目标路径");
  const confirm = button("确认配置范围");
  expect(confirm.disabled).toBe(true);
  const reason = () => document.getElementById(confirm.getAttribute("aria-describedby")!);
  expect(reason()?.textContent).toContain("有 1 项冲突或目录不可用");
  expect(reason()?.textContent).toContain("处理后重新预览");
  await click("下一页");
  expect(document.querySelector(".sync-file-blocked")).toBeNull();
  expect(confirm.disabled).toBe(true); expect(reason()?.textContent).toContain("有 1 项冲突");
  await click("确认配置范围"); expect(f.api.confirmSyncSource).not.toHaveBeenCalled();
  conflicted = false;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
  expect(confirm.disabled).toBe(false); expect(confirm.hasAttribute("aria-describedby")).toBe(false);
  expect(document.querySelector(".sync-conflict-count")).toBeNull();
});
it.each([
  ["EXPIRED", true, null, "预览已过期或配置已变化"],
  ["BUILDING", false, null, "正在扫描文件范围"],
  ["BLOCKED", true, "文件范围不能启用周期扫描", "暂时无法确认：文件范围不能启用周期扫描"],
  ["BLOCKED", false, null, "文件范围尚未完整"],
] as const)("预览 %s 时在按钮旁解释禁用原因", async (state, complete, failure, reason) => {
  await mount("/sources", (f) => f.api.getSyncPreview.mockImplementation(async (id) => ({ ...structuredClone(f.previews.get(id)!), state, complete, failure })));
  await click("添加同步来源"); await fill("来源名称", "状态反馈"); await click("选择本地输入目录"); await click("保存草稿并预览");
  const confirm = button("确认配置范围"); expect(confirm.disabled).toBe(true);
  expect(document.getElementById(confirm.getAttribute("aria-describedby")!)?.textContent).toContain(reason);
});
it("执行一次必须单独核对本地完整性，确认传入冻结预览而不重存规则", async () => {
  const f = await mount(); await click("添加同步来源"); await fill("来源名称", "人工核对完整性"); await click("选择本地输入目录"); await click("保存草稿并预览"); await click("确认配置范围"); await click("执行一次");
  expect(button("确认执行一次").disabled).toBe(true);
  const checkbox = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((node) => node.parentElement?.textContent?.includes("我已确认本次本地文件完整")); expect(checkbox).toBeTruthy(); await act(async () => checkbox!.click());
  expect(button("确认执行一次").disabled).toBe(false); await click("确认执行一次");
  expect(f.api.saveSyncSource).toHaveBeenCalledTimes(1); expect(f.api.confirmSyncSource.mock.calls.at(-1)![0]).toMatchObject({ filesComplete: true, runOnce: false });
  expect(f.api.previewSyncSource.mock.calls.at(-1)![0]).toMatchObject({ mode: "execution", force: false });
});
it("核心已连接但目录授权未恢复时，执行等待当前授权查询", async () => {
  const f = await mount(); await click("添加同步来源"); await fill("来源名称", "等待原卷"); await click("选择本地输入目录"); await click("保存草稿并预览"); await click("确认配置范围");
  f.input.available = false; await act(async () => { await f.app.container.get(SyncViewModel).refresh(); }); expect(button("执行一次").disabled).toBe(true); expect(document.body.textContent).toContain("等待原目录恢复");
  f.input.available = true; await act(async () => { await f.app.container.get(SyncViewModel).refresh(); }); expect(button("执行一次").disabled).toBe(false); expect(f.api.confirmSyncSource).toHaveBeenCalledTimes(1);
});
it("登录往返保留 React 草稿；账号根变化要求重新选范围，模态选择取消不替换", async () => {
  const f = await mount(); await click("添加同步来源"); await fill("来源名称", "登录往返保留"); await fill("来源类型", "cloud"); await fill("网盘账号", f.account.id); await click("选择远端范围"); await click("选择");
  await act(async () => document.querySelector<HTMLAnchorElement>('a[href="/cloud?returnTo=sources"]')!.click()); f.account.rootRef = crypto.randomUUID(); await act(async () => document.querySelector<HTMLAnchorElement>('a[href="/sources"]')!.click());
  expect(field("来源名称").value).toBe("登录往返保留"); expect(document.body.textContent).toContain("账号授权已变化"); await click("保存草稿并预览"); expect(f.api.saveSyncSource).not.toHaveBeenCalled();
  await click("选择远端范围"); await click("取消选择远端范围"); expect(document.querySelector("dialog.sync-remote-dialog")).toBeNull(); expect(document.body.textContent).toContain("中文 目录");
});
it("离页不续发查询，StrictMode 只查询不重放命令；迟到读取不覆盖新一代", async () => {
  const f = await mount(); expect(f.api.saveSyncSource).not.toHaveBeenCalled(); expect(f.api.previewSyncSource).not.toHaveBeenCalled(); expect(f.api.confirmSyncSource).not.toHaveBeenCalled();
  const model = f.app.container.get(SyncViewModel), before = f.api.listSyncSources.mock.calls.length; await act(async () => { await model.refresh(); }); expect(f.api.listSyncSources.mock.calls.length).toBe(before + 1);
  await act(async () => { document.querySelector<HTMLAnchorElement>('a[href="/recognition"]')!.click(); });
  const count = f.api.listSyncSources.mock.calls.length; await act(async () => { await model.command("离页已提交命令", async () => "完成"); }); expect(f.api.listSyncSources.mock.calls.length).toBe(count);
});

it("删除失败在弹窗内定位来源与原因，重试期间明确反馈并禁止重复提交，成功移除来源信息且刷新不再显示", async () => {
  const f = await mount(); await click("添加同步来源"); await fill("来源名称", "等待停止的来源"); await click("选择本地输入目录"); await click("保存草稿并预览");
  const row = [...f.rows.values()][0]!;
  f.api.controlSyncSource.mockRejectedValueOnce(new Error("下载任务 isolated-job 仍在停止中，请等待停止完成后重试"));
  await click("删除同步来源…");
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="删除同步来源"]')!;
  expect(dialog.contains(document.activeElement)).toBe(true); expect(document.activeElement?.textContent).toBe("取消");
  await click("确认删除同步来源");
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("删除「等待停止的来源」未完成");
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("下载任务 isolated-job 仍在停止中");
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(f.rows.get(row.id)?.deletedAt).toBeNull();
  let complete!: (value: SyncSourceRule) => void;
  f.api.controlSyncSource.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  await click("确认删除同步来源");
  expect(button("正在删除…").disabled).toBe(true); expect(button("取消").disabled).toBe(true);
  await act(async () => button("正在删除…").click()); expect(f.api.controlSyncSource).toHaveBeenCalledTimes(2);
  await act(async () => { const removed = { ...row, paused: true, lifecycleRevision: row.lifecycleRevision + 1, deletedAt: new Date().toISOString() }; f.rows.set(row.id, removed); complete(structuredClone(removed)); });
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.querySelector('article[aria-label="同步来源 等待停止的来源"]')).toBeNull();
  expect(f.element.textContent).not.toContain("等待停止的来源");
  expect(f.element.textContent).not.toContain("已删除同步来源");
  expect(f.element.textContent).not.toContain("恢复已删除来源");
  await act(async () => { await f.app.container.get(SyncViewModel).refresh(); });
  expect(f.element.textContent).not.toContain("等待停止的来源");
  expect(document.querySelector('[aria-label="同步预览"]')).toBeNull();
  expect(f.api.confirmSyncSource).not.toHaveBeenCalled();
});


it("任务明细使用弹窗，关闭不改变任务；删除失败保留原因，成功刷新列表", async () => {
  const job = { id: crypto.randomUUID(), sourceId: crypto.randomUUID(), sourceVersion: 1, state: "DONE" as const, files: 1, done: 1, reused: 0, removed: 0, failed: 0, failure: null, downloadJobId: null, createdAt: "2026-10-30", updatedAt: "2026-10-30" };
  const f = await mount("/sources", (f) => {
    f.api.listSyncJobs.mockResolvedValue({ items: [job], total: 1 } as never);
    f.api.getSyncJob.mockResolvedValue(job); f.api.listSyncJobFiles.mockResolvedValue({ items: [], total: 0 });
    f.api.removeSyncJob.mockRejectedValueOnce(new Error("同步任务尚未停止，请等待在途同步停止后重试删除"));
    f.api.removeSyncJob.mockImplementationOnce(async () => { f.api.listSyncJobs.mockResolvedValue({ items: [], total: 0 }); return { id: job.id }; });
  });
  await click("查看任务明细"); expect(document.querySelector('dialog[aria-label="同步任务详情"]')?.hasAttribute("open")).toBe(true);
  expect(document.querySelector('dialog[aria-label="同步任务详情"]')?.textContent).toContain(job.id);
  await click("关闭任务详情"); expect(document.querySelector('dialog[aria-label="同步任务详情"]')).toBeNull(); expect(f.api.removeSyncJob).not.toHaveBeenCalled();
  await click("删除任务…"); await click("取消"); expect(f.api.removeSyncJob).not.toHaveBeenCalled();
  await click("删除任务…"); await click("确认删除同步任务"); expect(document.querySelector('dialog[aria-label="删除同步任务"] [role="alert"]')?.textContent).toContain("在途同步停止");
  await click("确认删除同步任务"); expect(document.querySelector('dialog[aria-label="删除同步任务"]')).toBeNull(); expect(document.body.textContent).toContain("暂无同步任务");
});
