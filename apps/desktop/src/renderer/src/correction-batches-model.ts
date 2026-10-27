import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { CoreInput, CoreOutput, DesktopApi } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";
const reason = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
export type BatchPreviewInput = Omit<CoreInput<"corrections.preview-batch">, "taskId" | "requestKey">;
@injectable()
export class CorrectionBatchDraftModel extends StatefulService<{ task: CoreOutput<"corrections.task"> | null; initial: CoreOutput<"corrections.batch">["batch"] | null; scope: CoreOutput<"corrections.scope"> | null; loading: boolean; reading: boolean; busy: boolean; error: string | null; queryError: string | null }> {
  protected initState = { task: null, initial: null, scope: null, loading: true, reading: false, busy: false, error: null, queryError: null };
  private taskId?: string; private owner = 0; private request = 0; private stopped = false; private receipt?: { signature: string; key: string };
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) { super(); }
  watch(taskId: string, from: string | null) { if (this.stopped) return () => {}; const owner = ++this.owner; this.taskId = taskId; ++this.request; this.setState({ ...this.initState }); void this.load(taskId, from, owner); return () => { if (owner === this.owner) { ++this.owner; ++this.request; } }; }
  private async load(taskId: string, from: string | null, owner: number) {
    try { const [task, old] = await Promise.all([this.client.getCorrectionTask(taskId), from ? this.client.getCorrectionBatch({ id: from }) : null]); if (old && old.batch.anchorTaskId !== taskId) throw new Error("原批次与当前锚点任务不符，请从原批次重新进入"); if (!this.stopped && owner === this.owner) this.setState({ task, initial: old?.batch ?? null, loading: false, queryError: null }); }
    catch (error) { if (!this.stopped && owner === this.owner) this.setState({ loading: false, queryError: reason(error, "无法读取批量修正参数，请返回任务列表重试") }); }
  }
  async readScope(scope: CoreInput<"corrections.scope">["scope"], page = 1) {
    if (this.stopped || !this.taskId) return; const owner = this.owner, request = ++this.request, taskId = this.taskId; this.setState({ reading: true, queryError: null });
    try { const data = await this.client.getCorrectionScope({ taskId, scope, page }); if (!this.stopped && owner === this.owner && request === this.request) this.setState({ scope: data, reading: false, queryError: null }); }
    catch (error) { if (!this.stopped && owner === this.owner && request === this.request) this.setState({ scope: null, reading: false, queryError: reason(error, "完整范围读取失败，请重新读取；不会创建文件作业") }); }
  }
  async preview(input: BatchPreviewInput): Promise<string | null> {
    if (this.stopped || this.state.busy || !this.taskId) return null; const owner = this.owner, taskId = this.taskId, signature = JSON.stringify({ taskId, ...input });
    if (signature !== this.receipt?.signature) this.receipt = { signature, key: crypto.randomUUID() }; const requestKey = this.receipt.key; this.setState({ busy: true, error: null });
    try { const batch = await this.client.previewCorrectionBatch({ taskId, requestKey, ...input }); if (this.receipt?.key === requestKey) this.receipt = undefined; return !this.stopped && owner === this.owner ? batch.id : null; }
    catch (error) { if (!this.stopped && owner === this.owner) this.setState({ error: reason(error, "批量预览响应未收到，请查看批量记录或重试原请求") }); return null; }
    finally { if (!this.stopped && owner === this.owner) this.setState({ busy: false }); }
  }
  protected dispose() { this.stopped = true; ++this.owner; ++this.request; }
}
export interface ExpandedCorrectionMember { preview: CoreOutput<"corrections.get-preview"> | null; detail: CoreOutput<"corrections.get"> | null; loading: boolean; error: string | null }
@injectable()
export class CorrectionBatchViewModel extends StatefulService<{ data: CoreOutput<"corrections.batch"> | null; task: CoreOutput<"corrections.task"> | null; page: number; paused: boolean; files: Record<string, ExpandedCorrectionMember>; loading: boolean; busy: boolean; error: string | null; queryError: string | null }> {
  protected initState = { data: null, task: null, page: 1, paused: false, files: {}, loading: true, busy: false, error: null, queryError: null };
  private id?: string; private owner = 0; private request = 0; private mutation = 0; private stopped = false; private expanded = new Set<string>(); private timer?: ReturnType<typeof setTimeout>; private confirmation?: { id: string; key: string };
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) { super(); }
  watch(id: string) {
    if (this.stopped) return () => {};
    const owner = ++this.owner; ++this.request; clearTimeout(this.timer); this.id = id; this.expanded.clear(); this.setState({ ...this.initState });
    const tick = async () => { await this.refresh(); if (!this.stopped && owner === this.owner) this.timer = setTimeout(() => { void tick(); }, 1500); }; void tick();
    return () => { if (owner === this.owner) { ++this.owner; ++this.request; clearTimeout(this.timer); this.expanded.clear(); } };
  }
  async refresh(page = this.state.page, allowBusy = false) {
    if (this.stopped || !this.id || this.state.busy && !allowBusy) return; const id = this.id, owner = this.owner, request = ++this.request, mutation = this.mutation;
    if (page !== this.state.page) { this.expanded.clear(); this.setState({ files: {} }); }
    try {
      const data = await this.client.getCorrectionBatch({ id, page });
      const [task, pause] = await Promise.all([this.client.getCorrectionTask(data.batch.anchorTaskId), this.client.getOrganizePause()]);
      const files: Record<string, ExpandedCorrectionMember> = {};
      await Promise.all(data.items.filter((item) => this.expanded.has(item.taskId)).map(async (item) => {
        try { const detail = item.operation ? await this.client.getCorrection(item.operation.id) : null, preview = !detail && item.previewId ? await this.client.getCorrectionPreview(item.previewId) : null; files[item.taskId] = { preview, detail, loading: false, error: null }; }
        catch (error) { files[item.taskId] = { preview: null, detail: null, loading: false, error: reason(error, "此成员的完整文件清单暂不可读，请重试读取后核对") }; }
      }));
      if (!this.stopped && owner === this.owner && request === this.request && mutation === this.mutation) this.setState({ data, task, page, paused: pause.paused, files, loading: false, queryError: null });
    } catch (error) { if (!this.stopped && owner === this.owner && request === this.request && mutation === this.mutation) this.setState({ loading: false, queryError: reason(error, "批量修正状态不可读，请重试查询原批次") }); }
  }
  expand(taskId: string) { if (this.expanded.has(taskId)) { this.expanded.delete(taskId); const { [taskId]: _old, ...files } = this.state.files; this.setState({ files }); } else { this.expanded.add(taskId); this.setState({ files: { ...this.state.files, [taskId]: { preview: null, detail: null, loading: true, error: null } } }); } return this.refresh(); }
  private async action(work: () => Promise<unknown>) {
    if (this.stopped || this.state.busy) return; const owner = this.owner; ++this.mutation; ++this.request; this.setState({ busy: true, error: null });
    try { await work(); if (!this.stopped && owner === this.owner) await this.refresh(this.state.page, true); }
    catch (error) { if (!this.stopped && owner === this.owner) this.setState({ error: reason(error, "请求未能返回，请查询原批次或成员后重试") }); }
    finally { if (!this.stopped && owner === this.owner) this.setState({ busy: false }); }
  }
  confirm() { const batch = this.state.data?.batch; if (!batch || batch.state !== "READY") return Promise.resolve(); if (this.confirmation?.id !== batch.id) this.confirmation = { id: batch.id, key: crypto.randomUUID() }; return this.action(() => this.client.confirmCorrectionBatch({ id: batch.id, requestKey: this.confirmation!.key, fingerprint: batch.fingerprint, filesComplete: true })); }
  cancel() { return this.id ? this.action(() => this.client.cancelCorrectionBatch({ id: this.id! })) : Promise.resolve(); }
  retry(taskId: string) { const operation = this.state.data?.items.find((item) => item.taskId === taskId)?.operation; return operation ? this.action(() => this.client.retryCorrection(operation.id)) : Promise.resolve(); }
  protected dispose() { this.stopped = true; ++this.owner; ++this.request; clearTimeout(this.timer); }
}
@injectable()
export class CorrectionBatchJobsModel extends StatefulService<{ data: CoreOutput<"corrections.batches">; page: number; loading: boolean; error: string | null }> {
  protected initState = { data: { items: [], total: 0 }, page: 1, loading: true, error: null };
  private owner = 0; private request = 0; private stopped = false; private timer?: ReturnType<typeof setTimeout>;
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) { super(); }
  watch() { if (this.stopped) return () => {}; const owner = ++this.owner; const tick = async () => { await this.refresh(); if (!this.stopped && owner === this.owner) this.timer = setTimeout(() => { void tick(); }, 2000); }; void tick(); return () => { if (owner === this.owner) { ++this.owner; ++this.request; clearTimeout(this.timer); } }; }
  async refresh(page = this.state.page) { if (this.stopped) return; const request = ++this.request; try { const data = await this.client.listCorrectionBatches({ page }); if (!this.stopped && request === this.request) this.setState({ data, page, loading: false, error: null }); } catch (error) { if (!this.stopped && request === this.request) this.setState({ loading: false, error: reason(error, "批量记录暂不可读，请刷新重试") }); } }
  protected dispose() { this.stopped = true; ++this.owner; ++this.request; clearTimeout(this.timer); }
}
