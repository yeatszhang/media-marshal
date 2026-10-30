import { randomUUID } from "node:crypto";
import { DesktopError, publicError, type CoreInput, type CoreOutput, type SourceScan } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
export interface ScanScope { physicalId: string; name: string; context: string; waiting: string | null }
export interface ScanResult { discovered: number; checkedPaths: string[]; issues: { relativePath: string; failure: string }[] }
interface ScanRow { owner_kind: "legacy" | "recognition"; id: string; source_id: string; physical_source_id: string; source_name: string; context: string; state: SourceScan["state"]; discovered: number; failure: string | null; created_at: string; updated_at: string }
const active = "state IN ('PENDING','RUNNING','WAITING_SOURCE')";
/** 手动扫描只保存意图并复用流水线扫描；真正的文件接入仍经过来源与就绪检查。 */
export class SourceScans {
  private closed = false; private flight?: Promise<void>; private timer?: ReturnType<typeof setInterval>; private again = false; private closeFlight?: Promise<void>;
  constructor(private readonly database: CoreDatabase, private readonly scope: (id: string) => ScanScope, private readonly scan: (id: string, sourceId: string) => Promise<ScanResult>, private readonly now = Date.now, private readonly ownerKind: "legacy" | "recognition" = "legacy") {
    database.connection.prepare("UPDATE ingestion_source_scan SET state='PENDING',failure='核心已重启，等待原目录授权恢复后重新补扫',next_attempt_at=0,updated_at=? WHERE state='RUNNING' AND owner_kind=?").run(this.stamp(), this.ownerKind);
  }
  private stamp() { return new Date(this.now()).toISOString(); }
  private row(id: string) { const row = this.database.connection.prepare("SELECT * FROM ingestion_source_scan WHERE id=?").get(id) as ScanRow | undefined; if (!row) throw new DesktopError("CONFLICT", `目录扫描作业 ${id} 不存在，请关闭旧详情并刷新扫描记录`); return row; }
  private dto(row: ScanRow): SourceScan { const count = this.database.connection.prepare("SELECT count(*) AS n FROM ingestion_source_scan_issue WHERE scan_id=?").get(row.id) as { n: number }; return { ...(row.owner_kind === "recognition" ? { ownerKind: "recognition" as const } : {}), id: row.id, sourceId: row.source_id, sourceName: row.source_name, state: row.state, discovered: row.discovered, failed: count.n, failure: row.failure, createdAt: row.created_at, updatedAt: row.updated_at }; }
  enqueue(input: CoreInput<"ingestion.scan">): SourceScan {
    if (this.closed) throw new DesktopError("INTERRUPTED", "目录扫描正在停止", true);
    const db = this.database.connection;
    const id = db.transaction(() => {
      const receipt = db.prepare("SELECT source_id,scan_id FROM ingestion_source_scan_request WHERE request_key=?").get(input.requestKey) as { source_id: string; scan_id: string } | undefined;
      if (receipt) { if (receipt.source_id !== input.sourceId) throw new DesktopError("CONFLICT", "扫描请求标识已用于其他来源，请刷新后重试"); return receipt.scan_id; }
      const scope = this.scope(input.sourceId);
      const previous = db.prepare(`SELECT * FROM ingestion_source_scan WHERE source_id=? AND owner_kind=? AND ${active}`).get(input.sourceId, this.ownerKind) as ScanRow | undefined;
      if (previous && previous.context !== scope.context) db.prepare("UPDATE ingestion_source_scan SET state='FAILED',failure='来源配置已变化，请按当前配置重新扫描',updated_at=? WHERE id=?").run(this.stamp(), previous.id);
      const old = previous?.context === scope.context ? previous : undefined;
      const id = old?.id ?? randomUUID();
      if (!old) db.prepare("INSERT INTO ingestion_source_scan(id,source_id,physical_source_id,source_name,context,state,failure,created_at,updated_at,owner_kind) VALUES(?,?,?,?,?,? ,?,?,?,?)").run(id, input.sourceId, scope.physicalId, scope.name, scope.context, scope.waiting ? "WAITING_SOURCE" : "PENDING", scope.waiting, this.stamp(), this.stamp(), this.ownerKind);
      db.prepare("INSERT INTO ingestion_source_scan_request VALUES(?,?,?)").run(input.requestKey, input.sourceId, id); return id;
    })();
    const result = this.dto(this.row(id)); this.kick(); return result;
  }
  list(input: CoreInput<"ingestion.scans">): CoreOutput<"ingestion.scans"> { const db = this.database.connection; return { total: (db.prepare("SELECT count(*) AS n FROM ingestion_source_scan").get() as { n: number }).n, items: (db.prepare("SELECT * FROM ingestion_source_scan ORDER BY created_at DESC,rowid DESC LIMIT 25 OFFSET ?").all(((input.page ?? 1) - 1) * 25) as ScanRow[]).map((row) => this.dto(row)) }; }
  get(input: CoreInput<"ingestion.scan-job">): CoreOutput<"ingestion.scan-job"> { const job = this.dto(this.row(input.id)), issues = this.database.connection.prepare("SELECT relative_path AS relativePath,failure FROM ingestion_source_scan_issue WHERE scan_id=? ORDER BY relative_path LIMIT 100 OFFSET ?").all(input.id, ((input.page ?? 1) - 1) * 100) as CoreOutput<"ingestion.scan-job">["issues"]; return { job, issues, total: job.failed }; }
  start() { if (!this.closed && !this.timer) { this.timer = setInterval(() => this.kick(), 10000); this.kick(); } }
  kick() { if (this.closed) return; if (this.flight) { this.again = true; return; } const task = this.run().finally(() => { if (this.flight === task) this.flight = undefined; if (this.again) { this.again = false; this.kick(); } }); this.flight = task; void task.catch(() => {}); }
  async idle() { while (this.flight) await this.flight; }
  private checked(job: ScanRow) { const scope = this.scope(job.source_id); if (scope.context !== job.context || scope.physicalId !== job.physical_source_id) throw new DesktopError("CONFLICT", "来源配置或删除状态已变化；原扫描不会改用新配置，请重新扫描"); return scope; }
  private async run() {
    const db = this.database.connection, jobs = db.prepare(`SELECT * FROM ingestion_source_scan WHERE ${active} AND owner_kind=? AND next_attempt_at<=? ORDER BY next_attempt_at,created_at,id LIMIT 4`).all(this.ownerKind, this.now()) as ScanRow[];
    for (const job of jobs) {
      if (this.closed) return;
      try {
        const scope = this.checked(job);
        if (scope.waiting) { db.prepare("UPDATE ingestion_source_scan SET state='WAITING_SOURCE',failure=?,next_attempt_at=?,updated_at=? WHERE id=?").run(scope.waiting, this.now() + 5000, this.stamp(), job.id); continue; }
        db.prepare("UPDATE ingestion_source_scan SET state='RUNNING',failure=NULL,updated_at=? WHERE id=?").run(this.stamp(), job.id);
        const result = await this.scan(scope.physicalId, job.source_id);
        if (this.closed || this.row(job.id).state !== "RUNNING") continue;
        const latest = this.checked(job); if (latest.waiting) throw new DesktopError("LOCAL_UNAVAILABLE", latest.waiting, true);
        db.transaction(() => {
          this.checked(job); db.prepare("DELETE FROM ingestion_source_scan_issue WHERE scan_id=?").run(job.id);
          for (const issue of result.issues) db.prepare("INSERT OR REPLACE INTO ingestion_source_scan_issue VALUES(?,?,?)").run(job.id, issue.relativePath, issue.failure);
          db.prepare("UPDATE ingestion_source_scan SET state=?,discovered=?,failure=?,updated_at=? WHERE id=?").run(result.issues.length ? "PARTIAL_FAILED" : "COMPLETED", result.discovered, result.issues.length ? "部分文件未能核对，请展开逐项问题，修复后重新扫描；已发现候选保留" : null, this.stamp(), job.id);
        })();
      } catch (error) {
        if (this.closed || !["PENDING", "RUNNING", "WAITING_SOURCE"].includes(this.row(job.id).state)) continue;
        const reported = publicError(error), code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        let waiting = ["LOCAL_UNAVAILABLE", "INTERRUPTED"].includes(reported.code), failure = reported.code === "INTERNAL_ERROR" ? "来源目录枚举未完成，请检查原磁盘、子目录及读取权限后重新扫描" : reported.message;
        if (["EACCES", "EPERM"].includes(code)) { waiting = true; failure = "来源或子目录读取权限不足，请恢复原目录读取权限后继续补扫"; }
        if (["ENOENT", "ENOTDIR", "ENODEV", "ENXIO", "ESTALE", "EIO"].includes(code)) { waiting = true; failure = "来源目录暂不可访问，请连接原磁盘并恢复原路径后继续补扫"; }
        try { const scope = this.checked(job); if (scope.waiting) { waiting = true; failure = scope.waiting; } } catch (changed) { waiting = false; failure = publicError(changed).message; }
        db.prepare("UPDATE ingestion_source_scan SET state=?,failure=?,next_attempt_at=?,updated_at=? WHERE id=?").run(waiting ? "WAITING_SOURCE" : "FAILED", failure.slice(0, 500), this.now() + 5000, this.stamp(), job.id);
      }
    }
  }
  quiesce() { this.closed = true; clearInterval(this.timer); }
  close(): Promise<void> { this.quiesce(); return this.closeFlight ??= (async () => { await this.flight?.catch(() => {}); this.database.connection.prepare("UPDATE ingestion_source_scan SET state='PENDING',failure='核心正在停止，重启并恢复授权后继续补扫',updated_at=? WHERE state='RUNNING' AND owner_kind=?").run(this.stamp(), this.ownerKind); })(); }
}
