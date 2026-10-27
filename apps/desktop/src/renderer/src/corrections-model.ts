import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { CoreInput, CoreOutput, CorrectionPreparation, CorrectionPreview, DesktopApi } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";
export const preparing = (value: CorrectionPreparation | null) => !!value && ["PENDING", "RUNNING", "CANCELING"].includes(value.state);
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
@injectable()
export class CorrectionViewModel extends StatefulService<{ task: CoreOutput<"corrections.task"> | null; preview: CorrectionPreview | null; preparation: CorrectionPreparation | null; detail: CoreOutput<"corrections.get"> | null; loading: boolean; busy: boolean; paused: boolean; error: string | null; queryError: string | null }> {
  protected initState = { task: null, preview: null, preparation: null, detail: null, loading: true, busy: false, paused: false, error: null, queryError: null };
  private taskId?: string; private scope = 0; private request = 0; private mutation = 0; private hidden = false; private stopped = false; private timer?: ReturnType<typeof setTimeout>;
  private previewRequest?: { signature: string; key: string }; private confirmation?: { id: string; key: string };
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) { super(); }
  watch(taskId: string) {
    if (this.stopped) return () => {};
    const scope = ++this.scope; clearTimeout(this.timer);
    this.hidden = false; this.setState({ ...this.initState }); this.taskId = taskId;
    const tick = async () => { await this.refresh(); if (!this.stopped && scope === this.scope) this.timer = setTimeout(() => { void tick(); }, 1500); }; void tick();
    return () => { if (scope === this.scope) { ++this.scope; ++this.request; clearTimeout(this.timer); } };
  }
  async refresh(allowBusy = false) {
    if (this.stopped || !this.taskId || this.state.busy && !allowBusy) return; const request = ++this.request, scope = this.scope, mutation = this.mutation, taskId = this.taskId;
    try {
      const [task, pause] = await Promise.all([this.client.getCorrectionTask(taskId), this.client.getOrganizePause()]);
      const preparation = this.hidden && !preparing(task.preparation) ? null : task.preparation;
      const operationId = task.active?.id ?? preparation?.operationId ?? task.latestOperation?.id;
      const [preview, detail] = await Promise.all([!this.hidden && preparation?.state === "READY" && preparation.previewId ? this.client.getCorrectionPreview(preparation.previewId) : null, operationId ? this.client.getCorrection(operationId) : null]);
      if (!this.stopped && request === this.request && scope === this.scope && mutation === this.mutation) this.setState({ task, preparation, preview, detail, paused: pause.paused, loading: false, queryError: null });
    } catch (error) { if (!this.stopped && request === this.request && scope === this.scope && mutation === this.mutation) this.setState({ queryError: message(error, "无法读取此任务的修正记录，请刷新后重试"), loading: false }); }
  }
  invalidate() { this.hidden = true; ++this.mutation; this.setState({ preview: null, preparation: preparing(this.state.preparation) ? this.state.preparation : null, error: null }); }
  private async action(work: () => Promise<void>) {
    if (this.stopped || this.state.busy) return; const scope = this.scope; ++this.mutation; this.setState({ busy: true, error: null });
    try { await work(); if (!this.stopped && scope === this.scope) await this.refresh(true); }
    catch (error) { if (!this.stopped && scope === this.scope) this.setState({ error: message(error, "修正请求未能返回，请刷新查询原核验或作业后再重试") }); }
    finally { if (!this.stopped && scope === this.scope) this.setState({ busy: false }); }
  }
  preview(input: Omit<CoreInput<"corrections.preview">, "taskId" | "requestKey">) {
    const taskId = this.taskId; if (!taskId) return Promise.resolve(); const signature = JSON.stringify({ taskId, ...input });
    if (this.previewRequest?.signature !== signature) this.previewRequest = { signature, key: crypto.randomUUID() }; const requestKey = this.previewRequest.key;
    return this.action(async () => { this.hidden = false; this.setState({ preview: null, preparation: null }); const scope = this.scope; const preparation = await this.client.previewCorrection({ ...input, taskId, requestKey }); if (this.previewRequest?.key === requestKey) this.previewRequest = undefined; if (!this.stopped && scope === this.scope) this.setState({ preparation, preview: null }); });
  }
  confirm() {
    const preview = this.state.preview; if (!preview || preview.state !== "READY") return Promise.resolve(); if (this.confirmation?.id !== preview.id) this.confirmation = { id: preview.id, key: crypto.randomUUID() }; const requestKey = this.confirmation.key;
    return this.action(async () => { const scope = this.scope, preparation = await this.client.confirmCorrection({ previewId: preview.id, requestKey, filesComplete: true }); if (!this.stopped && scope === this.scope) { this.hidden = false; this.setState({ preparation }); } });
  }
  cancel() { const id = this.state.preparation?.id; return id ? this.action(async () => { await this.client.cancelCorrectionPreparation(id); }) : Promise.resolve(); }
  retry() { const id = this.state.detail?.operation.id; return id ? this.action(async () => { await this.client.retryCorrection(id); }) : Promise.resolve(); }
  protected dispose() { this.stopped = true; ++this.scope; ++this.request; clearTimeout(this.timer); }
}
@injectable()
export class CorrectionJobsViewModel extends StatefulService<{ data: CoreOutput<"corrections.list">; page: number; error: string | null; loading: boolean }> {
  protected initState = { data: { items: [], total: 0 }, page: 1, error: null, loading: true };
  private stopped = false; private scope = 0; private request = 0; private timer?: ReturnType<typeof setTimeout>;
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) { super(); }
  watch() { if (this.stopped) return () => {}; const scope = ++this.scope; const tick = async () => { await this.refresh(); if (!this.stopped && scope === this.scope) this.timer = setTimeout(() => { void tick(); }, 2000); }; void tick(); return () => { ++this.scope; ++this.request; clearTimeout(this.timer); }; }
  async refresh(page = this.state.page) { if (this.stopped) return; const request = ++this.request; this.setState({ page }); try { const data = await this.client.listCorrections({ page }); if (!this.stopped && request === this.request) this.setState({ data, error: null, loading: false }); } catch (error) { if (!this.stopped && request === this.request) this.setState({ error: message(error, "修正作业暂不可读取，请刷新重试"), loading: false }); } }
  protected dispose() { this.stopped = true; ++this.scope; ++this.request; clearTimeout(this.timer); }
}
