import { createHash, randomUUID } from "node:crypto";
import { DesktopError, type CoreInput, type CoreOutput, type RecognitionBatch } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import { compareRecognitionPaths } from "./recognition-edits.js";
export type BatchAvailability = { state: "READY" } | { state: "WAIT" | "FAILED"; reason: string };
interface BatchPorts {
  capture(id: string): { relativePath: string; context: string };
  availability(id: string, context: string): BatchAvailability;
  recognize(id: string, requestKey: string): Promise<{ taskId: string }>;
}
interface Job { id: string; request_key: string; signature: string; cancelled: number; created_at: string; updated_at: string }
interface Item { batch_id: string; candidate_id: string; request_key: string; context_json: string; relative_path: string; state: "PENDING" | "SUBMITTED" | "FAILED"; task_id: string | null; failure: string | null; waiting_reason: string | null; ordinal: number }

/** 持久化的是提交识别的意图，网络匹配沿原任务运行；取消不撤销已提交任务。 */
export class RecognitionBatches {
  private timer?: ReturnType<typeof setInterval>; private flight?: Promise<void>; private closed = false;
  constructor(private readonly database: CoreDatabase, private readonly ports: BatchPorts, private readonly now = Date.now) {}
  private stamp() { return new Date(this.now()).toISOString(); }
  start() { if (!this.timer && !this.closed) this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 500); }
  create(input: CoreInput<"ingestion.recognize-batch">): RecognitionBatch {
    if (this.closed) throw new DesktopError("INTERRUPTED", "批量识别服务正在停止，请等待核心恢复");
    const ids = [...new Set(input.candidateIds)]; if (ids.length !== input.candidateIds.length) throw new DesktopError("CONFLICT", "同一候选被重复选择，请取消重复项后提交");
    const db = this.database.connection, signature = createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex"), prior = db.prepare("SELECT id,signature FROM ingestion_recognition_batch WHERE request_key=?").get(input.requestKey) as { id: string; signature: string } | undefined;
    if (prior) { if (prior.signature !== signature) throw new DesktopError("CONFLICT", "请求标识已用于另一组候选，请刷新后重新选择"); return this.get(prior.id); }
    const members = ids.map((id) => ({ id, ...this.ports.capture(id) })).sort((a, b) => compareRecognitionPaths(a.relativePath, b.relativePath) || a.id.localeCompare(b.id));
    const id = randomUUID(), stamp = this.stamp();
    db.transaction(() => {
      db.prepare("INSERT INTO ingestion_recognition_batch VALUES(?,?,?,0,?,?)").run(id, input.requestKey, signature, stamp, stamp);
      for (const [index, member] of members.entries()) db.prepare("INSERT INTO ingestion_recognition_batch_item(batch_id,candidate_id,request_key,context_json,relative_path,state,ordinal) VALUES(?,?,?,?,?,'PENDING',?)").run(id, member.id, randomUUID(), member.context, member.relativePath, index);
    })();
    return this.get(id);
  }
  private job(id: string) { const row = this.database.connection.prepare("SELECT * FROM ingestion_recognition_batch WHERE id=?").get(id) as Job | undefined; if (!row) throw new DesktopError("CONFLICT", "识别批次不存在，请刷新批次列表"); return row; }
  get(id: string): RecognitionBatch {
    const job = this.job(id), rows = this.rows(id), submitted = rows.filter((row) => row.state === "SUBMITTED").length, pending = rows.filter((row) => row.state === "PENDING").length;
    const failed = rows.filter((row) => row.state === "FAILED").length, recognitionFailed = rows.filter((row) => row.task_id && this.taskFailure(row.task_id)).length;
    return { id, total: rows.length, submitted, pending, failed, recognitionFailed, state: job.cancelled ? "CANCELLED" : pending ? "PENDING" : failed || recognitionFailed ? "PARTIAL_FAILED" : "SUBMITTED", createdAt: job.created_at, updatedAt: job.updated_at };
  }
  private taskFailure(id: string) { const row = this.database.connection.prepare("SELECT t.status,c.reason FROM media_task t JOIN ingestion_candidate c ON c.task_id=t.id WHERE t.id=?").get(id) as { status: string; reason: string | null } | undefined; return row && ["AWAITING_CONFIRMATION", "FAILED"].includes(row.status) ? row.reason : null; }
  private rows(id: string) { return this.database.connection.prepare("SELECT * FROM ingestion_recognition_batch_item WHERE batch_id=? ORDER BY ordinal").all(id) as Item[]; }
  list(input: CoreInput<"ingestion.recognition-batches">) { const db = this.database.connection; return { items: (db.prepare("SELECT id FROM ingestion_recognition_batch ORDER BY created_at DESC,id LIMIT 25 OFFSET ?").all(((input.page ?? 1) - 1) * 25) as { id: string }[]).map((row) => this.get(row.id)), total: (db.prepare("SELECT count(*) AS n FROM ingestion_recognition_batch").get() as { n: number }).n }; }
  items(input: CoreInput<"ingestion.recognition-batch-items">): CoreOutput<"ingestion.recognition-batch-items"> {
    const job = this.job(input.id), rows = this.rows(input.id);
    return { total: rows.length, items: rows.slice(((input.page ?? 1) - 1) * 100, (input.page ?? 1) * 100).map((row) => {
      const task = row.task_id ? this.database.connection.prepare("SELECT status FROM media_task WHERE id=?").get(row.task_id) as { status: string } | undefined : null;
      return { candidateId: row.candidate_id, relativePath: row.relative_path, state: row.state, taskId: row.task_id, taskState: task?.status ?? null, failure: row.failure ?? (row.task_id ? this.taskFailure(row.task_id) : null), waitingReason: row.state === "PENDING" && job.cancelled ? "批次已取消，此项未提交；已提交的任务保留" : row.waiting_reason };
    }) };
  }
  cancel(id: string) { if (this.closed) throw new DesktopError("INTERRUPTED", "识别服务正在停止"); this.job(id); this.database.connection.prepare("UPDATE ingestion_recognition_batch SET cancelled=1,updated_at=? WHERE id=?").run(this.stamp(), id); return this.get(id); }
  private assess(row: Item): BatchAvailability { try { return this.ports.availability(row.candidate_id, row.context_json); } catch (error) { return { state: "FAILED", reason: error instanceof DesktopError ? error.message.slice(0, 500) : "候选状态无法核对，请刷新来源并重新选择；原文件保留" }; } }
  tick(): Promise<void> { if (this.closed) return Promise.resolve(); return this.flight ??= this.run().finally(() => { this.flight = undefined; }); }
  private async run() {
    const db = this.database.connection, rows = db.prepare("SELECT i.* FROM ingestion_recognition_batch_item i JOIN ingestion_recognition_batch b ON b.id=i.batch_id WHERE b.cancelled=0 AND i.state='PENDING' AND i.next_attempt_at<=? ORDER BY i.next_attempt_at,b.created_at,b.id,i.ordinal LIMIT 100").all(this.now()) as Item[];
    let attempted = 0;
    for (const row of rows) {
      if (this.closed) return; if (this.job(row.batch_id).cancelled) continue;
      const available = this.assess(row);
      if (available.state !== "READY") { db.prepare("UPDATE ingestion_recognition_batch_item SET state=?,failure=?,waiting_reason=?,next_attempt_at=? WHERE batch_id=? AND candidate_id=?").run(available.state === "FAILED" ? "FAILED" : "PENDING", available.state === "FAILED" ? available.reason : null, available.state === "WAIT" ? available.reason : null, this.now() + 5000, row.batch_id, row.candidate_id); continue; }
      if (++attempted > 4) break;
      try {
        const result = await this.ports.recognize(row.candidate_id, row.request_key);
        // 即使用户在等待期间取消，也记下已提交的原任务，不将它隐藏或再次领取。
        db.prepare("UPDATE ingestion_recognition_batch_item SET state='SUBMITTED',task_id=?,failure=NULL,waiting_reason=NULL WHERE batch_id=? AND candidate_id=?").run(result.taskId, row.batch_id, row.candidate_id);
      } catch (error) {
        const claimed = db.prepare("SELECT task_id FROM ingestion_candidate WHERE id=?").get(row.candidate_id) as { task_id: string | null };
        if (claimed?.task_id) {
          db.prepare("UPDATE ingestion_recognition_batch_item SET task_id=?,waiting_reason='原识别任务已提交，等待补记本批次；不会重复创建任务',next_attempt_at=? WHERE batch_id=? AND candidate_id=?").run(claimed.task_id, this.now() + 5000, row.batch_id, row.candidate_id);
          continue;
        }
        const latest = this.assess(row), waiting = latest.state === "WAIT" || error instanceof DesktopError && ["LOCAL_UNAVAILABLE", "INTERRUPTED"].includes(error.code);
        const failure = error instanceof DesktopError ? error.message.slice(0, 500) : "此文件的识别提交未完成，请检查来源状态后重新选择；原文件保留";
        db.prepare("UPDATE ingestion_recognition_batch_item SET state=?,failure=?,waiting_reason=?,next_attempt_at=? WHERE batch_id=? AND candidate_id=?").run(waiting ? "PENDING" : "FAILED", waiting ? null : failure, waiting ? latest.state === "WAIT" ? latest.reason : failure : null, this.now() + 5000, row.batch_id, row.candidate_id);
      }
      db.prepare("UPDATE ingestion_recognition_batch SET updated_at=? WHERE id=?").run(this.stamp(), row.batch_id);
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.flight?.catch(() => {}); }
}
