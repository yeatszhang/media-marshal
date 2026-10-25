import {
  createApplication,
  type ApplicationModule,
} from "@yeatz/app-framework/application";
import {
  createIdentifier,
  inject,
  injectable,
  StatefulService,
} from "@yeatz/app-framework/ioc";
import type {
  CloudAccount, CloudAuthorization, CloudCredentialDraft, RemoteEntry, ManagedDownloadRoot, DownloadPreview, DownloadJob, CloudSubscription,
  DesktopApi,
  DesktopRuntime,
  DesktopSource,
  DesktopSettings,
  SourceDraft,
  TaskPage,
  SettingsDraft,
  CoreInput, CoreOutput, IngestionCandidate, Recognition, OrganizePreview,
} from "@media-marshal/contracts";

export const DesktopClient = createIdentifier<DesktopApi>(
  "renderer.desktop-client",
);
function message(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试";
}

@injectable()
export class RuntimeViewModel extends StatefulService<{
  runtime: DesktopRuntime | null;
  error: string | null;
}> {
  protected initState = { runtime: null, error: null };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchers = 0;
  private stopped = false;
  private pollingGeneration = 0;
  private flight?: Promise<void>;
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) {
    super();
  }
  refresh(): Promise<void> {
    return (this.flight ??= this.client
      .getRuntime()
      .then(
        (runtime) => {
          if (!this.stopped) this.setState({ runtime, error: null });
        },
        (error) => {
          if (!this.stopped) this.setState({ error: message(error) });
        },
      )
      .finally(() => {
        this.flight = undefined;
      }));
  }
  watch(): () => void {
    this.watchers++;
    if (this.watchers === 1) {
      const generation = ++this.pollingGeneration;
      const tick = async () => {
        await this.refresh();
        if (
          this.watchers > 0 &&
          !this.stopped &&
          generation === this.pollingGeneration
        )
          this.timer = setTimeout(() => {
            void tick();
          }, 2000);
      };
      void tick();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.watchers--;
      if (!this.watchers) {
        this.pollingGeneration++;
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
      }
    };
  }
  async restart() {
    try {
      await this.client.restartCore();
      await this.refresh();
    } catch (error) {
      this.setState({ error: message(error) });
    }
  }
  protected dispose() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
@injectable()
export class SourcesViewModel extends StatefulService<{
  items: DesktopSource[];
  loading: boolean;
  error: string | null;
}> {
  protected initState = { items: [], loading: false, error: null };
  constructor(@inject(DesktopClient) readonly client: DesktopApi) {
    super();
  }
  async refresh() {
    this.setState({ loading: true, error: null });
    try {
      this.setState({ items: await this.client.listSources() });
    } catch (error) {
      this.setState({ error: message(error) });
    } finally {
      this.setState({ loading: false });
    }
  }
  async save(input: SourceDraft) {
    this.setState({ error: null });
    try {
      const saved = await this.client.saveSource(input);
      await this.refresh();
      return saved;
    } catch (error) {
      this.setState({ error: message(error) });
      throw error;
    }
  }
  async pause(id: string, paused: boolean) {
    try {
      await this.client.pauseSource(id, paused);
      await this.refresh();
    } catch (error) {
      this.setState({ error: message(error) });
    }
  }
}
@injectable()
export class TasksViewModel extends StatefulService<{
  data: TaskPage;
  loading: boolean;
  error: string | null;
  busy: string[];
}> {
  protected initState = {
    data: { items: [], total: 0, page: 1, pageSize: 25 },
    loading: false,
    error: null,
    busy: [],
  };
  private generation = 0;
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) {
    super();
  }
  async refresh(page = 1, review = false) {
    const generation = ++this.generation;
    this.setState({ loading: true, error: null });
    try {
      const data = await this.client.listTasks({
        page,
        pageSize: 25,
        ...(review ? { status: "AWAITING_CONFIRMATION" as const } : {}),
      });
      if (generation === this.generation) this.setState({ data });
    } catch (error) {
      if (generation === this.generation)
        this.setState({ error: message(error) });
    } finally {
      if (generation === this.generation) this.setState({ loading: false });
    }
  }
  async delivery(taskId: string, open = false) {
    if (this.state.busy.includes(taskId)) return;
    this.setState({ busy: [...this.state.busy, taskId], error: null });
    try { if (open) await this.client.openEmby(taskId); else await this.client.retryEmby(taskId); await this.refresh(this.state.data.page); }
    catch (error) { this.setState({ error: message(error) }); }
    finally { this.setState({ busy: this.state.busy.filter((id) => id !== taskId) }); }
  }
  protected dispose() {
    this.generation++;
  }
}
@injectable()
export class SettingsViewModel extends StatefulService<{
  settings: DesktopSettings | null;
  loading: boolean;
  error: string | null;
}> {
  protected initState = { settings: null, loading: false, error: null };
  constructor(@inject(DesktopClient) readonly client: DesktopApi) {
    super();
  }
  async refresh() {
    this.setState({ loading: true, error: null });
    try {
      this.setState({ settings: await this.client.getSettings() });
    } catch (error) {
      this.setState({ error: message(error) });
    } finally {
      this.setState({ loading: false });
    }
  }
  async save(input: SettingsDraft) {
    try {
      await this.client.saveSettings(input);
      await this.refresh();
    } catch (error) {
      this.setState({ error: message(error) });
      throw error;
    }
  }
  async saveKey(kind: "tmdb" | "emby", value: string) {
    try {
      await this.client.saveCredential(kind, value);
      await this.refresh();
    } catch (error) {
      this.setState({ error: message(error) });
      throw error;
    }
  }
  async prepareUpgrade() { try { await this.client.prepareDesktopUpgrade(); } catch (error) { this.setState({ error: message(error) }); } }
  async restoreUpgrade() { try { await this.client.restoreDesktopUpgrade(); } catch (error) { this.setState({ error: message(error) }); } }
  async exportDiagnostics() {
    try { return await this.client.exportDiagnostics(); }
    catch (error) { this.setState({ error: message(error) }); throw error; }
  }
}
@injectable()
export class CloudViewModel extends StatefulService<{
  purpose: "once" | "subscription"; forceRedownload: boolean; extensions: string; names: string; intervalSeconds: number; editingSubscription: { id: string; version: number } | null;
  roots: ManagedDownloadRoot[]; selectingRoot: boolean;
  targetRootId: string | null; downloadPreview: DownloadPreview | null; scanning: boolean; confirming: boolean;
  accounts: CloudAccount[]; loadingAccounts: boolean; accountId: string | null;
  trail: RemoteEntry[]; items: RemoteEntry[]; loading: boolean; total: number | null;
  cursor: string | null; complete: boolean; selection: RemoteEntry | null; previewing: boolean;
  authorization: CloudAuthorization | null; authorizing: boolean; error: string | null;
}> {
  protected initState = { purpose: "once" as const, forceRedownload: false, extensions: "", names: "", intervalSeconds: 900, editingSubscription: null, targetRootId: null, downloadPreview: null, scanning: false, confirming: false, roots: [], selectingRoot: false, accounts: [], loadingAccounts: false, accountId: null, trail: [], items: [], loading: false, total: null, cursor: null, complete: false, selection: null, previewing: false, authorization: null, authorizing: false, error: null };
  private navigation = 0;
  private previewGeneration = 0;
  private accountGeneration = 0;
  private watchers = 0;
  private pollEpoch = 0;
  private requestKey: string | null = null;
  private previewKey: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(@inject(DesktopClient) readonly client: DesktopApi) { super(); }
  watch() {
    if (++this.watchers === 1) {
      const epoch = ++this.pollEpoch;
      void this.refreshAccounts();
      void this.refreshRoots();
      const tick = async () => {
        if (this.previewKey) {
          const key = this.previewKey;
          try {
            const preview = await this.client.getDownloadPreview(key);
            if (!this.stopped && epoch === this.pollEpoch && key === this.previewKey && preview) {
              this.setState({ downloadPreview: preview, scanning: preview.state === "BUILDING", error: preview.failure?.message ?? null });
              if (preview.state !== "BUILDING") this.previewKey = null;
            }
          } catch (error) { if (!this.stopped && epoch === this.pollEpoch) this.setState({ error: message(error) }); }
        }
        if (this.requestKey) {
          const key = this.requestKey;
          try {
            const job = await this.client.getCloudAuthorization(key);
            if (epoch !== this.pollEpoch || key !== this.requestKey) return;
            if (job) {
              this.setState({ authorization: job });
              if (job.state !== "RUNNING") {
                this.requestKey = null;
                this.setState({ authorizing: false, error: job.failure?.message ?? null });
                await this.refreshAccounts();
                if (job.state === "SUCCEEDED") await this.selectAccount(job.accountId);
              }
            }
          } catch (error) { if (epoch === this.pollEpoch) this.setState({ error: message(error) }); }
        }
        if (epoch === this.pollEpoch && this.watchers && !this.stopped) this.timer = setTimeout(() => { void tick(); }, 1000);
      };
      void tick();
    }
    let released = false;
    return () => { if (released) return; released = true; if (!--this.watchers) { ++this.pollEpoch; clearTimeout(this.timer); } };
  }
  async refreshAccounts() {
    const generation = ++this.accountGeneration;
    this.setState({ loadingAccounts: true });
    try { const accounts = await this.client.listCloudAccounts(); if (!this.stopped && generation === this.accountGeneration) this.setState({ accounts }); }
    catch (error) { if (!this.stopped && generation === this.accountGeneration) this.setState({ error: message(error) }); }
    finally { if (!this.stopped && generation === this.accountGeneration) this.setState({ loadingAccounts: false }); }
  }
  async refreshRoots() {
    try { const roots = await this.client.listDownloadRoots(); if (!this.stopped) this.setState({ roots, targetRootId: roots.some((root) => root.id === this.state.targetRootId) ? this.state.targetRootId : roots.find((root) => root.state === "AVAILABLE")?.id ?? null }); }
    catch (error) { if (!this.stopped) this.setState({ error: message(error) }); }
  }
  async chooseRoot() {
    if (this.state.selectingRoot) return;
    this.setState({ selectingRoot: true, error: null });
    try { const chosen = await this.client.chooseDownloadRoot(); if (chosen) this.setState({ targetRootId: chosen.id }); await this.refreshRoots(); }
    catch (error) { if (!this.stopped) this.setState({ error: message(error) }); }
    finally { if (!this.stopped) this.setState({ selectingRoot: false }); }
  }
  setDownloadRoot(id: string) { this.previewKey = null; this.setState({ targetRootId: id, downloadPreview: null, scanning: false }); }
  setDownloadOptions(options: Partial<Pick<CloudViewModel["state"], "purpose" | "forceRedownload" | "extensions" | "names" | "intervalSeconds">>) {
    this.previewKey = null; this.setState({ ...options, downloadPreview: null, scanning: false });
  }
  clearSubscriptionEdit() { this.setState({ editingSubscription: null }); this.setDownloadOptions({ purpose: "once", forceRedownload: false }); }
  async editSubscription(sub: CloudSubscription) {
    await this.refreshAccounts(); await this.selectAccount(sub.accountId); await this.refreshRoots();
    this.setState({ editingSubscription: { id: sub.id, version: sub.configurationVersion }, purpose: "subscription", targetRootId: sub.targetGrantId, forceRedownload: false, extensions: sub.filters.extensions.join(","), names: sub.filters.names.join("\n"), intervalSeconds: sub.intervalSeconds });
    try { const entry = await this.client.statRemote(sub.accountId, sub.remoteRef); await this.preview(entry); }
    catch { this.setState({ error: "原范围已不可用，请在此账号重新选择目录并预览确认。" }); }
  }
  async confirmSubscription(): Promise<string | null> {
    const preview = this.state.downloadPreview, editing = this.state.editingSubscription;
    if (!preview?.complete || preview.state !== "READY" || this.state.confirming || this.state.selection?.type !== "directory") return null;
    this.setState({ confirming: true, error: null });
    try {
      const sub = await this.client.configureCloudSubscription({ previewId: preview.id, intervalSeconds: this.state.intervalSeconds, ...(editing ? { subscriptionId: editing.id, configurationVersion: editing.version } : {}), requestKey: crypto.randomUUID() });
      this.setState({ downloadPreview: { ...preview, state: "CONFIRMED" }, editingSubscription: null }); return sub.id;
    } catch (error) { this.setState({ error: message(error) }); return null; }
    finally { this.setState({ confirming: false }); }
  }
  async scanDownload() {
    const selection = this.state.selection, targetGrantId = this.state.targetRootId;
    if (!selection || !targetGrantId || this.state.scanning) return;
    const requestKey = crypto.randomUUID(); this.previewKey = requestKey; this.setState({ scanning: true, downloadPreview: null, error: null });
    try {
      const preview = await this.client.previewDownload({ accountId: selection.accountId, remoteRef: selection.ref, targetGrantId, requestKey, layout: this.state.purpose === "subscription" ? "drive" : "selection", forceRedownload: this.state.purpose === "once" && this.state.forceRedownload, filters: { extensions: this.state.extensions.split(/[，,\s]+/).filter(Boolean), names: this.state.names.split("\n").filter(Boolean) } });
      if (this.previewKey === requestKey && !this.stopped) this.setState({ downloadPreview: preview, scanning: preview.state === "BUILDING" });
    } catch (error) { if (this.previewKey === requestKey && !this.stopped) { this.setState({ error: message(error), scanning: false }); } }
  }
  async confirmDownload(): Promise<string | null> {
    const preview = this.state.downloadPreview;
    if (!preview?.complete || preview.state !== "READY" || this.state.confirming) return null;
    this.setState({ confirming: true, error: null });
    try {
      const result = await this.client.confirmDownload({ previewId: preview.id, requestKey: crypto.randomUUID() });
      this.setState({ downloadPreview: { ...preview, state: "CONFIRMED" } }); return result.jobId;
    } catch (error) { this.setState({ error: message(error) }); return null; }
    finally { this.setState({ confirming: false }); }
  }
  async authorize(input: CloudCredentialDraft) {
    this.requestKey = input.requestKey;
    this.setState({ authorizing: true, error: null });
    try {
      const job = await this.client.authorizeCloudAccount(input);
      this.setState({ authorization: job });
      if (job.state !== "RUNNING") { this.requestKey = null; this.setState({ authorizing: false, error: job.failure?.message ?? null }); }
      await this.refreshAccounts();
    } catch (error) {
      // 超时只查询持久化作业，页面不重发带凭据的变更动作。
      const job = await this.client.getCloudAuthorization(input.requestKey).catch(() => null);
      this.setState({ authorization: job, authorizing: job?.state === "RUNNING", error: message(error) });
      if (!job || job.state !== "RUNNING") this.requestKey = null;
      throw error;
    }
  }
  async selectAccount(accountId: string) {
    const account = this.state.accounts.find((value) => value.id === accountId);
    if (this.state.editingSubscription && this.state.accountId !== accountId) this.clearSubscriptionEdit();
    ++this.previewGeneration; this.previewKey = null; this.setState({ downloadPreview: null, scanning: false });
    this.setState({ accountId, selection: null, items: [], cursor: null, complete: false, total: null, error: null, previewing: false });
    if (!account?.rootRef || ["AUTH_REQUIRED", "DISCONNECTED", "UNCONFIGURED"].includes(account.status)) { ++this.navigation; this.setState({ trail: [] }); return; }
    const root: RemoteEntry = { accountId, ref: account.rootRef, parentRef: null, name: account.name, type: "directory", size: null, modifiedAt: null, version: null };
    this.setState({ trail: [root] }); await this.browse(false);
  }
  async enter(entry: RemoteEntry) {
    if (entry.type !== "directory") return;
    this.setState({ trail: [...this.state.trail, entry] }); await this.browse(false);
  }
  async goTo(index: number) { this.setState({ trail: this.state.trail.slice(0, index + 1) }); await this.browse(false); }
  async browse(more = false) {
    if (more && (this.state.loading || !this.state.cursor)) return;
    const accountId = this.state.accountId, parent = this.state.trail.at(-1);
    if (!accountId || !parent) return;
    const generation = ++this.navigation, cursor = more ? this.state.cursor : null;
    ++this.previewGeneration; this.previewKey = null; this.setState({ downloadPreview: null, scanning: false });
    this.setState({ loading: true, error: null, selection: null, previewing: false, ...(!more ? { items: [], cursor: null, total: null, complete: false } : {}) });
    try {
      const page = await this.client.listRemote({ accountId, parentRef: parent.ref, cursor, pageSize: 50, refresh: !more });
      if (generation !== this.navigation || this.stopped) return;
      this.setState({ items: more ? [...this.state.items, ...page.items] : page.items, cursor: page.nextCursor, total: page.total, complete: page.complete });
    } catch (error) {
      if (generation === this.navigation && !this.stopped) { this.setState({ error: message(error), complete: false }); await this.refreshAccounts(); }
    } finally { if (generation === this.navigation && !this.stopped) this.setState({ loading: false }); }
  }
  async preview(entry: RemoteEntry) {
    const generation = ++this.previewGeneration;
    this.previewKey = null; this.setState({ previewing: true, selection: null, error: null, downloadPreview: null, scanning: false });
    try { const selection = await this.client.statRemote(entry.accountId, entry.ref); if (generation === this.previewGeneration && !this.stopped) this.setState({ selection }); }
    catch (error) { if (generation === this.previewGeneration && !this.stopped) this.setState({ error: message(error) }); }
    finally { if (generation === this.previewGeneration && !this.stopped) this.setState({ previewing: false }); }
  }
  async disconnect(accountId: string) {
    try {
      await this.client.disconnectCloudAccount(accountId);
      if (this.state.accountId === accountId) { ++this.navigation; ++this.previewGeneration; this.setState({ trail: [], items: [], selection: null, previewing: false, cursor: null, total: null, complete: false, loading: false }); }
      await this.refreshAccounts();
    } catch (error) { this.setState({ error: message(error) }); }
  }
  async restore() {
    try { await this.client.restoreCloudAccounts(); await this.refreshAccounts(); if (this.state.accountId) await this.selectAccount(this.state.accountId); }
    catch (error) { this.setState({ error: message(error) }); }
  }
  protected dispose() { this.stopped = true; ++this.pollEpoch; ++this.navigation; ++this.previewGeneration; clearTimeout(this.timer); }
}
@injectable()
export class DownloadsViewModel extends StatefulService<{ paused: boolean; pausing: boolean; changingPause: boolean; items: DownloadJob[]; page: number; total: number; loading: boolean; error: string | null; busy: string[] }> {
  protected initState = { paused: false, pausing: false, changingPause: false, items: [], page: 1, total: 0, loading: false, error: null, busy: [] };
  private watchers = 0; private epoch = 0; private request = 0; private timer?: ReturnType<typeof setTimeout>; private stopped = false;
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) { super(); }
  watch() {
    if (++this.watchers === 1) { const epoch = ++this.epoch; const tick = async () => { await this.refresh(this.state.page); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void tick(); }, 1000); }; void tick(); }
    let released = false; return () => { if (released) return; released = true; if (!--this.watchers) { this.epoch++; clearTimeout(this.timer); } };
  }
  async refresh(page = this.state.page) {
    const request = ++this.request; this.setState({ page, loading: true });
    try { const [data, pause] = await Promise.all([this.client.listDownloads({ page, pageSize: 25 }), this.client.getCloudDownloadPause()]); if (!this.stopped && request === this.request) this.setState({ ...data, ...pause, error: null }); }
    catch (error) { if (!this.stopped && request === this.request) this.setState({ error: message(error) }); }
    finally { if (!this.stopped && request === this.request) this.setState({ loading: false }); }
  }
  async control(jobId: string, operation: "pause" | "resume" | "cancel" | "retry") {
    if (this.state.busy.includes(jobId)) return;
    this.setState({ busy: [...this.state.busy, jobId], error: null });
    try { await this.client.controlDownload({ jobId, operation, requestKey: crypto.randomUUID() }); await this.refresh(); }
    catch (error) { this.setState({ error: message(error) }); }
    finally { this.setState({ busy: this.state.busy.filter((id) => id !== jobId) }); }
  }
  async togglePause() {
    if (this.state.changingPause || this.state.pausing) return;
    this.setState({ changingPause: true, error: null });
    try { await this.client.setCloudDownloadPause({ paused: !this.state.paused, requestKey: crypto.randomUUID() }); await this.refresh(); }
    catch (error) { this.setState({ error: message(error) }); }
    finally { this.setState({ changingPause: false }); }
  }
  async open(jobId: string) { try { await this.client.openDownloadDirectory(jobId); } catch (error) { this.setState({ error: message(error) }); } }
  protected dispose() { this.stopped = true; ++this.epoch; ++this.request; clearTimeout(this.timer); }
}
@injectable()
export class SubscriptionsViewModel extends StatefulService<{ items: CloudSubscription[]; total: number; page: number; error: string | null; busy: string[] }> {
  protected initState = { items: [], total: 0, page: 1, error: null, busy: [] };
  private watchers = 0; private epoch = 0; private request = 0; private timer?: ReturnType<typeof setTimeout>; private stopped = false;
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) { super(); }
  watch() {
    if (++this.watchers === 1) { const epoch = ++this.epoch; const tick = async () => { await this.refresh(); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void tick(); }, 1000); }; void tick(); }
    let released = false; return () => { if (released) return; released = true; if (!--this.watchers) { this.epoch++; clearTimeout(this.timer); } };
  }
  async refresh(page = this.state.page) {
    const request = ++this.request; this.setState({ page });
    try { const result = await this.client.listCloudSubscriptions({ page, pageSize: 25 }); if (!this.stopped && request === this.request) this.setState({ ...result, error: null }); }
    catch (error) { if (!this.stopped && request === this.request) this.setState({ error: message(error) }); }
  }
  async control(subscriptionId: string, operation: "scan" | "pause" | "resume" | "cancel") {
    if (this.state.busy.includes(subscriptionId)) return;
    this.setState({ busy: [...this.state.busy, subscriptionId], error: null });
    try { await this.client.controlCloudSubscription({ subscriptionId, operation, requestKey: crypto.randomUUID() }); await this.refresh(); }
    catch (error) { this.setState({ error: message(error) }); }
    finally { this.setState({ busy: this.state.busy.filter((id) => id !== subscriptionId) }); }
  }
  protected dispose() { this.stopped = true; ++this.epoch; ++this.request; clearTimeout(this.timer); }
}
@injectable()
export class IngestionViewModel extends StatefulService<{ items: IngestionCandidate[]; total: number; page: number; sources: DesktopSource[]; task: Recognition | null; preview: OrganizePreview | null; error: string | null; busy: boolean }> {
  protected initState = { items: [], total: 0, page: 1, sources: [], task: null, preview: null, error: null, busy: false };
  private stopped = false; private watchers = 0; private epoch = 0; private request = 0; private selection = 0; private timer?: ReturnType<typeof setTimeout>;
  private readonly confirmations = new Map<string, string>();
  constructor(@inject(DesktopClient) readonly client: DesktopApi) { super(); }
  watch() { if (++this.watchers === 1) { const epoch = ++this.epoch; const poll = async () => { await this.refresh(); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void poll(); }, 2000); }; void poll(); } let released = false; return () => { if (released) return; released = true; if (!--this.watchers) { this.epoch++; clearTimeout(this.timer); } }; }
  async refresh(page = this.state.page) {
    const request = ++this.request, selected = this.selection; this.setState({ page });
    try { const [result, sources, task] = await Promise.all([this.client.listIngestionCandidates({ page }), this.client.listSources(), this.state.task ? this.client.getIngestionTask(this.state.task.taskId) : Promise.resolve(null)]); if (!this.stopped && request === this.request) this.setState({ ...result, sources, ...(selected === this.selection ? { task } : {}) }); }
    catch (error) { if (!this.stopped && request === this.request) this.setState({ error: message(error) }); }
  }
  private async action(work: () => Promise<void>) { if (this.state.busy || this.stopped) return; this.setState({ busy: true, error: null }); try { await work(); } catch (error) { if (!this.stopped) this.setState({ error: message(error) }); } finally { if (!this.stopped) this.setState({ busy: false }); } }
  scan(sourceId: string) { return this.action(async () => { await this.client.scanIngestion(sourceId); await this.refresh(); }); }
  recognize(candidateId: string) { return this.action(async () => { const result = await this.client.recognizeIngestion({ candidateId, requestKey: crypto.randomUUID() }); await this.select(result.taskId); await this.refresh(); }); }
  async select(taskId: string) { const selection = ++this.selection; this.setState({ preview: null }); try { const task = await this.client.getIngestionTask(taskId); if (!this.stopped && selection === this.selection) this.setState({ task }); } catch (error) { if (!this.stopped && selection === this.selection) this.setState({ error: message(error) }); } }
  clearPreview() { this.selection++; this.setState({ preview: null }); }
  preview(input: Omit<CoreInput<"ingestion.preview">, "requestKey" | "taskId">) { return this.action(async () => { if (!this.state.task) return; const selection = this.selection, result = await this.client.previewOrganize({ ...input, taskId: this.state.task.taskId, requestKey: crypto.randomUUID() }); if (!this.stopped && selection === this.selection) this.setState({ preview: result }); }); }
  confirm() { return this.action(async () => { const preview = this.state.preview; if (!preview) return; let requestKey = this.confirmations.get(preview.id); if (!requestKey) { requestKey = crypto.randomUUID(); this.confirmations.set(preview.id, requestKey); } await this.client.confirmOrganize({ previewId: preview.id, requestKey }); this.setState({ preview: null }); await this.refresh(); }); }
  retry(taskId: string) { return this.action(async () => { await this.client.retryOrganize(taskId); await this.refresh(); }); }
  protected dispose() { this.stopped = true; this.request++; this.selection++; this.epoch++; clearTimeout(this.timer); this.confirmations.clear(); }
}
@injectable()
export class LibraryViewModel extends StatefulService<{ targets: CoreOutput<"media.libraries">; server: CoreOutput<"emby.libraries"> | null; configuration: CoreOutput<"emby.configuration">; roots: ManagedDownloadRoot[]; error: string | null; busy: boolean }> {
  protected initState = { targets: [], server: null, configuration: null, roots: [], error: null, busy: false };
  private stopped = false; private generation = 0;
  constructor(@inject(DesktopClient) readonly client: DesktopApi) { super(); }
  async refresh() { const generation = ++this.generation; try { const [targets, configuration, roots] = await Promise.all([this.client.listMediaLibraries(), this.client.getEmbyConfiguration(), this.client.listDownloadRoots()]); if (!this.stopped && generation === this.generation) this.setState({ targets, configuration, roots }); } catch (error) { if (!this.stopped && generation === this.generation) this.setState({ error: message(error) }); } }
  async action(work: () => Promise<void>) { if (this.state.busy || this.stopped) return; this.setState({ busy: true, error: null }); try { await work(); await this.refresh(); } catch (error) { if (!this.stopped) this.setState({ error: message(error) }); } finally { if (!this.stopped) this.setState({ busy: false }); } }
  choose(type: "MOVIE" | "TV_SHOW") { return this.action(async () => { const targets = await this.client.chooseMediaTarget(type); if (!this.stopped) this.setState({ targets, server: null }); }); }
  readServer() { return this.action(async () => { const server = await this.client.listEmbyLibraries(); if (!this.stopped) this.setState({ server }); }); }
  connect(input: CoreInput<"emby.connect">) { return this.action(async () => { const configuration = await this.client.connectEmby(input); if (!this.stopped) this.setState({ configuration }); }); }
  managed(downloadRootId: string) { return this.action(async () => { const target = this.state.targets.find((row) => row.mediaType === "MOVIE") ?? this.state.targets[0]; if (!target) throw new Error("请先选择媒体目标目录"); await this.client.configureManagedIngestion({ downloadRootId, name: "受管下载", targetPath: target.path, mediaType: "AUTO" }); }); }
  protected dispose() { this.stopped = true; this.generation++; }
}
export function createRendererApplication(client: DesktopApi) {
  const connection: ApplicationModule = {
    id: "renderer.desktop-client",
    register(bind) {
      bind(DesktopClient).toConstantValue(client);
    },
  };
  const modules: ApplicationModule[] = [
    { id: "renderer.ingestion", dependencies: [connection.id], register(bind) { bind(IngestionViewModel).toSelf().inSingletonScope(); bind(LibraryViewModel).toSelf().inSingletonScope(); } },
    { id: "renderer.subscriptions", dependencies: [connection.id], register(bind) { bind(SubscriptionsViewModel).toSelf().inSingletonScope(); } },
    { id: "renderer.downloads", dependencies: [connection.id], register(bind) { bind(DownloadsViewModel).toSelf().inSingletonScope(); } },
    { id: "renderer.cloud", dependencies: [connection.id], register(bind) { bind(CloudViewModel).toSelf().inSingletonScope(); } },
    {
      id: "renderer.runtime",
      dependencies: [connection.id],
      register(bind) {
        bind(RuntimeViewModel).toSelf().inSingletonScope();
      },
    },
    {
      id: "renderer.sources",
      dependencies: [connection.id],
      register(bind) {
        bind(SourcesViewModel).toSelf().inSingletonScope();
      },
    },
    {
      id: "renderer.tasks",
      dependencies: [connection.id],
      register(bind) {
        bind(TasksViewModel).toSelf().inSingletonScope();
      },
    },
    {
      id: "renderer.settings",
      dependencies: [connection.id],
      register(bind) {
        bind(SettingsViewModel).toSelf().inSingletonScope();
      },
    },
  ];
  return createApplication({ modules: [connection, ...modules] });
}
