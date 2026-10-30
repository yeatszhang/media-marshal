import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import { sourceConfigurationSchema, type CoreInput, type LocalSourceHealth, type SourceConfiguration, type SourceRule, type SourceRulePreview, type SourceExecutionPreview, type DesktopApi, type CloudAccount, type ManagedDownloadRoot, type RemoteEntry, type CloudSubscription, type SourceLegacyReference } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";

export interface SourceEditor {
  id: string; version: number; draftRevision: number; type: "local" | "cloud"; name: string;
  lifecycleRevision: number; archived: boolean;
  client: "quark" | "baidu" | "alipan" | "custom"; sourcePath: string;
  ignoreMode: "default" | "none" | "custom"; ignoredFilePatterns: string;
  accountId: string; remoteRef: string; remoteName: string; remoteType: "file" | "directory" | null; downloadRootId: string;
  extensions: string; names: string; periodic: boolean; intervalSeconds: number;
  organize: boolean; automatic: boolean; targetPath: string; mediaType: "AUTO" | "MOVIE" | "TV_SHOW";
}
export interface SourceViewState {
  items: SourceRule[]; archived: SourceRule[]; accounts: CloudAccount[]; roots: ManagedDownloadRoot[]; subscriptions: CloudSubscription[];
  legacy: SourceLegacyReference[]; legacyNotice: string | null; loading: boolean; error: string | null; notice: string | null;
  editor: SourceEditor | null; dirty: boolean; pending: string | null; busy: string[]; preview: SourceRulePreview | null;
  picker: boolean; trail: RemoteEntry[]; entries: RemoteEntry[]; cursor: string | null; total: number | null; complete: boolean; browsing: boolean; browserError: string | null;
  organizePaused: boolean;
  executionPreview: SourceExecutionPreview | null;
  localHealth: Record<string, LocalSourceHealth>; healthBusy: string[]; healthError: string | null;
}
export const sourceDraftKeys = ["editor", "dirty", "picker", "trail", "entries", "cursor", "total", "complete", "browsing", "browserError"] as const;
export type SourceDraftState = Pick<SourceViewState, (typeof sourceDraftKeys)[number]>;
export type SourceRemoteState = Omit<SourceViewState, keyof SourceDraftState>;
export interface SourceComputed { sourceCount: number; archivedCount: number; hasPending: boolean }
export const emptySourceDraft = (): SourceDraftState => ({ editor: null, dirty: false, picker: false, trail: [], entries: [], cursor: null, total: null, complete: false, browsing: false, browserError: null });
// 框架 computed 是不可枚举 getter，组合 React 草稿时须显式取值。
export function sourceView(remote: SourceRemoteState & SourceComputed, draft: SourceDraftState): SourceViewState & SourceComputed { return { ...remote, sourceCount: remote.sourceCount, archivedCount: remote.archivedCount, hasPending: remote.hasPending, ...draft }; }
const emptyDraft = emptySourceDraft();
interface DraftBinding { read(): SourceDraftState; update(patch: Partial<SourceDraftState>): void }
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试";
const emptyEditor = (accountId = ""): SourceEditor => ({ id: crypto.randomUUID(), version: 0, draftRevision: 0, lifecycleRevision: 0, archived: false, type: "cloud", name: "", client: "custom", sourcePath: "", ignoreMode: "default", ignoredFilePatterns: "", accountId, remoteRef: "", remoteName: "", remoteType: null, downloadRootId: "", extensions: "", names: "", periodic: false, intervalSeconds: 900, organize: false, automatic: false, targetPath: "", mediaType: "AUTO" });
function fromSource(row: SourceRule): SourceEditor {
  const configuration = row.draft, common = { ...emptyEditor(), id: row.id, version: row.version, draftRevision: row.draftRevision, lifecycleRevision: row.lifecycleRevision ?? 0, archived: !!row.deletedAt, type: row.type, name: configuration.name, organize: !!configuration.organization, automatic: configuration.organization?.automatic ?? false, targetPath: configuration.organization?.targetPath ?? "", mediaType: configuration.organization?.mediaType ?? "AUTO" };
  return configuration.type === "local" ? { ...common, client: configuration.client, sourcePath: configuration.sourcePath, ignoreMode: configuration.ignoredFilePatterns == null ? "default" : configuration.ignoredFilePatterns.length ? "custom" : "none", ignoredFilePatterns: configuration.ignoredFilePatterns?.join("\n") ?? "" } : { ...common, accountId: configuration.accountId, remoteRef: configuration.remoteRef, remoteName: row.remoteName ?? "已保存的远端范围", downloadRootId: configuration.downloadRootId, extensions: configuration.filters.extensions.join(","), names: configuration.filters.names.join("\n"), periodic: configuration.periodic.enabled, intervalSeconds: configuration.periodic.intervalSeconds };
}

/** 服务只保存核心 DTO 及操作反馈；表单和远端选择临时状态由路由上层 React 绑定提供。 */
@injectable()
export class SourceRulesViewModel extends StatefulService<SourceRemoteState, SourceComputed> {
  protected initState: SourceRemoteState = { items: [], archived: [], accounts: [], roots: [], subscriptions: [], legacy: [], legacyNotice: null, loading: false, error: null, notice: null, pending: null, busy: [], preview: null, organizePaused: false, executionPreview: null, localHealth: {}, healthBusy: [], healthError: null };
  protected computed = { sourceCount: (state: SourceRemoteState) => state.items.length, archivedCount: (state: SourceRemoteState) => state.archived.length, hasPending: (state: SourceRemoteState) => !!state.pending };
  private draftBinding: DraftBinding | null = null;
  get view(): SourceViewState & SourceComputed { return sourceView(this.state, this.draftBinding?.read() ?? emptyDraft); }
  bindDraft(binding: DraftBinding) {
    if (this.draftBinding && this.draftBinding !== binding) throw new Error("来源草稿只能绑定一个 React 根");
    this.draftBinding = binding;
    return () => { if (this.draftBinding === binding) { this.draftBinding = null; ++this.request; ++this.navigation; ++this.editorEpoch; ++this.epoch; this.flight = undefined; clearTimeout(this.timer); this.releaseHealth(); } };
  }
  private updateView(patch: Partial<SourceViewState>) {
    const draft: Partial<SourceDraftState> = {}, remote: Partial<SourceRemoteState> = {};
    for (const [key, value] of Object.entries(patch)) {
      if ((sourceDraftKeys as readonly string[]).includes(key)) Object.assign(draft, { [key]: value });
      else if (!Object.is(this.state[key as keyof SourceRemoteState], value)) Object.assign(remote, { [key]: value });
    }
    if (Object.keys(draft).length) this.draftBinding?.update(draft);
    if (Object.keys(remote).length) this.setState(remote);
  }
  private stopped = false; private watchers = 0; private epoch = 0; private request = 0; private navigation = 0; private editorEpoch = 0;
  private timer?: ReturnType<typeof setTimeout>; private flight?: Promise<void>; private editorRow: SourceRule | null = null;
  private queryError: string | null = null;
  private healthOwner = 0; private healthRequest = 0; private healthTimer?: ReturnType<typeof setTimeout>;
  private healthTargets: CoreInput<"source-rules.local-health">["items"] = [];
  private saveIntent?: { signature: string; key: string }; private previewIntent?: { signature: string; key: string };
  private executionIntent?: { signature: string; key: string };
  private lifecycleIntents = new Map<string, string>();
  private confirmations = new Map<string, string>(); private controls = new Map<string, string>();
  constructor(@inject(DesktopClient) readonly client: DesktopApi) { super(); }
  watch() {
    if (this.stopped || !this.draftBinding) return () => {};
    if (this.view.picker) void this.browse();
    if (++this.watchers === 1) { const epoch = ++this.epoch; const tick = async () => { await this.refresh(); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void tick(); }, this.view.preview?.state === "BUILDING" ? 500 : 1500); }; void tick(); }
    let released = false; return () => { if (released) return; released = true; if (!--this.watchers) { ++this.epoch; ++this.request; ++this.navigation; this.flight = undefined; clearTimeout(this.timer); this.updateView({ loading: false, browsing: false }); } };
  }
  refresh(): Promise<void> { if (this.stopped || !this.draftBinding) return Promise.resolve(); if (this.flight) return this.flight; const flight = this.read().finally(() => { if (this.flight === flight) this.flight = undefined; }); return this.flight = flight; }
  reload() { this.updateView({ error: null }); return this.refresh(); }
  private releaseHealth() { ++this.healthOwner; ++this.healthRequest; clearTimeout(this.healthTimer); this.healthTargets = []; if (!this.stopped) this.updateView({ healthBusy: [], healthError: null }); }
  watchLocalHealth(items: CoreInput<"source-rules.local-health">["items"]) {
    this.releaseHealth(); if (this.stopped || !this.draftBinding || !items.length) return () => {};
    this.healthTargets = items; const owner = this.healthOwner;
    const tick = async () => { await this.checkVisibleLocalHealth(); if (!this.stopped && owner === this.healthOwner && this.draftBinding) this.healthTimer = setTimeout(() => { void tick(); }, 10000); }; void tick();
    return () => { if (owner === this.healthOwner) this.releaseHealth(); };
  }
  checkVisibleLocalHealth(force = false) { return this.checkLocalHealth(this.healthTargets, force); }
  checkLocalSourceHealth(row: SourceRule) { return this.checkLocalHealth([{ id: row.id, expectedVersion: row.version, expectedLifecycleRevision: row.lifecycleRevision ?? 0 }], true); }
  private async checkLocalHealth(items: CoreInput<"source-rules.local-health">["items"], force: boolean) {
    if (this.stopped || !this.draftBinding || !items.length || this.view.healthBusy.length) return;
    const owner = this.healthOwner, request = ++this.healthRequest;
    this.updateView({ healthBusy: items.map((item) => item.id) });
    try {
      const result = await this.client.checkLocalSourceHealth({ items, force });
      if (this.stopped || !this.draftBinding || owner !== this.healthOwner || request !== this.healthRequest) return;
      const localHealth = { ...this.view.localHealth };
      for (const item of result.items) { const row = this.view.items.find((row) => row.id === item.sourceId); if (row?.version === item.version && (row.lifecycleRevision ?? 0) === item.lifecycleRevision && row.configuration?.type === "local") localHealth[item.sourceId] = item; }
      this.updateView({ localHealth, healthError: null });
    } catch (error) { if (!this.stopped && owner === this.healthOwner && request === this.healthRequest) this.updateView({ healthError: errorText(error) }); }
    finally { if (!this.stopped && owner === this.healthOwner && request === this.healthRequest) this.updateView({ healthBusy: [] }); }
  }
  legacyNotice(message: string) { this.updateView({ legacyNotice: message }); }
  private async read() {
    const request = ++this.request; this.updateView({ loading: true });
    try {
      const [allItems, accounts, roots, subscriptions, legacy, pause] = await Promise.all([this.client.listSourceRules({ includeDeleted: true }), this.client.listCloudAccounts(), this.client.listDownloadRoots(), this.client.listCloudSubscriptions({ page: 1, pageSize: 100 }), this.client.listSourceLegacy({ status: "REVIEW_REQUIRED", page: 1, pageSize: 100 }), this.client.getOrganizePause()]);
      if (this.stopped || request !== this.request) return;
      const items = allItems.filter((row) => !row.deletedAt), archived = allItems.filter((row) => !!row.deletedAt), edited = allItems.find((row) => row.id === this.view.editor?.id);
      const newlyConnected = !this.view.accounts.length && accounts.length === 1 && accounts[0]!.status === "READY" && this.view.editor?.type === "cloud" && !this.view.editor.accountId ? { ...this.view.editor, accountId: accounts[0]!.id } : this.view.editor;
      this.updateView({ items, archived, accounts, roots, subscriptions: subscriptions.items, legacy: legacy.items, organizePaused: pause.paused, editor: newlyConnected && edited ? { ...newlyConnected, archived: !!edited.deletedAt } : newlyConnected, error: this.queryError && this.view.error === this.queryError ? null : this.view.error }); this.queryError = null;
      if (edited?.deletedAt && this.view.picker) this.closePicker();
      const configuredPreview = this.view.preview, configuredSource = allItems.find((item) => item.id === configuredPreview?.sourceId);
      if (configuredPreview && configuredPreview.state !== "APPLIED" && configuredSource && (configuredSource.deletedAt || (configuredSource.lifecycleRevision ?? 0) !== (configuredPreview.lifecycleRevision ?? 0) || configuredSource.version !== configuredPreview.version || configuredSource.draftRevision !== configuredPreview.draftRevision)) this.updateView({ preview: { ...configuredPreview, state: "EXPIRED" } });
      const execution = this.view.executionPreview, executionSource = allItems.find((item) => item.id === execution?.sourceId);
      if (execution && execution.state !== "APPLIED" && executionSource && (executionSource.deletedAt || (executionSource.lifecycleRevision ?? 0) !== (execution.lifecycleRevision ?? 0) || executionSource.version !== execution.sourceVersion || executionSource.paused || executionSource.reviewRequired)) this.updateView({ executionPreview: { ...execution, state: "EXPIRED" } });
      const previewId = this.view.preview?.id;
      if (previewId && this.view.preview?.state === "BUILDING") { const preview = await this.client.getSourceRulePreview(previewId); if (!this.stopped && request === this.request && this.view.preview?.id === previewId) this.updateView({ preview }); }
      const executionId = this.view.executionPreview?.id;
      if (executionId && this.view.executionPreview?.state === "BUILDING") { const executionPreview = await this.client.getSourceExecutionPreview(executionId); if (!this.stopped && request === this.request && this.view.executionPreview?.id === executionId) this.updateView({ executionPreview }); }
    } catch (error) { if (!this.stopped && request === this.request) { this.queryError = errorText(error); this.updateView({ error: this.queryError }); } }
    finally { if (!this.stopped && request === this.request) this.updateView({ loading: false }); }
  }
  newSource() {
    if (this.view.pending || !this.draftBinding) return;
    ++this.editorEpoch; ++this.navigation; this.editorRow = null; this.saveIntent = undefined; this.previewIntent = undefined;
    this.updateView({ editor: emptyEditor(this.view.accounts.find((account) => account.status === "READY")?.id), dirty: false, preview: null, picker: false, error: null, notice: null });
  }
  async openSource(id: string) {
    if (this.view.pending || !this.draftBinding) return;
    const epoch = ++this.editorEpoch; ++this.navigation;
    try {
      let row = await this.client.getSourceRule(id); if (epoch !== this.editorEpoch || this.stopped) return;
      if (!row) {
        const local = await this.client.resolveSourceLegacy({ kind: "local-source", id }), managed = local?.sourceId ? null : await this.client.resolveSourceLegacy({ kind: "managed-binding", id });
        const sourceId = local?.sourceId ?? managed?.sourceId;
        if (sourceId) row = await this.client.getSourceRule(sourceId);
        else { this.updateView({ legacyNotice: "此旧入口无法唯一定位来源，请在列表核对配置与下载历史。" }); return; }
      }
      if (epoch !== this.editorEpoch || this.stopped) return;
      if (!row) throw new Error("来源已不存在，请刷新来源列表");
      this.editorRow = row; this.saveIntent = undefined; this.previewIntent = undefined;
      this.updateView({ editor: fromSource(row), preview: null, dirty: false, picker: false, error: null, notice: null });
      if (!row.deletedAt && row.draft.type === "cloud") {
        try { const entry = await this.client.statRemote(row.draft.accountId, row.draft.remoteRef); if (!this.stopped && epoch === this.editorEpoch && this.view.editor?.remoteRef === entry.ref) this.updateView({ editor: { ...this.view.editor, remoteName: entry.name, remoteType: entry.type } }); }
        catch { if (!this.stopped && epoch === this.editorEpoch) this.updateView({ notice: "原远端范围尚不可用，请检查账号连接或重新选择范围；已保存的配置仍然保留。" }); }
      }
    } catch (error) { if (!this.stopped && epoch === this.editorEpoch) this.updateView({ error: errorText(error) }); }
  }
  closeEditor() { if (this.view.pending) return; ++this.editorEpoch; ++this.navigation; this.editorRow = null; this.updateView({ editor: null, preview: null, picker: false, error: null }); }
  change(patch: Partial<SourceEditor>) {
    const editor = this.view.editor; if (!editor || editor.archived || this.view.pending) return;
    if (patch.type && patch.type !== editor.type && editor.draftRevision) { this.updateView({ error: "已保存来源的类型不能切换，请新建另一类型来源。" }); return; }
    this.previewIntent = undefined;
    this.updateView({ editor: { ...editor, ...patch, ...(patch.organize === false || patch.type && patch.type !== editor.type ? { automatic: false } : {}) }, dirty: true, preview: null, error: null, notice: null });
  }
  changeAccount(accountId: string) { ++this.navigation; this.change({ accountId, remoteRef: "", remoteName: "", remoteType: null, periodic: false }); this.updateView({ picker: false }); }
  private configuration(): SourceConfiguration {
    const editor = this.view.editor; if (!editor) throw new Error("请先选择来源");
    if (editor.archived) throw new Error("来源已删除，请先从已删除来源中恢复");
    if (!editor.name.trim()) throw new Error("请填写来源名称");
    const organization = { targetPath: editor.targetPath, mediaType: editor.mediaType, operation: "COPY", automatic: editor.automatic };
    if (editor.type === "local" && (!editor.sourcePath || !editor.targetPath)) throw new Error("请选择本地输入目录和整理目标目录");
    if (editor.type === "cloud" && (!editor.accountId || !editor.remoteRef || !editor.downloadRootId)) throw new Error("请选择账号、远端范围和本地下载目录");
    if (editor.type === "cloud" && editor.organize && !editor.targetPath) throw new Error("请选择整理目标目录");
    if (editor.type === "cloud" && editor.periodic && editor.remoteType === "file") throw new Error("单个文件不能启用目录周期扫描");
    if (editor.type === "local" && editor.ignoreMode === "custom" && (!editor.ignoredFilePatterns.trim() || editor.ignoredFilePatterns.split("\n").filter((value) => value.trim()).length > 100 || editor.ignoredFilePatterns.split("\n").some((value) => value.trim().length > 256 || /[\r\0]/.test(value)))) throw new Error("本地忽略规则须为 1～100 行，每行最多 256 字符；留空时请选择默认规则或关闭忽略");
    const parsed = sourceConfigurationSchema.safeParse(editor.type === "local" ? { type: "local", name: editor.name, client: editor.client, sourcePath: editor.sourcePath, ignoredFilePatterns: editor.ignoreMode === "default" ? null : editor.ignoreMode === "none" ? [] : editor.ignoredFilePatterns.split("\n").map((value) => value.trim()).filter(Boolean), organization } : { type: "cloud", name: editor.name, accountId: editor.accountId, remoteRef: editor.remoteRef, downloadRootId: editor.downloadRootId, filters: { extensions: editor.extensions.split(/[，,\s]+/).filter(Boolean), names: editor.names.split("\n").filter(Boolean) }, periodic: { enabled: editor.periodic, intervalSeconds: editor.intervalSeconds }, organization: editor.organize ? organization : null });
    if (!parsed.success) throw new Error("来源配置无效，请检查名称、过滤和扫描间隔"); return parsed.data;
  }
  private async mutate<T>(label: string, work: () => Promise<T>): Promise<T | null> {
    if (this.view.pending || this.stopped || !this.draftBinding) return null; this.updateView({ pending: label, error: null, notice: null });
    try { return await work(); } catch (error) { if (!this.stopped) this.updateView({ error: errorText(error) }); return null; }
    finally { if (!this.stopped) this.updateView({ pending: null }); }
  }
  choose(purpose: "source" | "target" | "download") { return this.mutate("native", async () => {
    const editor = this.view.editor; if (!editor) return;
    if (purpose === "download") { const grant = await this.client.chooseDownloadRoot(); if (!this.stopped && this.view.editor?.id === editor.id && grant) this.updateView({ editor: { ...editor, downloadRootId: grant.id }, roots: [...this.view.roots.filter((root) => root.id !== grant.id), grant], dirty: true, preview: null }); }
    else { const path = await this.client.chooseDirectory(purpose); if (!this.stopped && this.view.editor?.id === editor.id && path) this.updateView({ editor: { ...editor, [purpose === "source" ? "sourcePath" : "targetPath"]: path }, dirty: true, preview: null }); }
    await this.refresh();
  }); }
  private async saveDraft() {
    const configuration = this.configuration(), editor = this.view.editor!;
    if (this.editorRow && JSON.stringify(this.editorRow.draft) === JSON.stringify(configuration)) { this.updateView({ dirty: false }); return this.editorRow; }
    const signature = JSON.stringify([editor.id, editor.version, editor.draftRevision, editor.lifecycleRevision, configuration]);
    if (this.saveIntent?.signature !== signature) this.saveIntent = { signature, key: crypto.randomUUID() };
    let row: SourceRule;
    try { row = await this.client.configureSourceRule({ id: editor.id, expectedVersion: editor.version, expectedDraftRevision: editor.draftRevision, ...(editor.lifecycleRevision ? { expectedLifecycleRevision: editor.lifecycleRevision } : {}), requestKey: this.saveIntent.key, configuration }); }
    catch (error) {
      const saved = await this.client.getSourceRule(editor.id).catch(() => null);
      if (!saved || saved.deletedAt || (saved.lifecycleRevision ?? 0) !== editor.lifecycleRevision || saved.version !== editor.version || saved.draftRevision !== editor.draftRevision + 1 || JSON.stringify(saved.draft) !== JSON.stringify(configuration)) throw error;
      row = saved;
    }
    this.editorRow = row;
    if (!this.stopped && this.view.editor?.id === editor.id) this.updateView({ editor: { ...editor, version: row.version, draftRevision: row.draftRevision }, dirty: false, notice: "草稿已保存，尚未改变生效配置或启动任务。" });
    await this.refresh(); return row;
  }
  save() { return this.mutate("save", () => this.saveDraft()); }
  preview() { return this.mutate("preview", async () => {
    const epoch = this.editorEpoch, row = await this.saveDraft();
    if (this.stopped || !this.draftBinding || epoch !== this.editorEpoch) throw new Error("编辑界面已变化，请重新打开已保存草稿后预览");
    const signature = JSON.stringify([row.id, row.version, row.draftRevision, row.lifecycleRevision ?? 0]);
    if (this.previewIntent?.signature !== signature || ["EXPIRED", "FAILED"].includes(this.view.preview?.state ?? "")) this.previewIntent = { signature, key: crypto.randomUUID() };
    const preview = await this.client.previewSourceRule({ id: row.id, expectedVersion: row.version, expectedDraftRevision: row.draftRevision, ...(row.lifecycleRevision ? { expectedLifecycleRevision: row.lifecycleRevision } : {}), requestKey: this.previewIntent.key });
    if (!this.stopped) this.updateView({ preview, notice: null }); return preview;
  }); }
  confirm(runOnce = false, automaticAccepted = false, historyAccepted = false) { return this.mutate("apply", async () => {
    const preview = this.view.preview; if (!preview || preview.state !== "READY" || this.view.dirty) throw new Error("请等待完整预览或重新预览当前草稿");
    if (preview.configuration.organization?.automatic && (!automaticAccepted || !preview.automaticSample)) throw new Error("请核对首次 COPY 预览并勾选自动整理说明");
    if (preview.download?.historyRestore && !preview.download.historyRestore.confirmed && !historyAccepted) throw new Error("请核对重新登录的账号与目录，并确认沿用原同步历史");
    const automaticConsent = preview.configuration.organization?.automatic ? { previewId: preview.automaticSample!.previewId, accepted: true as const } : undefined;
    let requestKey = this.confirmations.get(preview.id); if (!requestKey) { requestKey = crypto.randomUUID(); this.confirmations.set(preview.id, requestKey); }
    let row: SourceRule;
    try { row = await this.client.applySourceRule({ previewId: preview.id, requestKey, runOnce, ...(automaticConsent ? { automaticConsent } : {}), ...(preview.download?.historyRestore && historyAccepted ? { historyConsent: { accepted: true as const } } : {}) }); }
    catch (error) {
      const [saved, checked] = await Promise.all([this.client.getSourceRule(preview.sourceId).catch(() => null), this.client.getSourceRulePreview(preview.id).catch(() => null)]);
      if (!saved || saved.deletedAt || (saved.lifecycleRevision ?? 0) !== (preview.lifecycleRevision ?? 0) || checked?.state !== "APPLIED" || saved.version !== preview.version + 1 || JSON.stringify(saved.configuration) !== JSON.stringify(preview.configuration)) throw error;
      row = saved;
    }
    this.editorRow = row;
    if (!this.stopped && this.view.editor) this.updateView({ editor: { ...this.view.editor, version: row.version, draftRevision: row.draftRevision }, dirty: false, preview: { ...preview, state: "APPLIED" }, notice: "来源配置已生效。" });
    if (runOnce && !this.stopped) this.updateView({ notice: "来源配置已生效，已提交一次执行；周期扫描保持关闭。" });
    await this.refresh(); return row;
  }); }
  async control(row: SourceRule, operation: "pause" | "resume" | "scan" | "once") {
    if (operation === "once") { await this.previewExecution(row, false); return; }
    if (this.view.busy.includes(row.id) || this.stopped || !this.draftBinding || this.view.pending) return;
    this.updateView({ busy: [...this.view.busy, row.id], error: null, notice: null });
    const signature = JSON.stringify([row.id, row.version, row.lifecycleRevision ?? 0, operation]); let key = this.controls.get(signature); if (!key) { key = crypto.randomUUID(); this.controls.set(signature, key); }
    try {
      await this.client.controlSourceRule({ id: row.id, expectedVersion: row.version, ...(row.lifecycleRevision ? { expectedLifecycleRevision: row.lifecycleRevision } : {}), operation, requestKey: key });
      this.controls.delete(signature); await this.refresh();
      if (!this.stopped) this.updateView({ notice: operation === "scan" ? "已请求立即扫描，已有扫描会合并。" : operation === "pause" ? "已暂停此来源的新工作，共享文件仍可由其他有效来源继续处理。" : "已恢复来源，全局下载与整理暂停设置保持不变。" });
    } catch (error) { if (!this.stopped) this.updateView({ error: errorText(error) }); }
    finally { if (!this.stopped) this.updateView({ busy: this.view.busy.filter((id) => id !== row.id) }); }
  }
  prepareLifecycle(row: SourceRule) {
    if (this.stopped || this.view.pending || this.view.busy.includes(row.id)) return false;
    if (this.view.editor?.id === row.id && this.view.dirty) { this.updateView({ error: "请先保存草稿或取消当前编辑，再删除或恢复此来源" }); return false; }
    this.updateView({ error: null }); return true;
  }
  lifecycle(row: SourceRule, operation: "remove" | "restore") { return this.mutate(operation, async () => {
    const revision = row.lifecycleRevision ?? 0, signature = JSON.stringify([row.id, row.version, row.draftRevision, revision, operation]);
    let key = this.lifecycleIntents.get(signature); if (!key) { key = crypto.randomUUID(); this.lifecycleIntents.set(signature, key); }
    const input = { id: row.id, expectedVersion: row.version, expectedDraftRevision: row.draftRevision, expectedLifecycleRevision: revision, requestKey: key };
    let saved: SourceRule;
    try { saved = await (operation === "remove" ? this.client.removeSourceRule(input) : this.client.restoreSourceRule(input)); }
    catch (error) {
      const current = await this.client.getSourceRule(row.id).catch(() => null);
      if (!current || !!current.deletedAt !== (operation === "remove") || current.lifecycleRevision !== revision + 1 || current.version !== row.version || current.draftRevision !== row.draftRevision) throw error;
      saved = current;
    }
    if (!!saved.deletedAt !== (operation === "remove")) throw new Error("来源状态已变化，请刷新后重新选择操作");
    if (!this.stopped) {
      ++this.request;
      if (this.view.editor?.id === row.id) { ++this.editorEpoch; ++this.navigation; this.editorRow = null; this.updateView({ editor: null, preview: null, picker: false, dirty: false }); }
      this.updateView({ loading: false, items: [...this.view.items.filter((item) => item.id !== row.id), ...(!saved.deletedAt ? [saved] : [])], archived: [...this.view.archived.filter((item) => item.id !== row.id), ...(saved.deletedAt ? [saved] : [])], executionPreview: this.view.executionPreview?.sourceId === row.id ? null : this.view.executionPreview, notice: operation === "remove" ? "来源已移入已删除来源，文件、历史和原计划保留。" : "来源已恢复，当前保持暂停；核对原目录后可手动恢复工作。" });
    }
    await this.flight?.catch(() => {}); await this.refresh(); return saved;
  }); }
  previewExecution(row: SourceRule, forceRedownload: boolean) { return this.mutate("execution-preview", async () => {
    const signature = JSON.stringify([row.id, row.version, row.lifecycleRevision ?? 0, forceRedownload]);
    if (this.executionIntent?.signature !== signature || ["EXPIRED", "FAILED", "APPLIED"].includes(this.view.executionPreview?.state ?? "")) this.executionIntent = { signature, key: crypto.randomUUID() };
    const executionPreview = await this.client.previewSourceExecution({ id: row.id, expectedVersion: row.version, ...(row.lifecycleRevision ? { expectedLifecycleRevision: row.lifecycleRevision } : {}), requestKey: this.executionIntent.key, forceRedownload });
    if (!this.stopped) this.updateView({ executionPreview }); return executionPreview;
  }); }
  retryExecutionPreview() { const preview = this.view.executionPreview, row = this.view.items.find((item) => item.id === preview?.sourceId); if (row && preview) { this.executionIntent = undefined; return this.previewExecution(row, preview.forceRedownload); } }
  closeExecutionPreview() { if (!this.view.pending) this.updateView({ executionPreview: null }); }
  confirmExecution() { return this.mutate("execute", async () => {
    const preview = this.view.executionPreview; if (preview?.state !== "READY") throw new Error("请先完整预览本次执行范围");
    const signature = `execution:${preview.id}`; let requestKey = this.confirmations.get(signature); if (!requestKey) { requestKey = crypto.randomUUID(); this.confirmations.set(signature, requestKey); }
    let run;
    try { run = await this.client.executeSourcePreview({ previewId: preview.id, requestKey }); }
    catch (error) { const saved = await this.client.getSourceExecutionPreview(preview.id).catch(() => null); if (saved?.state !== "APPLIED" || !saved.run) throw error; run = saved.run; }
    if (!this.stopped) this.updateView({ executionPreview: { ...preview, state: "APPLIED", run }, notice: "本次执行已提交，来源配置与周期扫描策略保持不变。" });
    await this.refresh(); return run;
  }); }
  toggleOrganizePause() { return this.mutate("organize-pause", async () => { const status = await this.client.setOrganizePause({ paused: !this.view.organizePaused, requestKey: crypto.randomUUID() }); if (!this.stopped) this.updateView({ organizePaused: status.paused }); }); }
  async openPicker() {
    const editor = this.view.editor, account = this.view.accounts.find((value) => value.id === editor?.accountId);
    if (!editor || editor.type !== "cloud" || !account?.rootRef || !["READY", "RESELECT_REQUIRED"].includes(account.status)) { this.updateView({ error: "请先连接可用账号，再选择远端范围。" }); return; }
    this.updateView({ picker: true, browserError: null, trail: [{ accountId: account.id, ref: account.rootRef, parentRef: null, name: account.name, type: "directory", size: null, modifiedAt: null, version: null }] }); await this.browse();
  }
  closePicker() { ++this.navigation; this.updateView({ picker: false, browsing: false, browserError: null }); }
  async enter(entry: RemoteEntry) { if (entry.type !== "directory") return; this.updateView({ trail: [...this.view.trail, entry] }); await this.browse(); }
  async goTo(index: number) { this.updateView({ trail: this.view.trail.slice(0, index + 1) }); await this.browse(); }
  async browse(more = false) {
    const parent = this.view.trail.at(-1); if (!parent || !this.view.picker || (more && (this.view.browsing || !this.view.cursor))) return;
    const generation = ++this.navigation, cursor = more ? this.view.cursor : null;
    this.updateView({ browsing: true, browserError: null, ...(!more ? { entries: [], cursor: null, total: null, complete: false } : {}) });
    try { const page = await this.client.listRemote({ accountId: parent.accountId, parentRef: parent.ref, cursor, pageSize: 50, refresh: !more }); if (!this.stopped && generation === this.navigation && this.view.picker) this.updateView({ entries: more ? [...this.view.entries, ...page.items] : page.items, cursor: page.nextCursor, total: page.total, complete: page.complete }); }
    catch (error) { if (!this.stopped && generation === this.navigation) this.updateView({ browserError: errorText(error), complete: false }); }
    finally { if (!this.stopped && generation === this.navigation) this.updateView({ browsing: false }); }
  }
  async selectRemote(entry: RemoteEntry) {
    const generation = ++this.navigation; this.updateView({ browsing: true, browserError: null });
    try { const selected = await this.client.statRemote(entry.accountId, entry.ref); if (!this.stopped && generation === this.navigation && this.view.editor?.accountId === selected.accountId) { this.change({ remoteRef: selected.ref, remoteName: selected.name, remoteType: selected.type, periodic: selected.type === "file" ? false : this.view.editor.periodic }); this.updateView({ picker: false }); } }
    catch (error) { if (!this.stopped && generation === this.navigation) this.updateView({ browserError: errorText(error) }); }
    finally { if (!this.stopped && generation === this.navigation) this.updateView({ browsing: false }); }
  }
  async openLegacy(kind: SourceLegacyReference["kind"], id: string) {
    try {
      const reference = await this.client.resolveSourceLegacy({ kind, id });
      this.updateView({ legacyNotice: reference?.sourceId ? reference.status === "REVIEW_REQUIRED" ? "已定位旧配置，部分归属证据仍需核对；请重新预览后确认。" : "已从旧入口定位到统一来源。" : reference?.status === "HISTORICAL" ? "此项是一次性下载历史，没有自动创建来源或订阅。可在云端下载中查看原任务。" : "旧入口无法唯一定位来源，请核对原目录和历史记录后选择来源；原文件与任务保持保留。" });
      if (reference?.sourceId) await this.openSource(reference.sourceId);
    } catch (error) { this.updateView({ legacyNotice: "旧入口暂时无法定位，请在来源列表核对配置。", error: errorText(error) }); }
  }
  protected dispose() { this.draftBinding = null; this.stopped = true; this.releaseHealth(); ++this.epoch; ++this.request; ++this.navigation; ++this.editorEpoch; clearTimeout(this.timer); this.confirmations.clear(); this.controls.clear(); this.lifecycleIntents.clear(); }
}
