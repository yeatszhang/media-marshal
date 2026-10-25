// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ContainerProvider } from "@yeatz/app-framework/react";
import { sourceConfigurationSchema, type DesktopApi, type SourceRule, type SourceRulePreview, type SourceExecutionPreview, type CloudAccount, type RemoteEntry, type SourceRun } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { SourceRulesViewModel } from "./source-rules-model";
import { Sources } from "./pages/Sources";
import { AccountConnections } from "./pages/AccountConnections";
import { Subscriptions } from "./pages/Subscriptions";
import { i18nReady } from "./i18n";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); document.body.innerHTML = ""; vi.useRealTimers(); });
function memoryApi() {
  const rows = new Map<string, SourceRule>(), previews = new Map<string, SourceRulePreview>(), executions = new Map<string, SourceExecutionPreview>(), receipts = new Map<string, string>(), calls: string[] = [];
  const account: CloudAccount = { id: crypto.randomUUID(), name: "我的夸克", providerKind: "quark", status: "READY", capabilities: null, rootRef: crypto.randomUUID() };
  const directory: RemoteEntry = { accountId: account.id, ref: crypto.randomUUID(), parentRef: account.rootRef!, name: "影视目录", type: "directory", size: null, modifiedAt: null, version: null };
  const file: RemoteEntry = { ...directory, ref: crypto.randomUUID(), name: "中文长文件名_".repeat(40) + ".mp4", type: "file" };
  const root = { id: crypto.randomUUID(), path: "/中文 下载", state: "AVAILABLE" as const, availableBytes: 10 * 1024 ** 3 }, stamp = new Date().toISOString();
  const copy = <T,>(value: T): T => structuredClone(value);
  const api = {
    listSourceRules: vi.fn(async () => copy([...rows.values()])), getSourceRule: vi.fn(async (id: string) => copy(rows.get(id) ?? null)),
    listCloudAccounts: vi.fn(async () => [account]), listDownloadRoots: vi.fn(async () => [root]), listCloudSubscriptions: vi.fn(async () => ({ items: [], total: 0 })), listSourceLegacy: vi.fn(async () => ({ items: [], total: 0 })),
    resolveSourceLegacy: vi.fn<DesktopApi["resolveSourceLegacy"]>(async () => null), getOrganizePause: vi.fn(async () => ({ paused: false })), setOrganizePause: vi.fn(async (input: { paused: boolean }) => ({ paused: input.paused })),
    chooseDirectory: vi.fn(async (purpose: string) => purpose === "source" ? "/本地 输入" : "/电影 媒体库"), chooseDownloadRoot: vi.fn(async () => root),
    listRemote: vi.fn(async () => ({ items: [directory, file], nextCursor: null, total: null, complete: true })),
    statRemote: vi.fn(async (_account: string, ref: string) => ref === account.rootRef ? { ...directory, ref, name: account.name, parentRef: null } : ref === directory.ref ? directory : file),
    configureSourceRule: vi.fn(async (input: Parameters<DesktopApi["configureSourceRule"]>[0]) => {
      calls.push("configure"); const previous = rows.get(input.id), repeated = receipts.get(input.requestKey); if (repeated) return copy(rows.get(repeated)!);
      if (previous ? previous.version !== input.expectedVersion || previous.draftRevision !== input.expectedDraftRevision : input.expectedVersion !== 0 || input.expectedDraftRevision !== 0) throw new Error("版本冲突");
      const configuration = sourceConfigurationSchema.parse(input.configuration);
      const row: SourceRule = { ...(previous ?? { id: input.id, type: configuration.type, version: 0, paused: true, configuration: null, reviewRequired: false, localSourceId: null, subscriptionId: null, ingestionSourceId: null, createdAt: stamp, updatedAt: stamp }), draft: configuration, draftRevision: input.expectedDraftRevision + 1, remoteName: directory.name, lastRun: null };
      rows.set(input.id, row); receipts.set(input.requestKey, input.id); return copy(row);
    }),
    previewSourceRule: vi.fn(async (input: Parameters<DesktopApi["previewSourceRule"]>[0]) => {
      calls.push("preview"); const row = rows.get(input.id)!;
      const preview: SourceRulePreview = { id: crypto.randomUUID(), sourceId: row.id, version: row.version, draftRevision: row.draftRevision, configuration: copy(row.draft), state: "READY", expiresAt: Date.now() + 900000, organizationConflicts: [], download: row.type === "cloud" ? { id: crypto.randomUUID(), accountId: account.id, remoteRef: directory.ref, targetGrantId: root.id, files: 2, bytes: 50, complete: true, weakComparison: true, expiresAt: new Date(Date.now() + 900000).toISOString(), state: "READY", failure: null, reuseFiles: 1, conflicts: 0, forceRedownload: false, destinationPrefix: "completed", selectionPath: directory.name, layout: "drive" } : null };
      previews.set(preview.id, preview); return copy(preview);
    }),
    getSourceRulePreview: vi.fn(async (id: string) => copy(previews.get(id) ?? null)),
    applySourceRule: vi.fn(async (input: Parameters<DesktopApi["applySourceRule"]>[0]) => {
      calls.push("apply"); const preview = previews.get(input.previewId)!, row = rows.get(preview.sourceId)!;
      if (preview.version !== row.version || preview.draftRevision !== row.draftRevision) throw new Error("预览已变化");
      const saved: SourceRule = { ...row, version: row.version + 1, configuration: copy(preview.configuration), paused: false, localSourceId: row.type === "local" ? row.id : null };
      rows.set(saved.id, saved); preview.state = "APPLIED"; return copy(saved);
    }),
    runSourceOnce: vi.fn(async (input: Parameters<DesktopApi["runSourceOnce"]>[0]) => {
      calls.push("run"); const row = rows.get(input.id)!; if (!row.configuration || row.version !== input.expectedVersion) throw new Error("来源尚未确认");
      const run: SourceRun = { id: crypto.randomUUID(), sourceId: row.id, sourceVersion: row.version, state: "SUBMITTED", jobId: crypto.randomUUID(), failure: null, createdAt: stamp, updatedAt: stamp, forceRedownload: false }; row.lastRun = run; return copy(run);
    }),
    previewSourceExecution: vi.fn(async (input: Parameters<DesktopApi["previewSourceExecution"]>[0]) => {
      const row = rows.get(input.id)!, id = crypto.randomUUID(), configuration = row.configuration!;
      const preview: SourceExecutionPreview = { id, sourceId: row.id, sourceVersion: row.version, name: configuration.name, forceRedownload: !!input.forceRedownload, state: "READY", expiresAt: Date.now() + 900000, run: null, download: { id, accountId: account.id, remoteRef: directory.ref, targetGrantId: root.id, files: 2, bytes: 50, complete: true, weakComparison: true, expiresAt: new Date(Date.now() + 900000).toISOString(), state: "READY", failure: null, reuseFiles: 0, conflicts: 0, forceRedownload: !!input.forceRedownload, destinationPrefix: input.forceRedownload ? `completed/redownload-${id}` : "completed", selectionPath: directory.name, layout: "drive" } };
      executions.set(id, preview); return copy(preview);
    }),
    getSourceExecutionPreview: vi.fn(async (id: string) => copy(executions.get(id) ?? null)),
    executeSourcePreview: vi.fn(async (input: Parameters<DesktopApi["executeSourcePreview"]>[0]) => {
      calls.push("execute"); const preview = executions.get(input.previewId)!, row = rows.get(preview.sourceId)!;
      const run: SourceRun = { id: crypto.randomUUID(), sourceId: row.id, sourceVersion: row.version, forceRedownload: preview.forceRedownload, state: "SUBMITTED", jobId: crypto.randomUUID(), failure: null, createdAt: stamp, updatedAt: stamp }; preview.state = "APPLIED"; preview.run = run; row.lastRun = run; return copy(run);
    }),
    controlSourceRule: vi.fn(async (input: Parameters<DesktopApi["controlSourceRule"]>[0]) => { const row = rows.get(input.id)!; if (input.operation !== "scan") row.paused = input.operation === "pause"; return copy(row); }),
    loginCloudAccount: vi.fn(), cancelCloudLogin: vi.fn(async () => {}), getCloudAuthorization: vi.fn(async () => null), authorizeCloudAccount: vi.fn(), disconnectCloudAccount: vi.fn(async () => {}), restoreCloudAccounts: vi.fn(async () => {}),
    configureCloudSubscription: vi.fn(), confirmDownload: vi.fn(), previewDownload: vi.fn(), saveSource: vi.fn(), configureManagedIngestion: vi.fn(),
  };
  return { api, rows, previews, executions, calls, account, directory, file, root };
}
async function mount(overrides: Partial<DesktopApi> = {}, path = "/sources", setup?: (fixture: ReturnType<typeof memoryApi>) => void) {
  await i18nReady; const f = memoryApi(); setup?.(f);
  const api = { ...f.api, ...overrides } as unknown as DesktopApi, app = createRendererApplication(api); await app.start();
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  await act(async () => { root.render(<StrictMode><MemoryRouter initialEntries={[path]}><ContainerProvider value={app.container}><Routes><Route path="/sources" element={<Sources />} /><Route path="/cloud" element={<AccountConnections />} /><Route path="/subscriptions/:id" element={<Subscriptions />} /><Route path="/subscriptions" element={<Subscriptions />} /></Routes></ContainerProvider></MemoryRouter></StrictMode>); });
  cleanup.push(async () => { await act(async () => root.unmount()); await app.stop(); });
  return { ...f, api, app, element, model: app.container.get(SourceRulesViewModel) };
}
const button = (name: string) => { const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((value) => value.textContent?.trim() === name); expect(found, name).toBeTruthy(); return found!; };
async function click(name: string) { await act(async () => button(name).click()); }
function field(name: string) { const label = [...document.querySelectorAll("label")].find((value) => value.textContent?.startsWith(name)); expect(label, name).toBeTruthy(); return label!.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input,select,textarea")!; }
async function fill(name: string, value: string) {
  const input = field(name), prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
async function checkbox(name: string) { await act(async () => field(name).click()); }
async function selectRemote(name: string) { await click("选择远端范围"); await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="选择范围 ${name}"]`)!.click()); }
async function cloudDraft(f: Awaited<ReturnType<typeof mount>>) { await click("添加来源"); await fill("来源名称", "我的下载来源"); await selectRemote(f.directory.name); await click("选择下载目录"); }

describe("统一来源页、连接返回和确认边界", () => {
  it("本地忽略区分默认、显式关闭与自定义，重开保留设置且未确认不执行", async () => {
    const f = await mount(); await click("添加来源"); await fill("来源类型", "local"); await fill("来源名称", "本地忽略验收");
    await click("选择本地输入目录"); await click("选择整理目标目录");
    for (const mode of ["default", "none", "custom"]) {
      await fill("本地忽略规则", mode);
      if (mode === "custom") await fill("忽略文件名或目录", "cache/\n*.tmp");
      await click("保存草稿"); const row = [...f.rows.values()][0]!;
      expect(row.draft).toMatchObject({ ignoredFilePatterns: mode === "default" ? null : mode === "none" ? [] : ["cache/", "*.tmp"] });
      await act(async () => { await f.model.openSource(row.id); }); expect(field("本地忽略规则").value).toBe(mode);
    }
    await click("预览配置"); expect(f.element.textContent).toContain("cache/、*.tmp");
    expect(f.api.applySourceRule).not.toHaveBeenCalled(); expect(f.api.loginCloudAccount).not.toHaveBeenCalled(); expect(f.api.listRemote).not.toHaveBeenCalled();
    await fill("忽略文件名或目录", ""); await click("保存草稿"); expect(f.element.textContent).toContain("本地忽略规则须为 1～100 行");
    expect(f.api.configureSourceRule).toHaveBeenCalledTimes(3);
  });
  it("新建只展示夸克与自定义标签，历史百度标签原样编辑且不触发网盘操作", async () => {
    const f = await mount(); await click("添加来源"); await fill("来源类型", "local");
    expect([...field("外部下载客户端").querySelectorAll("option")].map((value) => value.value)).toEqual(["quark", "custom"]);
    const id = crypto.randomUUID(), stamp = new Date().toISOString(), configuration = sourceConfigurationSchema.parse({ type: "local", name: "旧百度目录", client: "baidu", sourcePath: "/原有来源", organization: { targetPath: "/原有目标" } });
    f.rows.set(id, { id, type: "local", version: 3, draftRevision: 4, draft: configuration, configuration, paused: true, reviewRequired: true, localSourceId: id, subscriptionId: null, ingestionSourceId: null, remoteName: null, lastRun: null, createdAt: stamp, updatedAt: stamp });
    await act(async () => { await f.model.openSource(id); });
    expect((field("外部下载客户端") as HTMLSelectElement).value).toBe("baidu"); expect(f.element.textContent).toContain("此历史客户端行为未验证");
    await fill("来源名称", "改名后仍保留原标签"); await click("保存草稿");
    expect(f.api.configureSourceRule).toHaveBeenCalledWith(expect.objectContaining({ id, expectedVersion: 3, configuration: expect.objectContaining({ type: "local", client: "baidu", sourcePath: "/原有来源" }) }));
    expect(f.rows.get(id)).toMatchObject({ id, version: 3, paused: true }); expect(f.api.listRemote).not.toHaveBeenCalled(); expect(f.api.applySourceRule).not.toHaveBeenCalled();
  });
  it("StrictMode 只查询，草稿保存不启用或下载，网盘只下载使用正确的选择器", async () => {
    const f = await mount(); expect(f.api.configureSourceRule).not.toHaveBeenCalled(); await cloudDraft(f); await click("保存草稿");
    expect(f.api.configureSourceRule).toHaveBeenCalledOnce(); expect(f.api.configureSourceRule).toHaveBeenCalledWith(expect.objectContaining({ configuration: expect.objectContaining({ type: "cloud", organization: null, periodic: { enabled: false, intervalSeconds: 900 } }) }));
    expect(f.api.chooseDownloadRoot).toHaveBeenCalledOnce(); expect(f.api.chooseDirectory).not.toHaveBeenCalled();
    expect(f.api.applySourceRule).not.toHaveBeenCalled(); expect(f.api.runSourceOnce).not.toHaveBeenCalled(); expect(f.api.configureCloudSubscription).not.toHaveBeenCalled();
    expect(f.element.textContent).toContain("尚未确认");
  });
  it("本地来源使用输入与目标原生授权，取消选择保留已选路径且字段互斥", async () => {
    const f = await mount(); await click("添加来源"); await fill("来源类型", "local"); await fill("来源名称", "本地来源");
    await click("选择本地输入目录"); await click("选择整理目标目录");
    vi.mocked(f.api.chooseDirectory).mockResolvedValueOnce(null); await click("选择本地输入目录");
    expect(f.element.textContent).toContain("/本地 输入"); expect(f.api.chooseDirectory).toHaveBeenNthCalledWith(1, "source"); expect(f.api.chooseDirectory).toHaveBeenNthCalledWith(2, "target");
    await click("预览配置"); expect(f.api.configureSourceRule).toHaveBeenCalledWith(expect.objectContaining({ configuration: { type: "local", name: "本地来源", client: "custom", sourcePath: "/本地 输入", ignoredFilePatterns: null, organization: { targetPath: "/电影 媒体库", mediaType: "AUTO", operation: "COPY", automatic: false } } }));
    expect(f.api.chooseDownloadRoot).not.toHaveBeenCalled(); expect(f.api.listRemote).not.toHaveBeenCalled(); await click("确认配置生效"); expect(f.api.applySourceRule).toHaveBeenCalledOnce();
  });
  it("没有账号时保留未完成草稿，连接成功返回后不创建来源或下载", async () => {
    let connected = false; const account: CloudAccount = { id: crypto.randomUUID(), name: "新连接", providerKind: "quark", status: "READY", capabilities: null, rootRef: crypto.randomUUID() };
    const f = await mount({ listCloudAccounts: async () => connected ? [account] : [], loginCloudAccount: async (input) => { connected = true; return { id: crypto.randomUUID(), accountId: account.id, requestKey: input.requestKey, state: "SUCCEEDED", failure: null, updatedAt: new Date().toISOString() }; } });
    await click("添加来源"); await fill("来源名称", "需要保留的草稿"); await fill("扩展名过滤", "mkv"); expect(button("选择远端范围").disabled).toBe(true);
    await act(async () => document.querySelector<HTMLAnchorElement>('a[href="/cloud?returnTo=sources"]')!.click());
    await click("连接夸克账号"); await fill("账号名称", "新连接"); await click("打开扫码登录");
    expect(field("来源名称").value).toBe("需要保留的草稿"); expect(field("扩展名过滤").value).toBe("mkv"); expect(field("网盘账号").value).toBe(account.id);
    expect(f.api.configureSourceRule).not.toHaveBeenCalled(); expect(f.api.runSourceOnce).not.toHaveBeenCalled(); expect(f.api.listRemote).not.toHaveBeenCalled();
  });
  it("完整预览后执行一次才提交下载，周期扫描保持关闭，响应丢失可查询确认结果", async () => {
    const f = await mount(); await cloudDraft(f); const apply = vi.mocked(f.api.applySourceRule).getMockImplementation()!;
    vi.mocked(f.api.applySourceRule).mockImplementationOnce(async (input) => { await apply(input); throw new Error("确认响应丢失"); });
    await click("预览配置"); expect(f.api.applySourceRule).not.toHaveBeenCalled(); expect(f.element.textContent).toContain("完整范围：2 项");
    expect(f.element.textContent).toContain("同尺寸内容替换可能无法识别"); expect(f.element.textContent).toContain("/中文 下载/completed/影视目录");
    await click("确认并执行一次"); expect(f.api.applySourceRule).toHaveBeenCalledOnce(); expect(f.api.applySourceRule).toHaveBeenCalledWith(expect.objectContaining({ runOnce: true })); expect(f.api.runSourceOnce).not.toHaveBeenCalled(); expect(f.calls).toEqual(["configure", "preview", "apply"]);
    expect([...f.rows.values()][0]!.configuration).toMatchObject({ periodic: { enabled: false }, organization: null }); expect(f.api.confirmDownload).not.toHaveBeenCalled();
  });
  it("过滤变更撤销旧确认，周期扫描与可选整理经同一来源预览生效", async () => {
    const f = await mount(); await cloudDraft(f); await checkbox("定期扫描目录"); await checkbox("下载后接入整理"); await click("选择整理目标目录");
    await click("预览配置"); expect(button("确认启用并扫描").disabled).toBe(false); await fill("扩展名过滤", "mp4,mkv");
    expect([...document.querySelectorAll("button")].some((value) => value.textContent === "确认启用并扫描")).toBe(false); expect(f.api.applySourceRule).not.toHaveBeenCalled();
    await click("预览配置"); await click("确认启用并扫描");
    expect(f.api.configureSourceRule).toHaveBeenLastCalledWith(expect.objectContaining({ expectedVersion: 0, expectedDraftRevision: 1, configuration: expect.objectContaining({ filters: { extensions: ["mkv", "mp4"], names: [] }, periodic: { enabled: true, intervalSeconds: 900 }, organization: expect.objectContaining({ targetPath: "/电影 媒体库" }) }) }));
    expect(f.api.applySourceRule).toHaveBeenCalledOnce(); expect(f.api.runSourceOnce).not.toHaveBeenCalled(); expect(f.api.configureCloudSubscription).not.toHaveBeenCalled();
  });
  it("浏览器取消不改范围，长中文、未知总量和分页失败保留已有条目，文件不启用周期", async () => {
    const f = await mount(); await cloudDraft(f); await checkbox("定期扫描目录");
    await click("选择远端范围"); await click("取消选择远端范围"); expect(f.model.state.editor?.remoteRef).toBe(f.directory.ref);
    let finish!: (value: Awaited<ReturnType<DesktopApi["listRemote"]>>) => void;
    vi.mocked(f.api.listRemote).mockImplementationOnce(() => new Promise((done) => { finish = done; })).mockRejectedValueOnce(new Error("网络暂不可用"));
    await click("选择远端范围"); expect(f.element.textContent).toContain("正在读取目录");
    await act(async () => finish({ items: [f.file], total: null, complete: false, nextCursor: "opaque-next" }));
    expect(f.element.textContent).toContain("总数未知"); expect(document.querySelector(`[title="${f.file.name}"]`)).toBeTruthy();
    await click("加载更多"); expect(f.element.textContent).toContain("网络暂不可用"); expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
    await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="选择范围 ${f.file.name}"]`)!.click());
    expect((field("定期扫描目录") as HTMLInputElement).checked).toBe(false); expect(field("定期扫描目录").disabled).toBe(true); expect(f.model.state.editor?.remoteType).toBe("file");
  });
  it("预览失败显式重试复用请求标识，刷新和表单重挂载不重放创建", async () => {
    const f = await mount(); await cloudDraft(f); vi.mocked(f.api.previewSourceRule).mockRejectedValueOnce(new Error("暂时断开"));
    await click("预览配置"); expect(f.element.textContent).toContain("暂时断开"); expect(f.api.configureSourceRule).toHaveBeenCalledOnce();
    await click("预览配置"); const calls = vi.mocked(f.api.previewSourceRule).mock.calls; expect(calls[0]![0].requestKey).toBe(calls[1]![0].requestKey);
    await act(async () => { await f.model.refresh(); }); expect(f.api.configureSourceRule).toHaveBeenCalledOnce(); expect(f.api.applySourceRule).not.toHaveBeenCalled();
  });
  it("旧订阅链接定位原来源，失效范围重新选择后沿原版本确认", async () => {
    const legacyId = crypto.randomUUID(), sourceId = crypto.randomUUID(), oldRef = crypto.randomUUID();
    const f = await mount({}, `/subscriptions/${legacyId}`, (fixture) => {
      const configuration = sourceConfigurationSchema.parse({ type: "cloud", name: "原来源", accountId: fixture.account.id, remoteRef: oldRef, downloadRootId: fixture.root.id, periodic: { enabled: true, intervalSeconds: 900 } });
      fixture.rows.set(sourceId, { id: sourceId, type: "cloud", version: 3, draftRevision: 1, draft: configuration, configuration, paused: true, reviewRequired: false, localSourceId: null, subscriptionId: legacyId, ingestionSourceId: null, remoteName: "原范围", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      fixture.api.resolveSourceLegacy.mockResolvedValue({ kind: "subscription", id: legacyId, sourceId, status: "MAPPED", reason: "NONE" });
      fixture.api.statRemote.mockImplementation(async (_account, ref) => { if (ref === oldRef) throw new Error("范围失效"); return fixture.directory; });
    });
    expect(f.element.textContent).toContain("已从旧入口定位到统一来源"); expect(f.element.textContent).toContain("原远端范围尚不可用");
    expect(f.api.configureSourceRule).not.toHaveBeenCalled(); await selectRemote(f.directory.name); await click("预览配置"); await click("确认启用并扫描");
    expect(f.api.configureSourceRule).toHaveBeenCalledWith(expect.objectContaining({ id: sourceId, expectedVersion: 3, expectedDraftRevision: 1, configuration: expect.objectContaining({ remoteRef: f.directory.ref }) }));
    expect(f.rows.get(sourceId)?.version).toBe(4); expect(f.api.configureCloudSubscription).not.toHaveBeenCalled();
  });
  it("无法映射的旧入口回到来源列表解释，不创建替代来源或订阅", async () => {
    const f = await mount({}, `/subscriptions/${crypto.randomUUID()}`);
    expect(f.element.textContent).toContain("旧入口无法唯一定位来源"); expect(f.element.textContent).toContain("还没有来源");
    expect(f.api.configureSourceRule).not.toHaveBeenCalled(); expect(f.api.configureCloudSubscription).not.toHaveBeenCalled(); expect(document.querySelector('form[aria-label="来源配置草稿"]')).toBeNull();
  });
  it("强制重下先确认独立完成路径，执行不编辑当前周期来源", async () => {
    const sourceId = crypto.randomUUID();
    const f = await mount({}, "/sources", (fixture) => {
      const configuration = sourceConfigurationSchema.parse({ type: "cloud", name: "周期来源", accountId: fixture.account.id, remoteRef: fixture.directory.ref, downloadRootId: fixture.root.id, periodic: { enabled: true, intervalSeconds: 900 } });
      fixture.rows.set(sourceId, { id: sourceId, type: "cloud", version: 2, draftRevision: 1, draft: configuration, configuration, paused: false, reviewRequired: false, localSourceId: null, subscriptionId: crypto.randomUUID(), ingestionSourceId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    });
    await click("强制重新下载…");
    expect(f.api.previewSourceExecution).toHaveBeenCalledWith(expect.objectContaining({ id: sourceId, expectedVersion: 2, forceRedownload: true }));
    expect(f.element.textContent).toContain("completed/redownload-"); expect(f.element.textContent).toContain("不修改来源草稿或周期扫描策略"); expect(f.api.executeSourcePreview).not.toHaveBeenCalled();
    await click("确认强制下载到独立目录"); await act(async () => { await f.model.refresh(); });
    expect(f.api.executeSourcePreview).toHaveBeenCalledOnce(); expect(f.api.configureSourceRule).not.toHaveBeenCalled(); expect(f.api.applySourceRule).not.toHaveBeenCalled();
    expect(f.rows.get(sourceId)?.configuration).toMatchObject({ periodic: { enabled: true, intervalSeconds: 900 } }); expect(f.rows.get(sourceId)?.version).toBe(2);
  });
});
