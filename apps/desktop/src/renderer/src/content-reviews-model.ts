import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { ContentReview, CoreOutput, DesktopApi } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";

interface ReviewState {
  items: ContentReview[]; total: number; page: number; pending: boolean; error: string | null; queryError: string | null;
  detail: (CoreOutput<"ingestion.content-review-files"> & { id: string; page: number }) | null;
}
@injectable()
export class ContentReviewsViewModel extends StatefulService<ReviewState> {
  protected initState: ReviewState = { items: [], total: 0, page: 1, pending: false, error: null, queryError: null, detail: null };
  private stopped = false; private watchers = 0; private epoch = 0; private request = 0; private timer?: ReturnType<typeof setTimeout>;
  private readonly starts = new Map<string, string>();
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) { super(); }
  watch() {
    if (++this.watchers === 1) { const epoch = ++this.epoch; const poll = async () => { await this.refresh(); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void poll(); }, 2000); }; void poll(); }
    let released = false; return () => { if (released) return; released = true; if (!--this.watchers) { ++this.epoch; clearTimeout(this.timer); } };
  }
  async refresh(page = this.state.page) {
    const request = ++this.request, detail = this.state.detail; this.setState({ page });
    try {
      const [result, files] = await Promise.all([this.client.listContentReviews({ page }), detail ? this.client.listContentReviewFiles({ id: detail.id, page: detail.page }) : Promise.resolve(null)]);
      if (!this.stopped && request === this.request) this.setState({ ...result, ...(detail && files ? { detail: { ...files, id: detail.id, page: detail.page } } : {}), queryError: null });
    } catch (error) { if (!this.stopped && request === this.request) this.setState({ queryError: error instanceof Error ? error.message : "内容复核记录读取失败，请刷新重试" }); }
  }
  private async action(work: () => Promise<void>) {
    if (this.stopped || this.state.pending) return; this.setState({ pending: true, error: null });
    try { await work(); } catch (error) { if (!this.stopped) this.setState({ error: error instanceof Error ? error.message : "内容复核操作失败，请重试" }); }
    finally { if (!this.stopped) this.setState({ pending: false }); }
  }
  start(sourceId: string) { return this.action(async () => {
    let requestKey = this.starts.get(sourceId); if (!requestKey) { requestKey = crypto.randomUUID(); this.starts.set(sourceId, requestKey); }
    await this.client.reviewIngestionContent({ sourceId, requestKey }); this.starts.delete(sourceId); await this.refresh(1);
  }); }
  cancel(id: string) { return this.action(async () => { await this.client.cancelContentReview(id); await this.refresh(); }); }
  showFiles(id: string, page = 1) { this.setState({ detail: { id, page, items: [], total: 0 } }); return this.refresh(); }
  closeFiles() { ++this.request; this.setState({ detail: null }); }
  protected dispose() { this.stopped = true; ++this.epoch; ++this.request; clearTimeout(this.timer); this.starts.clear(); }
}
