import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { CoreOutput, DesktopApi, IngestionDirectory, RecognitionBatch } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";
@injectable()
export class DirectoriesViewModel extends StatefulService<{ directories: IngestionDirectory[]; total: number; page: number; selected: IngestionDirectory | null; memberPage: number; detail: CoreOutput<"ingestion.directory"> | null; batches: RecognitionBatch[]; batchTotal: number; batchPage: number; batchId: string | null; batchItems: CoreOutput<"ingestion.recognition-batch-items"> | null; error: string | null; queryError: string | null; busy: boolean; notice: string | null }> {
  protected initState = { directories: [], total: 0, page: 1, selected: null, memberPage: 1, detail: null, batches: [], batchTotal: 0, batchPage: 1, batchId: null, batchItems: null, error: null, queryError: null, busy: false, notice: null };
  private request = 0; private watchers = 0; private epoch = 0; private stopped = false; private timer?: ReturnType<typeof setTimeout>; private intents = new Map<string, string>();
  constructor(@inject(DesktopClient) readonly client: DesktopApi) { super(); }
  watch() { if (++this.watchers === 1) { const epoch = ++this.epoch; const tick = async () => { await this.refresh(); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void tick(); }, 2000); }; void tick(); } let released = false; return () => { if (!released) { released = true; if (!--this.watchers) { ++this.epoch; clearTimeout(this.timer); } } }; }
  async refresh() {
    if (this.stopped) return; const request = ++this.request, { selected, memberPage, batchId } = this.state;
    try {
      const [directories, batches, detail, batchItems] = await Promise.all([this.client.listIngestionDirectories({ page: this.state.page }), this.client.listRecognitionBatches({ page: this.state.batchPage }), selected ? this.client.getIngestionDirectory({ id: selected.id, sourceId: selected.sourceId, page: memberPage }).catch((error: unknown) => ({ error })) : null, batchId ? this.client.listRecognitionBatchItems({ id: batchId }).catch((error: unknown) => ({ error })) : null]);
      if (this.stopped || request !== this.request) return;
      const error = detail && "error" in detail ? detail.error : batchItems && "error" in batchItems ? batchItems.error : null;
      this.setState({ directories: directories.items, total: directories.total, batches: batches.items, batchTotal: batches.total, detail: detail && !("error" in detail) ? detail : null, selected: detail && "error" in detail ? null : selected, batchItems: batchItems && !("error" in batchItems) ? batchItems : null, queryError: error ? error instanceof Error ? error.message : "目录或批次暂不可读取，请刷新列表后重试" : null });
    } catch (error) { if (!this.stopped && request === this.request) this.setState({ queryError: error instanceof Error ? error.message : "无法读取目录和批次，请刷新后重试" }); }
  }
  async select(directory: IngestionDirectory, page = 1) { this.setState({ selected: directory, memberPage: page, detail: null }); await this.refresh(); }
  async page(page: number) { this.setState({ page, selected: null, detail: null, memberPage: 1 }); await this.refresh(); }
  async batchesPage(batchPage: number) { this.setState({ batchPage, batchId: null, batchItems: null }); await this.refresh(); }
  async inspectBatch(batchId: string) { this.setState({ batchId, batchItems: null }); await this.refresh(); }
  async recognize(candidateIds: string[]) {
    if (this.state.busy || !candidateIds.length || this.stopped) return false;
    const signature = JSON.stringify([...candidateIds].sort()); let requestKey = this.intents.get(signature); if (!requestKey) { requestKey = crypto.randomUUID(); this.intents.set(signature, requestKey); }
    this.setState({ busy: true, error: null, notice: null });
    try { const job = await this.client.recognizeIngestionBatch({ candidateIds, requestKey }); if (!this.stopped) { this.intents.delete(signature); this.setState({ batchId: job.id, notice: `已保存 ${job.total} 项批量识别意图；等待就绪后逐项提交，识别不会复制文件。` }); await this.refresh(); } return true; }
    catch (error) { if (!this.stopped) this.setState({ error: error instanceof Error ? error.message : "批量识别请求未确认，请重试同一选择以查询原请求" }); return false; }
    finally { if (!this.stopped) this.setState({ busy: false }); }
  }
  async cancel(id: string) { if (this.state.busy || this.stopped) return; this.setState({ busy: true, error: null }); try { await this.client.cancelRecognitionBatch(id); if (!this.stopped) { this.setState({ notice: "已停止此批次后续提交；已经提交的识别任务保留，不执行文件撤销。" }); await this.refresh(); } } catch (error) { if (!this.stopped) this.setState({ error: error instanceof Error ? error.message : "取消批次未完成，请重试" }); } finally { if (!this.stopped) this.setState({ busy: false }); } }
  protected dispose() { this.stopped = true; ++this.request; ++this.epoch; clearTimeout(this.timer); this.intents.clear(); }
}
