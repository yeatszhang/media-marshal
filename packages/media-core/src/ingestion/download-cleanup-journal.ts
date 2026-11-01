import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DesktopError, downloadCleanupPhaseSchema, downloadCleanupSchema, type DownloadCleanup } from "@media-marshal/contracts";
import { localFileEvidenceSchema, managedRootGrantSchema } from "@media-marshal/contracts/internal";
import { CoreDatabase } from "../infrastructure/database.js";

const sideSchema = z.strictObject({ grant: managedRootGrantSchema, segments: z.array(z.string().min(1).max(255)).min(1).max(128), evidence: localFileEvidenceSchema });
export const downloadCleanupPlanSchema = z.strictObject({
  source: sideSchema, target: sideSchema,
  binding: z.string().min(1), targetId: z.uuid(), connectionId: z.string().min(1), connectionVersion: z.number().int().positive(),
  authorization: z.enum(["ORGANIZE", "HISTORICAL_PREVIEW"]),
});
export type DownloadCleanupPlan = z.infer<typeof downloadCleanupPlanSchema>;
type Phase = z.infer<typeof downloadCleanupPhaseSchema>;
export interface CleanupRow {
  id: string; receipt_id: string; task_id: string | null; plan_json: string;
  phase: Phase; resume_phase: Phase | null; claimed: number; freed_bytes: number;
  waiting_reason: string | null; failure: string | null; created_at: string; updated_at: string;
}
const edges: Partial<Record<Phase, readonly Phase[]>> = {
  PENDING: ["WAITING_REFERENCES", "CLAIMED"], WAITING_REFERENCES: ["CLAIMED"],
  CLAIMED: ["QUARANTINED"], QUARANTINED: ["REMOVING"], REMOVING: ["SOURCE_REMOVED"],
  SOURCE_REMOVED: ["CACHE_PENDING"], CACHE_PENDING: ["DONE"],
};
const conflict = () => new DesktopError("CONFLICT", "下载清理记录或所有权证据已变化，请刷新原清理作业核对");

/** 只管理持久日志，不执行文件操作，也不改写整理结果、交付状态及同步收据。 */
export class DownloadCleanupJournal {
  constructor(readonly database: CoreDatabase, private readonly now = Date.now) {}
  get(id: string): CleanupRow {
    const row = this.database.connection.prepare("SELECT * FROM download_cleanup WHERE id=?").get(id) as CleanupRow | undefined;
    if (!row) throw conflict(); return row;
  }
  forReceipt(receiptId: string) { return this.database.connection.prepare("SELECT * FROM download_cleanup WHERE receipt_id=?").get(receiptId) as CleanupRow | undefined; }
  list(taskId?: string): CleanupRow[] {
    return (taskId ? this.database.connection.prepare("SELECT * FROM download_cleanup WHERE task_id=? ORDER BY created_at,id").all(taskId) : this.database.connection.prepare("SELECT * FROM download_cleanup ORDER BY created_at,id").all()) as CleanupRow[];
  }
  describe(row: CleanupRow): DownloadCleanup {
    const plan = downloadCleanupPlanSchema.parse(JSON.parse(row.plan_json));
    return downloadCleanupSchema.parse({ id: row.id, receiptId: row.receipt_id, taskId: row.task_id, phase: row.phase, resumePhase: row.resume_phase,
      sourcePath: join(plan.source.grant.path, ...plan.source.segments), targetPath: join(plan.target.grant.path, ...plan.target.segments),
      size: plan.source.evidence.size, freedBytes: row.freed_bytes, waitingReason: row.waiting_reason, failure: row.failure, updatedAt: row.updated_at });
  }
  create(receiptId: string, taskId: string | null, input: DownloadCleanupPlan) {
    const plan = downloadCleanupPlanSchema.parse(input), json = JSON.stringify(plan), db = this.database.connection;
    return db.transaction(() => {
      const old = this.forReceipt(receiptId);
      if (old) { if (old.task_id !== taskId || old.plan_json !== json) throw conflict(); return old; }
      // 原件必须属于成功收据，且完整身份与同步落库证据相同；不能以同名文件接管所有权。
      const receipt = db.prepare("SELECT r.*,e.evidence_json FROM sync_receipt r JOIN sync_receipt_evidence e ON e.receipt_id=r.id WHERE r.id=?").get(receiptId) as { target_directory_id: string; target_segments_json: string; local_sha256: string; size: number; evidence_json: string } | undefined;
      if (!receipt || receipt.target_directory_id !== plan.source.grant.id || JSON.stringify(["completed", ...JSON.parse(receipt.target_segments_json)]) !== JSON.stringify(plan.source.segments)
        || receipt.local_sha256 !== plan.source.evidence.sha256 || receipt.size !== plan.source.evidence.size
        || JSON.stringify(localFileEvidenceSchema.parse(JSON.parse(receipt.evidence_json))) !== JSON.stringify(plan.source.evidence)
        || plan.source.evidence.size !== plan.target.evidence.size || plan.source.evidence.sha256 !== plan.target.evidence.sha256
        || plan.source.grant.volume.volumeId !== plan.source.evidence.volumeId || plan.target.grant.volume.volumeId !== plan.target.evidence.volumeId
        || (plan.source.evidence.volumeId === plan.target.evidence.volumeId && plan.source.evidence.inode === plan.target.evidence.inode)) throw conflict();
      const id = randomUUID(), stamp = new Date(this.now()).toISOString();
      db.prepare("INSERT INTO download_cleanup(id,receipt_id,task_id,plan_json,phase,created_at,updated_at) VALUES(?,?,?,?,'PENDING',?,?)").run(id, receiptId, taskId, json, stamp, stamp);
      return this.get(id);
    })();
  }
  /** 调用方须在同一同步事务中完成所有消费者检查，再领取。 */
  advance(id: string, from: Phase, to: Phase, waitingReason: string | null = null) {
    if (!edges[from]?.includes(to)) throw conflict();
    const stamp = new Date(this.now()).toISOString();
    const changes = this.database.connection.prepare("UPDATE download_cleanup SET phase=?,claimed=CASE WHEN ?='CLAIMED' THEN 1 ELSE claimed END,freed_bytes=CASE WHEN ?='SOURCE_REMOVED' THEN json_extract(plan_json,'$.source.evidence.size') ELSE freed_bytes END,waiting_reason=?,failure=NULL,updated_at=? WHERE id=? AND phase=?")
      .run(to, to, to, waitingReason, stamp, id, from).changes;
    if (!changes) throw conflict(); return this.get(id);
  }
  fail(id: string, message: string) {
    const row = this.get(id); if (["DONE", "NEEDS_ATTENTION"].includes(row.phase)) return row;
    this.database.connection.prepare("UPDATE download_cleanup SET phase='NEEDS_ATTENTION',resume_phase=?,failure=?,waiting_reason=NULL,updated_at=? WHERE id=? AND phase=?")
      .run(row.phase, message.slice(0, 500), new Date(this.now()).toISOString(), id, row.phase);
    return this.get(id);
  }
  wait(id: string, message: string) {
    this.database.connection.prepare("UPDATE download_cleanup SET waiting_reason=?,updated_at=? WHERE id=? AND phase NOT IN ('DONE','NEEDS_ATTENTION')").run(message.slice(0, 500), new Date(this.now()).toISOString(), id);
    return this.get(id);
  }
  retry(id: string) {
    const row = this.get(id); if (row.phase !== "NEEDS_ATTENTION") return row;
    this.database.connection.transaction(() => {
      if (["PENDING", "WAITING_REFERENCES", "CLAIMED", "QUARANTINED", "REMOVING"].includes(row.resume_phase ?? "")) this.database.connection.prepare("INSERT OR IGNORE INTO download_cleanup_binding_review(cleanup_id,state,requested_at) VALUES(?,'PENDING',?)").run(id, new Date(this.now()).toISOString());
      this.database.connection.prepare("UPDATE download_cleanup SET phase=resume_phase,resume_phase=NULL,failure=NULL,updated_at=? WHERE id=? AND phase='NEEDS_ATTENTION'").run(new Date(this.now()).toISOString(), id);
    })();
    return this.get(id);
  }
}
