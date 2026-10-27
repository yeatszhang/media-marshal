import { randomUUID } from "node:crypto";
import { DesktopError, type ContentReview, type CoreInput, type CoreOutput } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";

interface ReviewRow { id: string; source_id: string; source_version: number; state: ContentReview["state"]; enumerated: number; failure: string | null; created_at: string; updated_at: string }
interface ReviewResult { state: "UNCHANGED" | "BASELINED" | "CHANGED"; candidateId: string; sha256: string }
interface ReviewFiles {
  check(sourceId: string, version: number): void;
  available(sourceId: string): Promise<void>;
  discover(sourceId: string): Promise<string[][]>;
  /** 流式读取在事务外；返回的同步提交与单项结果在同一事务记账。 */
  prepare(sourceId: string, version: number, relative: string[], signal: AbortSignal): Promise<() => ReviewResult>;
}
const active = "state IN ('PENDING','RUNNING','WAITING_SOURCE')";
const message = (error: unknown) => error instanceof DesktopError ? error.message.slice(0, 500) : "文件暂不能读取，请检查原磁盘和权限后重新复核";

/** 只读复核作业拥有自己的执行 Promise 和取消信号，不占用媒体 COPY 队列。 */
export class ContentReviews {
  private flight?: Promise<void>;
  private running?: { id: string; controller: AbortController };
  private closed = false;
  private wake = false;
  constructor(private readonly database: CoreDatabase, private readonly files: ReviewFiles, private readonly now = Date.now) {}
  private stamp() { return new Date(this.now()).toISOString(); }
  private row(id: string) {
    const row = this.database.connection.prepare("SELECT * FROM ingestion_content_review WHERE id=?").get(id) as ReviewRow | undefined;
    if (!row) throw new DesktopError("CONFLICT", "内容复核作业不存在，请刷新列表"); return row;
  }
  active(sourceId: string) { return !!this.database.connection.prepare(`SELECT 1 FROM ingestion_content_review WHERE source_id=? AND ${active}`).get(sourceId); }
  enqueue(sourceId: string, version: number, requestKey: string): ContentReview {
    if (this.closed) throw new DesktopError("INTERRUPTED", "内容复核正在停止", true);
    const db = this.database.connection;
    const id = db.transaction(() => {
      const receipt = db.prepare("SELECT * FROM ingestion_content_review_request WHERE request_key=?").get(requestKey) as { source_id: string; review_id: string } | undefined;
      if (receipt) { if (receipt.source_id !== sourceId) throw new DesktopError("CONFLICT", "内容复核请求标识已用于其他来源"); return receipt.review_id; }
      const old = db.prepare(`SELECT id FROM ingestion_content_review WHERE source_id=? AND ${active}`).get(sourceId) as { id: string } | undefined;
      const id = old?.id ?? randomUUID();
      if (!old) { this.files.check(sourceId, version); db.prepare("INSERT INTO ingestion_content_review(id,source_id,source_version,state,created_at,updated_at) VALUES(?,?,?,'PENDING',?,?)").run(id, sourceId, version, this.stamp(), this.stamp()); }
      db.prepare("INSERT INTO ingestion_content_review_request VALUES(?,?,?)").run(requestKey, sourceId, id); return id;
    })();
    const result = this.dto(this.row(id)); this.kick(); return result;
  }
  private dto(row: ReviewRow): ContentReview {
    const db = this.database.connection;
    const counts = db.prepare("SELECT count(*) AS total,count(CASE WHEN state!='PENDING' THEN 1 END) AS checked,count(CASE WHEN state='CHANGED' THEN 1 END) AS changed,count(CASE WHEN state='BASELINED' THEN 1 END) AS baselined,count(CASE WHEN state='FAILED' THEN 1 END) AS failed FROM ingestion_content_review_file WHERE review_id=?").get(row.id) as Pick<ContentReview, "total" | "checked" | "changed" | "baselined" | "failed">;
    const current = db.prepare("SELECT relative_json FROM ingestion_content_review_file WHERE review_id=? AND state='PENDING' ORDER BY relative_json LIMIT 1").get(row.id) as { relative_json: string } | undefined;
    return { id: row.id, sourceId: row.source_id, sourceVersion: row.source_version, state: row.state, ...counts, currentPath: current && ["PENDING", "RUNNING", "WAITING_SOURCE"].includes(row.state) ? (JSON.parse(current.relative_json) as string[]).join("/") : null, failure: row.failure, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list(input: CoreInput<"ingestion.content-reviews">): CoreOutput<"ingestion.content-reviews"> {
    const db = this.database.connection;
    return { total: (db.prepare("SELECT count(*) AS n FROM ingestion_content_review").get() as { n: number }).n, items: (db.prepare("SELECT * FROM ingestion_content_review ORDER BY created_at DESC,rowid DESC LIMIT 25 OFFSET ?").all(((input.page ?? 1) - 1) * 25) as ReviewRow[]).map((row) => this.dto(row)) };
  }
  items(input: CoreInput<"ingestion.content-review-files">): CoreOutput<"ingestion.content-review-files"> {
    this.row(input.id); const db = this.database.connection;
    const rows = db.prepare("SELECT * FROM ingestion_content_review_file WHERE review_id=? ORDER BY CASE state WHEN 'FAILED' THEN 0 WHEN 'CHANGED' THEN 1 ELSE 2 END,relative_json LIMIT 100 OFFSET ?").all(input.id, ((input.page ?? 1) - 1) * 100) as { relative_json: string; state: CoreOutput<"ingestion.content-review-files">["items"][number]["state"]; candidate_id: string | null; failure: string | null }[];
    return { total: (db.prepare("SELECT count(*) AS n FROM ingestion_content_review_file WHERE review_id=?").get(input.id) as { n: number }).n, items: rows.map((row) => ({ relativePath: (JSON.parse(row.relative_json) as string[]).join("/"), state: row.state, candidateId: row.candidate_id, failure: row.failure })) };
  }
  cancel(id: string) {
    if (this.closed) throw new DesktopError("INTERRUPTED", "内容复核正在停止", true);
    const db = this.database.connection; this.row(id);
    db.prepare(`UPDATE ingestion_content_review SET state='CANCELLED',failure='已取消；已完成的复核结果保留，未完成文件未判定为通过',updated_at=? WHERE id=? AND ${active}`).run(this.stamp(), id);
    if (this.running?.id === id) this.running.controller.abort(); return this.dto(this.row(id));
  }
  interrupt(sourceId?: string) { if (this.running && (!sourceId || this.row(this.running.id).source_id === sourceId)) this.running.controller.abort(); }
  kick() {
    if (this.closed) return;
    if (this.flight) { this.wake = true; return; }
    const flight = this.run().finally(() => { if (this.flight === flight) this.flight = undefined; if (this.wake) { this.wake = false; this.kick(); } });
    this.flight = flight; void flight.catch(() => {});
  }
  async idle() { while (this.flight) await this.flight; }
  private async run() {
    const db = this.database.connection;
    let progressed = true;
    while (!this.closed && progressed) {
      progressed = false;
      const jobs = db.prepare(`SELECT * FROM ingestion_content_review WHERE ${active} ORDER BY created_at,id`).all() as ReviewRow[];
      for (const job of jobs) {
        if (this.closed) return;
        const controller = new AbortController(); this.running = { id: job.id, controller };
        try {
          this.files.check(job.source_id, job.source_version);
          await this.files.available(job.source_id);
          if (this.closed || controller.signal.aborted || this.row(job.id).state === "CANCELLED") continue;
          if (!job.enumerated) {
            const paths = await this.files.discover(job.source_id);
            if (this.closed || this.row(job.id).state === "CANCELLED") continue;
            db.transaction(() => {
              this.files.check(job.source_id, job.source_version);
              for (const path of paths) db.prepare("INSERT OR IGNORE INTO ingestion_content_review_file(review_id,relative_json,state) VALUES(?,?,'PENDING')").run(job.id, JSON.stringify(path));
              db.prepare("UPDATE ingestion_content_review SET enumerated=1,state='RUNNING',failure=NULL,updated_at=? WHERE id=?").run(this.stamp(), job.id);
            })();
          }
          const file = db.prepare("SELECT relative_json FROM ingestion_content_review_file WHERE review_id=? AND state='PENDING' ORDER BY relative_json LIMIT 1").get(job.id) as { relative_json: string } | undefined;
          if (!file) {
            const result = this.dto(this.row(job.id));
            db.prepare("UPDATE ingestion_content_review SET state=?,failure=?,updated_at=? WHERE id=?").run(result.failed ? "PARTIAL_FAILED" : "COMPLETED", result.failed ? "部分文件未能复核，请展开结果核对文件并重新发起复核" : null, this.stamp(), job.id); progressed = true; continue;
          }
          db.prepare("UPDATE ingestion_content_review SET state='RUNNING',failure=NULL,updated_at=? WHERE id=?").run(this.stamp(), job.id);
          try {
            const apply = await this.files.prepare(job.source_id, job.source_version, JSON.parse(file.relative_json), controller.signal);
            if (this.closed || controller.signal.aborted || this.row(job.id).state === "CANCELLED") continue;
            db.transaction(() => {
              this.files.check(job.source_id, job.source_version);
              const result = apply();
              db.prepare("UPDATE ingestion_content_review_file SET state=?,candidate_id=?,sha256=?,failure=NULL WHERE review_id=? AND relative_json=? AND state='PENDING'").run(result.state, result.candidateId, result.sha256, job.id, file.relative_json);
              db.prepare("UPDATE ingestion_content_review SET updated_at=? WHERE id=?").run(this.stamp(), job.id);
            })(); progressed = true;
          } catch (error) {
            if (this.closed || controller.signal.aborted || this.row(job.id).state === "CANCELLED") continue;
            // 原卷、暂停或配置变化由外层处理；单文件问题不阻断其他文件。
            this.files.check(job.source_id, job.source_version);
            await this.files.available(job.source_id);
            if (this.closed || controller.signal.aborted || this.row(job.id).state === "CANCELLED") continue;
            this.files.check(job.source_id, job.source_version);
            db.prepare("UPDATE ingestion_content_review_file SET state='FAILED',failure=? WHERE review_id=? AND relative_json=?").run(message(error), job.id, file.relative_json); progressed = true;
          }
        } catch (error) {
          if (this.closed || controller.signal.aborted || this.row(job.id).state === "CANCELLED") continue;
          const unavailable = ["LOCAL_UNAVAILABLE", "ENOENT", "ENOTDIR", "EACCES", "EPERM", "ENODEV", "ENXIO", "ESTALE", "EIO"].includes((error as { code?: string }).code ?? "");
          db.prepare("UPDATE ingestion_content_review SET state=?,failure=?,updated_at=? WHERE id=?").run(unavailable ? "WAITING_SOURCE" : "FAILED", unavailable ? "来源原目录暂不可访问或已暂停，请连接原盘并核对权限；未完成项将在恢复后继续" : message(error), this.stamp(), job.id);
        } finally { if (this.running?.id === job.id) this.running = undefined; }
      }
    }
  }
  async close() { this.closed = true; this.running?.controller.abort(); await this.flight?.catch(() => {}); }
}
