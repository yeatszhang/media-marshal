import { randomUUID } from "node:crypto";
import { CloudError, DesktopError } from "@media-marshal/contracts";

export type PauseKind = "organize" | "downloads";
const kinds: PauseKind[] = ["organize", "downloads"];
const names = { organize: "全部整理", downloads: "云端下载" };
interface Lane { paused: boolean | null; busy: boolean; problem: string | null; readProblem: string | null; revision: number }
export interface NativePauseView { status: string | null; organize: Lane & { enabled: boolean }; downloads: Lane & { enabled: boolean } }
export interface NativePausePort {
  ready(): boolean;
  read(kind: PauseKind): Promise<{ paused: boolean }>;
  write(kind: PauseKind, paused: boolean, requestKey: string): Promise<{ paused: boolean }>;
  publish(view: NativePauseView): void;
  report(kind: PauseKind, message: string): void;
}
const reason = (error: unknown) => error instanceof DesktopError || error instanceof CloudError ? error.message.slice(0, 500) : "原因尚未确认，请打开主窗口检查核心状态或导出诊断";

/** 原生菜单只投影 Core 状态；每次明确点击生成一个幂等键，失败不自动重放。 */
export class NativePauseControls {
  private closed = false;
  private generation = 0;
  private dirty = false;
  private reading?: Promise<void>;
  private writing = new Set<Promise<void>>();
  private lanes: Record<PauseKind, Lane> = { organize: { paused: null, busy: false, problem: null, readProblem: null, revision: 0 }, downloads: { paused: null, busy: false, problem: null, readProblem: null, revision: 0 } };
  constructor(private readonly port: NativePausePort) {}
  get view(): NativePauseView {
    const ready = !this.closed && this.port.ready(), unknown = kinds.some(kind => this.lanes[kind].paused === null);
    const status = this.closed ? "客户端正在停止，暂停设置不可更改" : !ready ? "核心未就绪，请打开主窗口检查或重启核心" : kinds.some(kind => this.lanes[kind].busy) ? "正在保存暂停设置，请稍候" : unknown ? "暂停状态尚未核对，请重新核对或查看控制问题" : null;
    const laneView = (kind: PauseKind) => ({ ...this.lanes[kind], problem: [this.lanes[kind].problem, this.lanes[kind].readProblem].filter(Boolean).join("\n") || null, enabled: ready && !this.lanes[kind].busy && this.lanes[kind].paused !== null });
    return { status, organize: laneView("organize"), downloads: laneView("downloads") };
  }
  private publish() { this.port.publish(this.view); }
  invalidate() {
    ++this.generation; this.dirty = true;
    for (const kind of kinds) { this.lanes[kind].paused = null; ++this.lanes[kind].revision; }
    this.publish();
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.reading) return this.reading;
    return this.reading = this.readAll().finally(() => { this.reading = undefined; if (this.dirty && !this.closed) return this.refresh(); });
  }
  private async readAll() {
    do {
      this.dirty = false;
      if (!this.port.ready()) { ++this.generation; for (const kind of kinds) this.lanes[kind].paused = null; this.publish(); return; }
      await Promise.all(kinds.map(kind => this.read(kind)));
    } while (this.dirty && !this.closed);
  }
  private async read(kind: PauseKind) {
    const lane = this.lanes[kind], generation = this.generation, revision = lane.revision;
    if (this.closed || lane.busy) return;
    try {
      const result = await this.port.read(kind);
      if (this.closed || generation !== this.generation || revision !== lane.revision || !this.port.ready()) return;
      lane.paused = result.paused; lane.readProblem = null;
    } catch (error) {
      if (this.closed || generation !== this.generation || revision !== lane.revision) return;
      lane.paused = null; lane.readProblem = `${names[kind]}暂停状态未读取：${reason(error)}。请重新核对状态；持续失败时打开主窗口重启核心。`;
    }
    this.publish();
  }
  set(kind: PauseKind, paused: boolean): Promise<void> {
    const lane = this.lanes[kind];
    if (!this.view[kind].enabled) {
      if (!this.closed && !lane.busy) {
        lane.problem = `${names[kind]}${paused ? "暂停" : "恢复"}设置未提交：${this.view.status}。请核对状态后重试。`;
        this.publish(); this.port.report(kind, lane.problem);
      } else this.publish();
      return Promise.resolve();
    }
    const generation = this.generation;
    lane.busy = true; lane.problem = null; ++lane.revision; this.publish();
    const flight = this.apply(kind, paused, generation).finally(() => { this.writing.delete(flight); });
    this.writing.add(flight); return flight;
  }
  private async apply(kind: PauseKind, paused: boolean, generation: number) {
    const lane = this.lanes[kind];
    let problem: string | null = null;
    try {
      const result = await this.port.write(kind, paused, randomUUID());
      if (!this.closed && generation === this.generation && this.port.ready()) lane.paused = result.paused;
    } catch (error) {
      if (!this.closed) { problem = `${names[kind]}${paused ? "暂停" : "恢复"}设置未确认：${reason(error)}。不会自动重试；请核对当前勾选状态后重试。`; lane.problem = problem; lane.paused = null; }
    } finally {
      lane.busy = false;
      if (!this.closed) {
        this.publish();
        if (problem) this.port.report(kind, problem);
        // 重新读取真实状态，覆盖响应丢失及并发页面控制；不以失败响应推断事务未提交。
        this.dirty = true; await this.refresh(); this.publish();
      }
    }
  }
  freeze() { if (this.closed) return; this.closed = true; this.invalidate(); }
  async stop() { this.freeze(); await Promise.allSettled([...(this.reading ? [this.reading] : []), ...this.writing]); }
}
