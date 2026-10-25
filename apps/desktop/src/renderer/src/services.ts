import {
  createApplication,
  type ApplicationModule,
} from "@yeatz/app-framework/application";
import {
  inject,
  injectable,
  StatefulService,
} from "@yeatz/app-framework/ioc";
import type {
  DownloadJob, SourceRule,
  DesktopApi,
  DesktopRuntime,
  DesktopSettings,
  TaskPage, PageInput,
  SettingsDraft,
  CoreInput, CoreOutput, IngestionCandidate, Recognition, OrganizePreview,
} from "@media-marshal/contracts";

import { DesktopClient } from "./desktop-client";
export { DesktopClient } from "./desktop-client";
import { SourceRulesViewModel } from "./source-rules-model";
import { OrganizeBatchesViewModel } from "./organize-batches-model";
import { SeasonsViewModel } from "./seasons-model";
import { DirectoriesViewModel } from "./directories-model";
import { RecognitionEditsViewModel } from "./recognition-edits-model";
import { ContentReviewsViewModel } from "./content-reviews-model";
import { CloudAccountsViewModel } from "./cloud-accounts-model";
import { CorrectionBatchDraftModel, CorrectionBatchViewModel, CorrectionBatchJobsModel } from "./correction-batches-model";
import { CorrectionViewModel, CorrectionJobsViewModel } from "./corrections-model";
function message(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试";
}

@injectable()
export class RuntimeViewModel extends StatefulService<{
  runtime: DesktopRuntime | null;
  error: string | null;
  restarting: boolean;
}> {
  protected initState = { runtime: null, error: null, restarting: false };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchers = 0;
  private stopped = false;
  private pollingGeneration = 0;
  private flight?: Promise<void>;
  private requestGeneration = 0;
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) {
    super();
  }
  refresh(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!force && this.flight) return this.flight;
    const generation = ++this.requestGeneration;
    const flight = this.client
      .getRuntime()
      .then(
        (runtime) => {
          if (!this.stopped && generation === this.requestGeneration) this.setState({ runtime, error: null });
        },
        (error) => {
          if (!this.stopped && generation === this.requestGeneration) this.setState({ error: message(error) });
        },
      )
      .finally(() => {
        if (this.flight === flight) this.flight = undefined;
      });
    return this.flight = flight;
  }
  watch(): () => void {
    if (this.stopped) return () => {};
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
    if (this.stopped || this.state.restarting) return;
    this.setState({ restarting: true, error: null });
    try {
      await this.client.restartCore();
      await this.refresh(true);
    } catch (error) {
      if (!this.stopped) this.setState({ error: message(error) });
    } finally { if (!this.stopped) this.setState({ restarting: false }); }
  }
  protected dispose() {
    this.stopped = true;
    this.requestGeneration++;
    if (this.timer) clearTimeout(this.timer);
  }
}
@injectable()
export class TasksViewModel extends StatefulService<{
  data: TaskPage;
  loading: boolean;
  error: string | null;
  queryError: string | null;
  filter: PageInput["status"] | "";
  busy: string[];
}> {
  protected initState = {
    data: { items: [], total: 0, page: 1, pageSize: 25 },
    loading: false,
    error: null,
    queryError: null,
    filter: "" as PageInput["status"] | "",
    busy: [],
  };
  private generation = 0;
  private loaded = false;
  private stopped = false;
  private watchers = 0;
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private query: { page: number; status: PageInput["status"] | "" } = { page: 1, status: "" };
  private flight?: { key: string; promise: Promise<void> };
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) {
    super();
  }
  refresh(page = this.query.page, status = this.query.status, force = true): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.query = { page, status };
    const key = JSON.stringify(this.query);
    if (!force && this.flight?.key === key) return this.flight.promise;
    const generation = ++this.generation;
    this.setState({ loading: force || !this.loaded, filter: status });
    const promise = this.client.listTasks({
        page,
        pageSize: 25,
        ...(status ? { status } : {}),
      }).then((data) => { if (!this.stopped && generation === this.generation) { this.loaded = true; this.setState({ data, queryError: null }); } },
        (error) => { if (!this.stopped && generation === this.generation) this.setState({ queryError: message(error) }); })
      .finally(() => { if (!this.stopped && generation === this.generation) this.setState({ loading: false }); if (this.flight?.promise === promise) this.flight = undefined; });
    this.flight = { key, promise }; return promise;
  }
  watch(status?: PageInput["status"]) {
    if (this.stopped) return () => {};
    if (status) this.query = { page: 1, status };
    if (++this.watchers === 1) {
      const epoch = ++this.epoch;
      const tick = async () => { await this.refresh(this.query.page, this.query.status, false); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void tick(); }, 2000); };
      void tick();
    }
    let released = false;
    return () => { if (released) return; released = true; if (!--this.watchers) { this.epoch++; clearTimeout(this.timer); } };
  }
  async delivery(taskId: string, open = false) {
    if (this.stopped || this.state.busy.includes(taskId)) return;
    this.setState({ busy: [...this.state.busy, taskId], error: null });
    try { if (open) await this.client.openEmby(taskId); else await this.client.retryEmby(taskId); await this.refresh(); }
    catch (error) { if (!this.stopped) this.setState({ error: message(error) }); }
    finally { if (!this.stopped) this.setState({ busy: this.state.busy.filter((id) => id !== taskId) }); }
  }
  protected dispose() {
    this.generation++;
    this.stopped = true; this.epoch++; clearTimeout(this.timer);
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
export class IngestionViewModel extends StatefulService<{ items: IngestionCandidate[]; total: number; page: number; sources: SourceRule[]; task: Recognition | null; preview: OrganizePreview | null; error: string | null; busy: boolean }> {
  protected initState = { items: [], total: 0, page: 1, sources: [], task: null, preview: null, error: null, busy: false };
  private stopped = false; private watchers = 0; private epoch = 0; private request = 0; private selection = 0; private timer?: ReturnType<typeof setTimeout>;
  private readonly confirmations = new Map<string, string>();
  constructor(@inject(DesktopClient) readonly client: DesktopApi) { super(); }
  watch() { if (++this.watchers === 1) { const epoch = ++this.epoch; const poll = async () => { await this.refresh(); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void poll(); }, 2000); }; void poll(); } let released = false; return () => { if (released) return; released = true; if (!--this.watchers) { this.epoch++; clearTimeout(this.timer); } }; }
  async refresh(page = this.state.page) {
    const request = ++this.request, selected = this.selection; this.setState({ page });
    try { const [result, sources, task] = await Promise.all([this.client.listIngestionCandidates({ page }), this.client.listSourceRules(), this.state.task ? this.client.getIngestionTask(this.state.task.taskId) : Promise.resolve(null)]); if (!this.stopped && request === this.request) this.setState({ ...result, sources, ...(selected === this.selection ? { task } : {}) }); }
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
export class LibraryViewModel extends StatefulService<{ targets: CoreOutput<"media.libraries">; server: CoreOutput<"emby.libraries"> | null; configuration: CoreOutput<"emby.configuration">; error: string | null; queryError: string | null; busy: boolean }> {
  protected initState = { targets: [], server: null, configuration: null, error: null, queryError: null, busy: false };
  private stopped = false; private generation = 0; private watchers = 0; private epoch = 0; private timer?: ReturnType<typeof setTimeout>; private flight?: Promise<void>;
  constructor(@inject(DesktopClient) readonly client: DesktopApi) { super(); }
  watch() {
    if (this.stopped) return () => {};
    if (++this.watchers === 1) { const epoch = ++this.epoch; const poll = async () => { await this.refresh(); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void poll(); }, 2000); }; void poll(); }
    let released = false; return () => { if (released) return; released = true; if (!--this.watchers) { this.epoch++; clearTimeout(this.timer); } };
  }
  refresh(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!force && this.flight) return this.flight;
    const generation = ++this.generation;
    const task = (async () => {
      try { const [targets, configuration] = await Promise.all([this.client.listMediaLibraries(), this.client.getEmbyConfiguration()]); if (!this.stopped && generation === this.generation) this.setState({ targets, configuration, queryError: null }); }
      catch (error) { if (!this.stopped && generation === this.generation) this.setState({ queryError: message(error) }); }
    })().finally(() => { if (this.flight === task) this.flight = undefined; });
    return this.flight = task;
  }
  async action(work: () => Promise<void>) { if (this.state.busy || this.stopped) return; this.setState({ busy: true, error: null }); try { await work(); await this.refresh(true); } catch (error) { if (!this.stopped) this.setState({ error: message(error) }); } finally { if (!this.stopped) this.setState({ busy: false }); } }
  choose(type: "MOVIE" | "TV_SHOW") { return this.action(async () => { const targets = await this.client.chooseMediaTarget(type); if (!this.stopped) this.setState({ targets, server: null }); }); }
  readServer() { return this.action(async () => { const server = await this.client.listEmbyLibraries(); if (!this.stopped) this.setState({ server }); }); }
  connect(input: CoreInput<"emby.connect">) { return this.action(async () => { const configuration = await this.client.connectEmby(input); if (!this.stopped) this.setState({ configuration }); }); }
  protected dispose() { this.stopped = true; this.generation++; this.epoch++; clearTimeout(this.timer); }
}
export function createRendererApplication(client: DesktopApi) {
  const connection: ApplicationModule = {
    id: "renderer.desktop-client",
    register(bind) {
      bind(DesktopClient).toConstantValue(client);
    },
  };
  const modules: ApplicationModule[] = [
    { id: "renderer.ingestion", dependencies: [connection.id], register(bind) { bind(IngestionViewModel).toSelf().inSingletonScope(); bind(LibraryViewModel).toSelf().inSingletonScope(); bind(ContentReviewsViewModel).toSelf().inSingletonScope(); bind(RecognitionEditsViewModel).toSelf().inSingletonScope(); bind(DirectoriesViewModel).toSelf().inSingletonScope(); bind(SeasonsViewModel).toSelf().inSingletonScope(); bind(OrganizeBatchesViewModel).toSelf().inSingletonScope(); } },
    { id: "renderer.corrections", dependencies: [connection.id], register(bind) { bind(CorrectionViewModel).toSelf().inSingletonScope(); bind(CorrectionJobsViewModel).toSelf().inSingletonScope(); bind(CorrectionBatchDraftModel).toSelf().inSingletonScope(); bind(CorrectionBatchViewModel).toSelf().inSingletonScope(); bind(CorrectionBatchJobsModel).toSelf().inSingletonScope(); } },
    { id: "renderer.downloads", dependencies: [connection.id], register(bind) { bind(DownloadsViewModel).toSelf().inSingletonScope(); } },
    { id: "renderer.cloud", dependencies: [connection.id], register(bind) { bind(CloudAccountsViewModel).toSelf().inSingletonScope(); } },
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
        bind(SourceRulesViewModel).toSelf().inSingletonScope();
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
