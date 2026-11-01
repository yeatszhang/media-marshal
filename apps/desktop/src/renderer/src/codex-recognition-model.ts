import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { CodexJob, CoreInput, DesktopApi } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";

@injectable()
export class CodexRecognitionViewModel extends StatefulService<{
  jobs: CodexJob[];
  total: number;
  page: number;
  enabled: boolean | null;
  busy: boolean;
  error: string | null;
  queryError: string | null;
  notice: string | null;
}> {
  protected initState = {
    jobs: [],
    total: 0,
    page: 1,
    enabled: null,
    busy: false,
    error: null,
    queryError: null,
    notice: null,
  };
  private stopped = false;
  private watchers = 0;
  private generation = 0;
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private intents = new Map<string, string>();
  constructor(@inject(DesktopClient) readonly client: DesktopApi) {
    super();
  }
  watch() {
    if (this.stopped) return () => {};
    if (++this.watchers === 1) {
      const epoch = ++this.epoch;
      const poll = async () => {
        await this.refresh();
        if (!this.stopped && this.watchers && epoch === this.epoch)
          this.timer = setTimeout(() => {
            void poll();
          }, 2000);
      };
      void poll();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!--this.watchers) {
        ++this.epoch;
        ++this.generation;
        clearTimeout(this.timer);
      }
    };
  }
  async refresh() {
    if (this.stopped) return;
    const generation = ++this.generation;
    try {
      const [jobs, settings] = await Promise.all([
        this.client.listCodexJobs({ page: this.state.page }),
        this.client.getSettings(),
      ]);
      if (!this.stopped && generation === this.generation)
        this.setState({
          jobs: jobs.items,
          total: jobs.total,
          enabled: settings.recognition?.codexEnabled ?? false,
          queryError: null,
        });
    } catch (error) {
      if (!this.stopped && generation === this.generation)
        this.setState({
          queryError:
            error instanceof Error ? error.message : "无法读取 Codex 识别记录，请刷新重试",
        });
    }
  }
  async page(page: number) {
    this.setState({ page });
    await this.refresh();
  }
  private async submit(signature: string, work: (requestKey: string) => Promise<CodexJob>) {
    if (this.stopped || this.state.busy) return;
    let requestKey = this.intents.get(signature);
    if (!requestKey) {
      requestKey = crypto.randomUUID();
      this.intents.set(signature, requestKey);
    }
    this.setState({ busy: true, error: null, notice: null });
    try {
      const job = await work(requestKey);
      this.intents.delete(signature);
      if (!this.stopped) {
        this.setState({
          page: 1,
          notice: `已提交${job.directory ? "目录" : "单文件"}识别，共 ${job.items.length} 项。可离开页面，结果保存在识别记录中。`,
        });
        await this.refresh();
      }
    } catch (error) {
      if (!this.stopped)
        this.setState({
          error:
            error instanceof Error ? error.message : "Codex 请求尚未确认，请重试同一范围查询原请求",
        });
    } finally {
      if (!this.stopped) this.setState({ busy: false });
    }
  }
  rematch(input: Omit<CoreInput<"codex.rematch">, "requestKey">) {
    return this.submit(JSON.stringify(["task", input]), (requestKey) =>
      this.client.rematchWithCodex({ ...input, requestKey }),
    );
  }
  directory(input: Omit<CoreInput<"codex.prepare-directory">, "requestKey">) {
    return this.submit(JSON.stringify(["directory", input]), (requestKey) =>
      this.client.recognizeDirectoryWithCodex({ ...input, requestKey }),
    );
  }
  async cancel(id: string) {
    if (this.stopped || this.state.busy) return;
    this.setState({ busy: true, error: null });
    try {
      await this.client.cancelCodexJob(id);
      if (!this.stopped) await this.refresh();
    } catch (error) {
      if (!this.stopped)
        this.setState({
          error: error instanceof Error ? error.message : "停止识别未完成，请刷新作业记录后重试",
        });
    } finally {
      if (!this.stopped) this.setState({ busy: false });
    }
  }
  protected dispose() {
    this.stopped = true;
    ++this.generation;
    ++this.epoch;
    clearTimeout(this.timer);
    this.intents.clear();
  }
}
