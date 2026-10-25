import { randomUUID } from "node:crypto";
import { correctionActions, publicError, type CoreInput, type CoreOutput, type CorrectionBatch, type CorrectionOperation, type CorrectionPreview } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { CorrectionTaskSnapshot } from "../domain/correction-scope.js";
import { correctionConflict, correctionHash } from "./correction-assets.js";
import { captureCorrectionScope } from "./correction-batch-scope.js";
import type { PreparationProgress } from "./correction-preparations.js";
import { previewFailure } from "./preview-errors.js";

interface BatchRow { id: string; input_hash: string; input_json: string; anchor_task_id: string; scope: "SAME_SEASON" | "SAME_SERIES"; fingerprint: string; generation: string; state: "PREVIEWING" | "READY" | "BLOCKED" | "CONFIRMING" | "SUBMITTED" | "CANCELED" | "INTERRUPTED"; expires_at: number | null; accepted_at: number | null; failure_json: string | null; current_task_id: string | null; current_path: string | null; read_bytes: number; total_bytes: number; created_at: string; updated_at: string }
interface MemberRow { task_id: string; selected: number; snapshot_json: string; preview_key: string; confirm_key: string; preview_id: string | null; operation_id: string | null; failure_json: string | null }
export interface BatchConfirmationMember { taskId: string; previewId: string; confirmKey: string }
interface Ports {
  available(): void;
  preview(input: CoreInput<"corrections.preview">, signal: AbortSignal, progress: (value: PreparationProgress) => void): Promise<CorrectionPreview>;
  previewMappings(previewIds: string[]): void;
  confirm(id: string, members: BatchConfirmationMember[], acceptedAt: number, signal: AbortSignal, progress: (taskId: string, value: PreparationProgress) => void, guard: () => void, record: (operations: CorrectionOperation[]) => void): Promise<void>;
  operation(id: string): CorrectionOperation;
}
const active = "state IN ('PREVIEWING','CONFIRMING')";
const failureText = (json: string | null): string | null => json ? (JSON.parse(json) as { message: string }).message : null;

/** 批次有独立持久收据；后台只核验，所有成员意图共同受理后才允许单条执行器操作文件。 */
export class CorrectionBatches {
  private readonly generation = randomUUID();
  private flight?: Promise<void>;
  private scheduled?: ReturnType<typeof setImmediate>;
  private running?: { id: string; controller: AbortController };
  private closed = false;
  constructor(private readonly database: CoreDatabase, private readonly ports: Ports, private readonly now = Date.now) {
    // 原子受理已提交的批次为 SUBMITTED；其余长核验中断，不重放用户确认。
    database.connection.prepare(`UPDATE media_correction_batch SET state='INTERRUPTED',failure_json=?,updated_at=? WHERE ${active}`).run(this.failure(correctionConflict("核心已中断批量核验，请查看原批次记录并重新预览；未自动重放确认")), this.stamp());
  }
  private stamp() { return new Date(this.now()).toISOString(); }
  private failure(error: unknown) { const value = publicError(previewFailure(error)); return JSON.stringify({ code: value.code, message: value.message.slice(0, 500), retryable: value.retryable }); }
  private writable() { if (this.closed) throw correctionConflict("批量修正正在停止，请查询原批次后重试"); }
  private row(id: string) { const row = this.database.connection.prepare("SELECT * FROM media_correction_batch WHERE id=?").get(id) as BatchRow | undefined; if (!row) throw correctionConflict("批量修正不存在，请刷新作业列表"); return row; }
  private members(id: string) { return this.database.connection.prepare("SELECT * FROM media_correction_batch_member WHERE batch_id=? ORDER BY ordinal").all(id) as MemberRow[]; }
  private scopeUnchanged(row: BatchRow) { if (captureCorrectionScope(this.database, row.anchor_task_id, row.scope).fingerprint !== row.fingerprint) throw correctionConflict("批量修正的成员、版本或来源策略已经变化，请重新预览完整范围"); }
  create(raw: CoreInput<"corrections.preview-batch">): CorrectionBatch {
    this.writable(); const input = correctionActions["corrections.preview-batch"].input.parse(raw), hash = correctionHash(input), db = this.database.connection;
    const old = db.prepare("SELECT id,input_hash FROM media_correction_batch WHERE request_key=?").get(input.requestKey) as { id: string; input_hash: string } | undefined;
    if (old) { if (old.input_hash !== hash) throw correctionConflict("批量预览请求标识已用于不同内容"); return this.get(old.id); }
    this.ports.available();
    if ((db.prepare(`SELECT count(*) AS n FROM media_correction_batch WHERE ${active}`).get() as { n: number }).n >= 16) throw correctionConflict("批量修正核验队列已有 16 项，请等待或取消原批次后重试");
    const resolved = captureCorrectionScope(this.database, input.taskId, input.scope), excluded = new Set(input.excludedTaskIds);
    if (excluded.size !== input.excludedTaskIds.length || [...excluded].some((id) => !resolved.members.some((member) => member.id === id))) throw correctionConflict("排除项重复或不属于完整修正范围，请重新选择");
    if (resolved.members.every((member) => excluded.has(member.id))) throw correctionConflict("至少保留一个成员用于批量修正");
    const id = randomUUID(), time = this.stamp();
    db.transaction(() => {
      db.prepare("INSERT INTO media_correction_batch(id,request_key,input_hash,input_json,anchor_task_id,scope,generation,fingerprint,scope_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'PREVIEWING',?,?)").run(id, input.requestKey, hash, JSON.stringify(input), input.taskId, input.scope, this.generation, resolved.fingerprint, resolved.evidence, time, time);
      for (const [ordinal, member] of resolved.members.entries()) {
        const blockers = resolved.blockers.find((item) => item.taskId === member.id)?.reasons;
        db.prepare("INSERT INTO media_correction_batch_member(batch_id,task_id,ordinal,selected,snapshot_json,preview_key,confirm_key,failure_json) VALUES(?,?,?,?,?,?,?,?)").run(id, member.id, ordinal, Number(!excluded.has(member.id)), JSON.stringify(member), randomUUID(), randomUUID(), blockers?.length ? this.failure(correctionConflict(blockers.join("；"))) : null);
      }
    })(); this.kick(); return this.get(id);
  }
  get(id: string): CorrectionBatch {
    const row = this.row(id), selected = this.members(id).filter((item) => item.selected), operations = selected.filter((item) => item.operation_id).map((item) => this.ports.operation(item.operation_id!)), done = operations.filter((op) => op.state === "RECORDED" && !op.failure).length, failed = operations.filter((op) => op.state === "NEEDS_ATTENTION" || op.failure).length;
    const state = row.state === "SUBMITTED" ? failed ? "PARTIAL_FAILED" : done === selected.length ? "DONE" : "SUBMITTED" : row.state === "READY" && (row.expires_at! <= this.now() || row.generation !== this.generation) ? "EXPIRED" : row.state;
    return { id, anchorTaskId: row.anchor_task_id, scope: row.scope, state, fingerprint: row.fingerprint, total: this.members(id).length, selected: selected.length, previewed: selected.filter((item) => item.preview_id).length, submitted: operations.length, done, failed: failed + selected.filter((item) => item.failure_json).length, expiresAt: row.expires_at, failure: failureText(row.failure_json), currentTaskId: row.current_task_id, currentPath: row.current_path, readBytes: row.read_bytes, totalBytes: row.total_bytes, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list(input: CoreInput<"corrections.batches">): CoreOutput<"corrections.batches"> { const db = this.database.connection; return { items: (db.prepare("SELECT id FROM media_correction_batch ORDER BY created_at DESC,id LIMIT 25 OFFSET ?").all(((input.page ?? 1) - 1) * 25) as { id: string }[]).map((row) => this.get(row.id)), total: (db.prepare("SELECT count(*) AS n FROM media_correction_batch").get() as { n: number }).n }; }
  details(input: CoreInput<"corrections.batch">): CoreOutput<"corrections.batch"> {
    const page = input.page ?? 1; return { batch: this.get(input.id), page, items: this.members(input.id).slice((page - 1) * 25, page * 25).map((item) => { const snapshot = JSON.parse(item.snapshot_json) as CorrectionTaskSnapshot; return { taskId: item.task_id, selected: !!item.selected, targetPath: snapshot.targetPath, selection: { tmdbId: snapshot.tmdbId!, mediaType: "TV_SHOW", season: snapshot.season, episode: snapshot.episode, episodeEnd: snapshot.episodeEnd }, previewId: item.preview_id, operation: item.operation_id ? this.ports.operation(item.operation_id) : null, failure: failureText(item.failure_json) }; }) };
  }
  confirm(raw: CoreInput<"corrections.confirm-batch">) {
    this.writable(); const input = correctionActions["corrections.confirm-batch"].input.parse(raw), db = this.database.connection, row = this.row(input.id);
    if (row.fingerprint !== input.fingerprint) throw correctionConflict("确认指纹与批次范围不符，请核对原批次");
    const old = db.prepare("SELECT batch_id FROM media_correction_batch_confirmation WHERE request_key=?").get(input.requestKey) as { batch_id: string } | undefined;
    if (old) { if (old.batch_id !== input.id) throw correctionConflict("确认请求标识已用于另一批次"); return this.get(input.id); }
    db.transaction(() => {
      if (!["SUBMITTED", "CONFIRMING"].includes(row.state)) {
        this.ports.available(); if (row.state !== "READY" || row.expires_at! <= this.now() || row.generation !== this.generation) throw correctionConflict("批量修正未完整预览或已过期，请重新预览");
        this.scopeUnchanged(row); db.prepare("UPDATE media_correction_batch SET state='CONFIRMING',accepted_at=?,updated_at=? WHERE id=?").run(this.now(), this.stamp(), input.id);
      }
      db.prepare("INSERT INTO media_correction_batch_confirmation VALUES(?,?)").run(input.requestKey, input.id);
    })(); this.kick(); return this.get(input.id);
  }
  cancel(id: string) { this.writable(); const row = this.row(id); if (!["SUBMITTED"].includes(row.state)) { this.database.connection.prepare("UPDATE media_correction_batch SET state='CANCELED',updated_at=? WHERE id=?").run(this.stamp(), id); if (this.running?.id === id) this.running.controller.abort(); } return this.get(id); }
  private kick() { if (!this.closed && !this.flight && !this.scheduled) this.scheduled = setImmediate(() => { this.scheduled = undefined; void this.tick().catch(() => {}); }); }
  tick(): Promise<void> { if (this.closed) return Promise.resolve(); return this.flight ??= this.run().finally(() => { this.flight = undefined; if (!this.closed && this.database.connection.prepare(`SELECT 1 FROM media_correction_batch WHERE ${active}`).get()) this.kick(); }); }
  private async run() {
    const db = this.database.connection;
    for (const row of db.prepare(`SELECT * FROM media_correction_batch WHERE ${active} ORDER BY CASE state WHEN 'CONFIRMING' THEN 0 ELSE 1 END,created_at,id LIMIT 16`).all() as BatchRow[]) {
      if (this.closed) return;
      const controller = new AbortController(); this.running = { id: row.id, controller };
      let lastTime = -Infinity, lastPath: string | null = null;
      const progress = (taskId: string, value: PreparationProgress) => { if (controller.signal.aborted || this.closed) return; const time = performance.now(); if (lastPath === value.currentPath && value.readBytes !== value.totalBytes && time - lastTime < 500) return; db.prepare("UPDATE media_correction_batch SET current_task_id=?,current_path=?,read_bytes=?,total_bytes=?,updated_at=? WHERE id=?").run(taskId, value.currentPath, value.readBytes, value.totalBytes, this.stamp(), row.id); lastTime = time; lastPath = value.currentPath; };
      const guard = () => { controller.signal.throwIfAborted(); this.writable(); if (this.row(row.id).state !== row.state) throw correctionConflict("批量核验状态已变化，请重新读取原批次"); this.scopeUnchanged(row); };
      try {
        guard(); const input = JSON.parse(row.input_json) as CoreInput<"corrections.preview-batch">;
        if (row.state === "PREVIEWING") {
          for (const member of this.members(row.id).filter((item) => item.selected)) {
            guard(); if (member.failure_json) continue;
            const snapshot = JSON.parse(member.snapshot_json) as CorrectionTaskSnapshot;
            try { const preview = await this.ports.preview({ taskId: member.task_id, requestKey: member.preview_key, selection: { tmdbId: input.tmdbId, mediaType: "TV_SHOW", season: snapshot.season, episode: snapshot.episode, episodeEnd: snapshot.episodeEnd }, targetId: input.targetId, template: input.template, includeAccessories: input.includeAccessories }, controller.signal, (value) => progress(member.task_id, value)); guard(); db.prepare("UPDATE media_correction_batch_member SET preview_id=? WHERE batch_id=? AND task_id=?").run(preview.id, row.id, member.task_id); }
            catch (error) { controller.signal.throwIfAborted(); db.prepare("UPDATE media_correction_batch_member SET failure_json=? WHERE batch_id=? AND task_id=?").run(this.failure(error), row.id, member.task_id); }
          }
          guard(); const members = this.members(row.id).filter((item) => item.selected), blocked = members.some((item) => item.failure_json || !item.preview_id);
          if (!blocked) this.ports.previewMappings(members.map((item) => item.preview_id!));
          const expires = this.now() + 600000;
          db.transaction(() => { guard(); if (!blocked) for (const member of members) db.prepare("UPDATE media_correction_preview SET expires_at=? WHERE id=?").run(expires, member.preview_id); db.prepare("UPDATE media_correction_batch SET state=?,expires_at=?,updated_at=? WHERE id=?").run(blocked ? "BLOCKED" : "READY", expires, this.stamp(), row.id); })();
        } else {
          const members = this.members(row.id).filter((item) => item.selected).map((item) => ({ taskId: item.task_id, previewId: item.preview_id!, confirmKey: item.confirm_key }));
          await this.ports.confirm(row.id, members, row.accepted_at!, controller.signal, progress, guard, (operations) => {
            guard(); for (const op of operations) db.prepare("UPDATE media_correction_batch_member SET operation_id=? WHERE batch_id=? AND task_id=?").run(op.id, row.id, op.originalTaskId);
            db.prepare("UPDATE media_correction_batch SET state='SUBMITTED',failure_json=NULL,updated_at=? WHERE id=?").run(this.stamp(), row.id);
          });
        }
      } catch (error) { if (this.row(row.id).state === row.state) db.prepare("UPDATE media_correction_batch SET state=?,failure_json=?,updated_at=? WHERE id=?").run(this.closed ? "INTERRUPTED" : "BLOCKED", this.failure(error), this.stamp(), row.id); }
      finally { this.running = undefined; }
    }
    if (!this.closed && db.prepare(`SELECT 1 FROM media_correction_batch WHERE ${active}`).get()) this.kick();
  }
  async close() { this.closed = true; if (this.scheduled) clearImmediate(this.scheduled); this.running?.controller.abort(); await this.flight?.catch(() => {}); }
}
