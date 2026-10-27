import { randomUUID } from "node:crypto";
import { DesktopError, publicError, type CorrectionPreparation } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import { correctionHash } from "./correction-assets.js";

export type PreparationKind = "PREVIEW" | "CONFIRM";
export interface PreparationResult { previewId?: string; operationId?: string }
export interface PreparationProgress { currentPath: string; readBytes: number; totalBytes: number }
interface PreparationInput { requestKey: string }
interface PreparationHandlers {
  taskId(kind: PreparationKind, input: unknown): string;
  run(kind: PreparationKind, input: unknown, signal: AbortSignal, progress: (value: PreparationProgress) => void, acceptedAt: number): Promise<PreparationResult>;
  recover(kind: PreparationKind, input: unknown): PreparationResult | null;
}
interface Row { id: string; task_id: string; kind: PreparationKind; input_hash: string; input_json: string; state: CorrectionPreparation["state"]; preview_id: string | null; operation_id: string | null; current_path: string | null; read_bytes: number; total_bytes: number; failure_json: string | null; created_at: string; updated_at: string }
const active = "state IN ('PENDING','RUNNING','CANCELING')";

/** 持久收据和单执行器隔离大文件读取；取消只能停止核验，不能撤销已提交的文件作业。 */
export class CorrectionPreparations {
  private flight?: Promise<void>;
  private scheduled?: ReturnType<typeof setImmediate>;
  private running?: { id: string; controller: AbortController };
  private closed = false;
  private stopFlight?: Promise<void>;
  constructor(private readonly database: CoreDatabase, private readonly handlers: PreparationHandlers, private readonly now = Date.now) {
    const rows = database.connection.prepare(`SELECT * FROM media_correction_preparation WHERE ${active}`).all() as Row[];
    for (const row of rows) {
      const result = handlers.recover(row.kind, JSON.parse(row.input_json));
      this.finish(row.id, result ? "READY" : "INTERRUPTED", result, result ? null : new DesktopError("INTERRUPTED", "核心已中断此核验；请查看原预览或作业，再重新发起核验，不会自动重放确认", true));
    }
  }
  private stamp() { return new Date(this.now()).toISOString(); }
  private row(id: string) { const row = this.database.connection.prepare("SELECT * FROM media_correction_preparation WHERE id=?").get(id) as Row | undefined; if (!row) throw new DesktopError("CONFLICT", "修正核验不存在，请刷新后重新发起"); return row; }
  get(id: string): CorrectionPreparation { const row = this.row(id); return { id: row.id, taskId: row.task_id, kind: row.kind, state: row.state, previewId: row.preview_id, operationId: row.operation_id, currentPath: row.current_path, readBytes: row.read_bytes, totalBytes: row.total_bytes, failure: row.failure_json ? JSON.parse(row.failure_json) : null, createdAt: row.created_at, updatedAt: row.updated_at }; }
  forTask(taskId: string) { const row = this.database.connection.prepare(`SELECT id FROM media_correction_preparation WHERE task_id=? ORDER BY CASE WHEN ${active} THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 1`).get(taskId) as { id: string } | undefined; return row ? this.get(row.id) : null; }
  enqueue<Input extends PreparationInput>(kind: PreparationKind, input: Input): CorrectionPreparation {
    if (this.closed) throw new DesktopError("INTERRUPTED", "修正核验正在停止，请稍后查询原请求", true);
    const db = this.database.connection, { requestKey, ...content } = input, hash = correctionHash(content);
    const id = db.transaction(() => {
      const receipt = db.prepare("SELECT * FROM media_correction_preparation_request WHERE request_key=?").get(requestKey) as { kind: string; input_hash: string; preparation_id: string } | undefined;
      if (receipt) { if (receipt.kind !== kind || receipt.input_hash !== hash) throw new DesktopError("CONFLICT", "修正请求标识已用于其他核验内容"); return receipt.preparation_id; }
      const taskId = this.handlers.taskId(kind, input), current = db.prepare(`SELECT * FROM media_correction_preparation WHERE task_id=? AND ${active}`).get(taskId) as Row | undefined;
      if (current && (current.kind !== kind || current.input_hash !== hash)) throw new DesktopError("CONFLICT", "此文件已有其他修正核验，请查询或取消原核验后再提交");
      if (!current && (db.prepare(`SELECT count(*) AS n FROM media_correction_preparation WHERE ${active}`).get() as { n: number }).n >= 16) throw new DesktopError("CONFLICT", "修正核验队列已有 16 项，请等待或取消现有核验后再提交");
      const id = current?.id ?? randomUUID();
      if (!current) db.prepare("INSERT INTO media_correction_preparation(id,task_id,kind,input_hash,input_json,state,created_at,updated_at) VALUES(?,?,?,?,?,'PENDING',?,?)").run(id, taskId, kind, hash, JSON.stringify(input), this.stamp(), this.stamp());
      db.prepare("INSERT INTO media_correction_preparation_request VALUES(?,?,?,?)").run(requestKey, kind, hash, id); return id;
    })();
    const result = this.get(id); this.kick(); return result;
  }
  cancel(id: string) {
    const row = this.row(id); if (!["PENDING", "RUNNING", "CANCELING"].includes(row.state)) return this.get(id);
    if (row.state === "PENDING") this.finish(id, "CANCELED", null, null);
    else { this.database.connection.prepare("UPDATE media_correction_preparation SET state='CANCELING',updated_at=? WHERE id=?").run(this.stamp(), id); if (this.running?.id === id) this.running.controller.abort(); }
    return this.get(id);
  }
  private kick() { if (!this.closed && !this.flight && !this.scheduled) this.scheduled = setImmediate(() => { this.scheduled = undefined; void this.tick().catch(() => {}); }); }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve(); if (this.flight) return this.flight;
    let failed = false;
    return this.flight = this.run().catch((error) => { failed = true; throw error; }).finally(() => { this.flight = undefined; if (!this.closed && !failed && this.database.connection.prepare("SELECT 1 FROM media_correction_preparation WHERE state='PENDING'").get()) this.kick(); });
  }
  private finish(id: string, state: Row["state"], result: PreparationResult | null, error: unknown | null) {
    const failure = error === null ? null : publicError(error);
    this.database.connection.prepare("UPDATE media_correction_preparation SET state=?,preview_id=?,operation_id=?,failure_json=?,updated_at=? WHERE id=?").run(state, result?.previewId ?? null, result?.operationId ?? null, failure ? JSON.stringify({ code: failure.code, message: failure.message.slice(0, 500), retryable: failure.retryable }) : null, this.stamp(), id);
  }
  private async run() {
    while (!this.closed) {
      const row = this.database.connection.prepare("SELECT * FROM media_correction_preparation WHERE state='PENDING' ORDER BY CASE kind WHEN 'CONFIRM' THEN 0 ELSE 1 END,created_at,id LIMIT 1").get() as Row | undefined;
      if (!row) return;
      const controller = new AbortController(), input = JSON.parse(row.input_json); this.running = { id: row.id, controller };
      this.database.connection.prepare("UPDATE media_correction_preparation SET state='RUNNING',updated_at=? WHERE id=?").run(this.stamp(), row.id);
      let lastProgress = -Infinity, lastPath: string | null = null;
      const progress = (value: PreparationProgress) => {
        if (this.closed || controller.signal.aborted) return;
        const time = performance.now(); if (value.currentPath === lastPath && value.readBytes !== value.totalBytes && time - lastProgress < 500) return;
        this.database.connection.prepare("UPDATE media_correction_preparation SET current_path=?,read_bytes=?,total_bytes=?,updated_at=? WHERE id=?").run(value.currentPath, value.readBytes, value.totalBytes, this.stamp(), row.id); lastProgress = time; lastPath = value.currentPath;
      };
      try { const result = await this.handlers.run(row.kind, input, controller.signal, progress, Date.parse(row.created_at)); this.finish(row.id, "READY", result, null); }
      catch (error) {
        const result = this.handlers.recover(row.kind, input);
        if (result) this.finish(row.id, "READY", result, null);
        else if (this.closed) this.finish(row.id, "INTERRUPTED", null, new DesktopError("INTERRUPTED", "核验因核心停止而中断，请重新预览后确认", true));
        else if (controller.signal.aborted) this.finish(row.id, "CANCELED", null, null);
        else this.finish(row.id, "FAILED", null, error);
      } finally { this.running = undefined; }
    }
  }
  close(): Promise<void> { return this.stopFlight ??= this.stop(); }
  private async stop() {
    this.closed = true; if (this.scheduled) clearImmediate(this.scheduled); this.scheduled = undefined; this.running?.controller.abort(); await this.flight;
    for (const row of this.database.connection.prepare("SELECT id FROM media_correction_preparation WHERE state='PENDING'").all() as { id: string }[]) this.finish(row.id, "INTERRUPTED", null, new DesktopError("INTERRUPTED", "核心已停止排队核验，请重新预览后确认", true));
  }
}
