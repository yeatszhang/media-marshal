import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { CoreOutput, DesktopApi, SourceScan } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";
interface ScanState { items: SourceScan[]; total: number; page: number; pending: boolean; error: string | null; queryError: string | null; detail: (CoreOutput<"ingestion.scan-job"> & { page: number }) | null }
@injectable()
export class SourceScansViewModel extends StatefulService<ScanState> {
  protected initState: ScanState = { items: [], total: 0, page: 1, pending: false, error: null, queryError: null, detail: null };
  private stopped = false; private watchers = 0; private epoch = 0; private request = 0; private operation = 0; private timer?: ReturnType<typeof setTimeout>;
  private readonly starts = new Map<string, string>();
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) { super(); }
  watch() {
    if (this.stopped) return () => {};
    if (++this.watchers === 1) { const epoch = ++this.epoch; const poll = async () => { await this.refresh(); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void poll(); }, 2000); }; void poll(); }
    let released = false; return () => { if (released) return; released = true; if (!--this.watchers) { this.epoch++; this.request++; this.operation++; clearTimeout(this.timer); this.setState({ pending: false }); } };
  }
  async refresh(page = this.state.page) {
    if (this.stopped || !this.watchers) return;
    const request = ++this.request, detail = this.state.detail; this.setState({ page });
    try { const [result, current] = await Promise.all([this.client.listIngestionScans({ page }), detail ? this.client.getIngestionScan({ id: detail.job.id, page: detail.page }) : Promise.resolve(null)]); if (!this.stopped && this.watchers && request === this.request) this.setState({ ...result, ...(current && detail ? { detail: { ...current, page: detail.page } } : {}), queryError: null }); }
    catch (error) { if (!this.stopped && this.watchers && request === this.request) this.setState({ queryError: error instanceof Error ? error.message : "目录扫描记录读取失败，请刷新重试" }); }
  }
  async start(sourceId: string) {
    if (this.stopped || !this.watchers || this.state.pending) return;
    const operation = ++this.operation; this.setState({ pending: true, error: null });
    let key = this.starts.get(sourceId); if (!key) { key = crypto.randomUUID(); this.starts.set(sourceId, key); }
    try { await this.client.scanIngestion(sourceId, key); if (this.starts.get(sourceId) === key) this.starts.delete(sourceId); if (!this.stopped && operation === this.operation) await this.refresh(1); }
    catch (error) { if (!this.stopped && operation === this.operation) this.setState({ error: error instanceof Error ? error.message : "目录扫描未能提交，请查询记录后重试" }); }
    finally { if (!this.stopped && operation === this.operation) this.setState({ pending: false }); }
  }
  inspect(id: string, page = 1) { ++this.request; const job = this.state.items.find((value) => value.id === id) ?? this.state.detail?.job; if (!job || job.id !== id) return; this.setState({ detail: { job, issues: [], total: 0, page } }); return this.refresh(); }
  closeDetail() { ++this.request; this.setState({ detail: null }); }
  protected dispose() { this.stopped = true; ++this.request; ++this.epoch; ++this.operation; clearTimeout(this.timer); this.starts.clear(); }
}
