import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { CoreInput, CoreOutput, DesktopApi, OrganizeBatch, Recognition } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";
@injectable()
export class OrganizeBatchesViewModel extends StatefulService<{ tasks: Recognition[]; loading: boolean; batches: OrganizeBatch[]; total: number; page: number; selectedId: string | null; memberPage: number; detail: CoreOutput<"ingestion.organize-batch"> | null; assets: Record<string, CoreOutput<"ingestion.organize-batch-assets">["items"]>; busy: boolean; error: string | null; queryError: string | null; notice: string | null }> {
  protected initState = { tasks: [], loading: false, batches: [], total: 0, page: 1, selectedId: null, memberPage: 1, detail: null, assets: {}, busy: false, error: null, queryError: null, notice: null };
  private stopped = false; private request = 0; private draft = 0; private watchers = 0; private epoch = 0; private timer?: ReturnType<typeof setTimeout>; private intents = new Map<string, string>();
  constructor(@inject(DesktopClient) readonly client: DesktopApi) { super(); }
  watch() { if (++this.watchers === 1) { const epoch = ++this.epoch; const tick = async () => { await this.refresh(); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void tick(); }, 1500); }; void tick(); } let released = false; return () => { if (!released) { released = true; if (!--this.watchers) { ++this.epoch; clearTimeout(this.timer); } } }; }
  async refresh() {
    if (this.stopped) return; const request = ++this.request, selectedId = this.state.selectedId;
    try { const [jobs, detail] = await Promise.all([this.client.listOrganizeBatches({ page: this.state.page }), selectedId ? this.client.getOrganizeBatch({ id: selectedId, page: this.state.memberPage }).catch((error: unknown) => ({ error })) : null]); if (!this.stopped && request === this.request) this.setState({ batches: jobs.items, total: jobs.total, detail: detail && !("error" in detail) ? detail : null, selectedId: detail && "error" in detail ? null : selectedId, queryError: detail && "error" in detail ? detail.error instanceof Error ? detail.error.message : "无法读取此批次，请刷新记录后重试" : null }); }
    catch (error) { if (!this.stopped && request === this.request) this.setState({ queryError: error instanceof Error ? error.message : "整理批次暂不可读取，请刷新后重试" }); }
  }
  async loadTasks(ids: string[]) { const draft = ++this.draft; this.setState({ loading: true, tasks: [], error: null }); try { const tasks: Recognition[] = []; for (let i = 0; i < ids.length; i += 8) { if (this.stopped || draft !== this.draft) return; tasks.push(...await Promise.all(ids.slice(i, i + 8).map((id) => this.client.getIngestionTask(id)))); } if (!this.stopped && draft === this.draft) this.setState({ tasks }); } catch (error) { if (!this.stopped && draft === this.draft) this.setState({ error: error instanceof Error ? error.message : "无法读取所选文件，请刷新后重新选择" }); } finally { if (!this.stopped && draft === this.draft) this.setState({ loading: false }); } }
  closeDraft() { ++this.draft; this.setState({ tasks: [], loading: false }); }
  async inspect(id: string, memberPage = 1) { this.setState({ selectedId: id, memberPage, detail: null, assets: {} }); await this.refresh(); }
  async page(page: number) { this.setState({ page, selectedId: null, detail: null, assets: {} }); await this.refresh(); }
  private key(signature: string) { let key = this.intents.get(signature); if (!key) { key = crypto.randomUUID(); this.intents.set(signature, key); } return key; }
  async preview(input: Omit<CoreInput<"ingestion.preview-organize-batch">, "requestKey">) {
    if (this.state.busy || this.stopped) return false; const draft = this.draft, signature = JSON.stringify(["preview", input]); this.setState({ busy: true, error: null, notice: null });
    try { const batch = await this.client.previewOrganizeBatch({ ...input, requestKey: this.key(signature) }); if (!this.stopped) { this.intents.delete(signature); this.setState({ ...(draft === this.draft ? { selectedId: batch.id, memberPage: 1, assets: {} } : {}), notice: "已保存逐文件预览意图，尚未提交 COPY。请等待完整计划并逐项核对。" }); await this.refresh(); } return true; } catch (error) { if (!this.stopped) this.setState({ error: error instanceof Error ? error.message : "批量预览请求未确认，请重试同一草稿以查询原请求" }); return false; } finally { if (!this.stopped) this.setState({ busy: false }); }
  }
  async confirm(id: string) {
    if (this.stopped || this.state.busy) return; const signature = `confirm:${id}`; this.setState({ busy: true, error: null, notice: null });
    try { const batch = await this.client.confirmOrganizeBatch({ id, requestKey: this.key(signature), filesComplete: true }); if (!this.stopped) { this.setState({ notice: ["BLOCKED", "EXPIRED"].includes(batch.state) ? "本批次未提交，确认前发现变化，请查看逐项原因并重新预览。" : "批次已确认，按项提交原 COPY 计划；部分失败可定位到原任务，不承诺整批同时成功。" }); await this.refresh(); } } catch (error) { if (!this.stopped) this.setState({ error: error instanceof Error ? error.message : "批次确认响应未收到，请重试查询原确认结果" }); } finally { if (!this.stopped) this.setState({ busy: false }); }
  }
  async cancel(id: string) { if (this.stopped || this.state.busy) return; this.setState({ busy: true, error: null }); try { await this.client.cancelOrganizeBatch(id); if (!this.stopped) { this.setState({ notice: "已停止后续预览或提交；已经提交的 COPY 和文件继续保留，可在原任务查看。" }); await this.refresh(); } } catch (error) { if (!this.stopped) this.setState({ error: error instanceof Error ? error.message : "停止批次未完成，请重试" }); } finally { if (!this.stopped) this.setState({ busy: false }); } }
  async assets(taskId: string) { const id = this.state.selectedId; if (!id) return; try { const result = await this.client.getOrganizeBatchAssets({ id, taskId }); if (!this.stopped && id === this.state.selectedId) this.setState({ assets: { ...this.state.assets, [taskId]: result.items } }); } catch (error) { if (!this.stopped) this.setState({ error: error instanceof Error ? error.message : "附属文件预览不可读取，请重试" }); } }
  protected dispose() { this.stopped = true; ++this.request; ++this.draft; ++this.epoch; clearTimeout(this.timer); this.intents.clear(); }
}
