import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { CoreInput, DesktopApi, Recognition, RecognitionEditPreview } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";
@injectable()
export class RecognitionEditsViewModel extends StatefulService<{ tasks: Recognition[]; preview: RecognitionEditPreview | null; loading: boolean; busy: boolean; error: string | null; notice: string | null }> {
  protected initState = { tasks: [], preview: null, loading: false, busy: false, error: null, notice: null };
  private generation = 0; private stopped = false; private intents = new Map<string, string>();
  constructor(@inject(DesktopClient) readonly client: DesktopApi) { super(); }
  async open(taskIds: string[]) {
    const generation = ++this.generation; this.setState({ tasks: [], preview: null, loading: true, busy: false, error: null, notice: null });
    try {
      // Core 的等待请求上限为 64；分段读取为页面轮询和其他操作保留空间。
      const tasks: Recognition[] = [];
      for (let index = 0; index < taskIds.length; index += 8) {
        if (this.stopped || generation !== this.generation) return;
        tasks.push(...await Promise.all(taskIds.slice(index, index + 8).map((id) => this.client.getIngestionTask(id))));
      }
      if (!this.stopped && generation === this.generation) this.setState({ tasks });
    }
    catch (error) { if (!this.stopped && generation === this.generation) this.setState({ error: error instanceof Error ? error.message : "无法读取所选任务，请刷新待处理列表后重试" }); }
    finally { if (!this.stopped && generation === this.generation) this.setState({ loading: false }); }
  }
  invalidate() { ++this.generation; this.setState({ preview: null, error: null, notice: null }); }
  async preview(input: CoreInput<"ingestion.preview-recognition-edit">) {
    if (this.state.busy || this.stopped) return; const generation = ++this.generation; this.setState({ busy: true, preview: null, error: null, notice: null });
    try { const preview = await this.client.previewRecognitionEdit(input); if (!this.stopped && generation === this.generation) this.setState({ preview }); }
    catch (error) { if (!this.stopped && generation === this.generation) this.setState({ error: error instanceof Error ? error.message : "识别字段预览失败，请核对所选任务后重试" }); }
    finally { if (!this.stopped && generation === this.generation) this.setState({ busy: false }); }
  }
  async save(input: CoreInput<"ingestion.preview-recognition-edit">, rematch: boolean) {
    const preview = this.state.preview; if (this.stopped || this.state.busy || !preview?.canApply) return null;
    const signature = JSON.stringify([input, preview.fingerprint, rematch]); let requestKey = this.intents.get(signature); if (!requestKey) { requestKey = crypto.randomUUID(); this.intents.set(signature, requestKey); }
    const generation = ++this.generation; this.setState({ busy: true, error: null });
    try {
      const result = await this.client.saveRecognitionEdit({ ...input, fingerprint: preview.fingerprint, requestKey, rematch });
      if (this.stopped || generation !== this.generation) return null;
      if (!this.stopped && generation === this.generation) { this.setState({ tasks: this.state.tasks.map((task) => ({ ...task, revision: result.items.find((row) => row.taskId === task.taskId)?.revision ?? task.revision, matchesStale: true })), preview: null, notice: `已保存 ${result.updated} 项识别信息。${result.rematchQueued ? `${result.rematchQueued} 项已进入重新匹配队列，可在对应任务查看逐项结果。` : "原候选已标记为待重新匹配。"}文件整理仍须另行预览并确认。` }); }
      return result;
    } catch (error) { if (!this.stopped && generation === this.generation) this.setState({ error: error instanceof Error ? error.message : "保存识别字段未完成，请重试同一预览以查询原请求" }); return null; }
    finally { if (!this.stopped && generation === this.generation) this.setState({ busy: false }); }
  }
  close() { ++this.generation; this.setState({ tasks: [], preview: null, loading: false, busy: false }); }
  protected dispose() { this.stopped = true; ++this.generation; this.intents.clear(); }
}
