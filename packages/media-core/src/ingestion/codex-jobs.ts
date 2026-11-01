import { randomUUID } from "node:crypto";
import { DesktopError, type CoreInput, type CodexJob } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { ParsedMedia } from "../domain/media.js";
import { previewFailure } from "./preview-errors.js";
import { sourceFileFailure } from "./source-file-failure.js";

export interface CodexMember { taskId: string; candidateId: string; relativePath: string; context: string; revision: number; parsed: ParsedMedia }
interface StoredJob extends CodexJob { members: CodexMember[]; signature: string; nextAttempt: number }
export interface CodexJobPorts {
  capture(taskId: string, directory: boolean): CodexMember[];
  run(job: CodexJob, members: CodexMember[], signal: AbortSignal, progress: (item: CodexJob["items"][number]) => void): Promise<void>;
}
const prefix = "recognition.codex.job.";

/** 作业事实存于Core业务库；只读查询、重复请求与页面卸载都不重新发起模型调用。 */
export class CodexJobs {
  private flight?: Promise<void>;
  private controller?: AbortController;
  private active?: string;
  private closed = false;
  constructor(private readonly database: CoreDatabase, private readonly ports: CodexJobPorts, private readonly now = Date.now) {
    for (const job of this.activeJobs()) if (job.state === "RUNNING") { job.state = "PENDING"; job.failure = "核心已重启，等待原目录授权恢复后继续"; job.nextAttempt = 0; this.write(job); }
  }
  private activeJobs(): StoredJob[] { return (this.database.connection.prepare("SELECT value FROM app_setting WHERE key LIKE ? AND json_extract(value,'$.state') IN ('PENDING','RUNNING') ORDER BY json_extract(value,'$.nextAttempt'),json_extract(value,'$.createdAt'),key").all(prefix + "%") as { value: string }[]).map((row) => JSON.parse(row.value)); }
  private read(id: string) { const row = this.database.connection.prepare("SELECT value FROM app_setting WHERE key=?").get(prefix + id) as { value: string } | undefined; if (!row) throw new DesktopError("CONFLICT", "Codex 识别作业不存在，请刷新记录"); return JSON.parse(row.value) as StoredJob; }
  private write(job: StoredJob) { job.updatedAt = new Date(this.now()).toISOString(); this.database.connection.prepare("INSERT INTO app_setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(prefix + job.id, JSON.stringify(job)); }
  private dto(job: StoredJob): CodexJob { const { members: _members, signature: _signature, nextAttempt: _nextAttempt, ...result } = job; return result; }
  get(id: string) { return this.dto(this.read(id)); }
  list(page = 1) { const db = this.database.connection; return { total: (db.prepare("SELECT count(*) AS n FROM app_setting WHERE key LIKE ?").get(prefix + "%") as { n: number }).n, items: (db.prepare("SELECT value FROM app_setting WHERE key LIKE ? ORDER BY json_extract(value,'$.createdAt') DESC,key DESC LIMIT 25 OFFSET ?").all(prefix + "%", (page - 1) * 25) as { value: string }[]).map((row) => this.dto(JSON.parse(row.value))) }; }
  enqueue(input: CoreInput<"codex.rematch">, kick = true) {
    if (this.closed) throw new DesktopError("INTERRUPTED", "Codex 识别服务正在停止");
    const directory = input.directory ?? false, organize = input.organize ?? true;
    const signature = JSON.stringify([input.taskId, directory, organize]);
    const old = this.database.connection.prepare("SELECT value FROM app_setting WHERE key=?").get("recognition.codex.request." + input.requestKey) as { value: string } | undefined;
    if (old) { const prior = JSON.parse(old.value) as { id: string; signature: string }; if (prior.signature !== signature) throw new DesktopError("CONFLICT", "Codex 请求标识已用于其他范围，请刷新后重试"); return this.get(prior.id); }
    const members = this.ports.capture(input.taskId, directory), stamp = new Date(this.now()).toISOString();
    const same = this.activeJobs().find((job) => job.signature === signature);
    const job: StoredJob = same ?? { id: randomUUID(), taskId: input.taskId, directory, organize, state: "PENDING", items: members.map((member) => ({ taskId: member.taskId, relativePath: member.relativePath, state: "PENDING", failure: null, operationId: null })), failure: null, createdAt: stamp, updatedAt: stamp, members, signature, nextAttempt: 0 };
    this.database.connection.transaction(() => {
      if (!same) this.write(job);
      this.database.connection.prepare("INSERT INTO app_setting(key,value) VALUES(?,?)").run("recognition.codex.request." + input.requestKey, JSON.stringify({ id: job.id, signature }));
    })();
    if (kick) void this.tick().catch(() => {}); return this.dto(job);
  }
  cancel(id: string) { const job = this.read(id); if (["PENDING", "RUNNING"].includes(job.state)) { job.state = "CANCELLED"; job.failure = "已停止尚未提交的识别；已更新信息和已提交文件任务保留"; this.write(job); if (this.active === id) this.controller?.abort(); } return this.get(id); }
  tick(): Promise<void> { if (this.closed) return Promise.resolve(); return this.flight ??= this.run().finally(() => { this.flight = undefined; }); }
  private async run() {
    for (const saved of this.activeJobs().filter((job) => job.state === "PENDING" && job.nextAttempt <= this.now()).slice(0, 4)) {
      if (this.closed) return;
      const controller = new AbortController(); this.controller = controller; this.active = saved.id;
      saved.state = "RUNNING"; saved.failure = null; this.write(saved);
      try {
        await this.ports.run(this.dto(saved), saved.members, controller.signal, (item) => {
          const latest = this.read(saved.id), index = latest.items.findIndex((entry) => entry.taskId === item.taskId);
          if (index >= 0) { latest.items[index] = item; this.write(latest); }
        });
        const latest = this.read(saved.id); if (latest.state === "CANCELLED") continue;
        latest.state = latest.items.some((item) => item.state === "FAILED" || item.state === "SKIPPED" || item.failure) ? "PARTIAL_FAILED" : "COMPLETED";
        this.write(latest);
      } catch (error) {
        const latest = this.read(saved.id); if (latest.state === "CANCELLED") continue;
        const waiting = this.closed || error instanceof DesktopError && ["LOCAL_UNAVAILABLE", "INTERRUPTED"].includes(error.code);
        latest.state = waiting ? "PENDING" : "FAILED"; latest.nextAttempt = this.now() + 5000;
        const failure = previewFailure(error);
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        latest.failure = failure instanceof DesktopError ? failure.message.slice(0, 500) : ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ENODEV", "ENXIO", "ESTALE", "EIO"].includes(code) ? sourceFileFailure(error) : "Codex 识别未完成，请检查 CLI 登录状态、网络及原目录后重试";
        this.write(latest);
      } finally { this.controller = undefined; this.active = undefined; }
    }
  }
  async close() { this.closed = true; this.controller?.abort(); await this.flight?.catch(() => {}); }
}
