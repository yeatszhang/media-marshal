import {
  DownloadCleanupJournal,
  downloadCleanupPlanSchema,
  type CleanupRow,
} from "./download-cleanup-journal.js";
import { join } from "node:path";

/** 与消费者写入共用 SQLite 同步事务；暂停不释放需求，完成／显式放弃才释放。 */
export class DownloadCleanupDemands {
  constructor(private readonly journal: DownloadCleanupJournal) {}
  reasons(row: CleanupRow): string[] {
    const db = this.journal.database.connection,
      plan = downloadCleanupPlanSchema.parse(JSON.parse(row.plan_json));
    const reasons: string[] = [],
      segments = JSON.stringify(plan.source.segments);
    if (
      db
        .prepare(
          "SELECT 1 FROM sync_receipt r JOIN download_job_item i ON r.result_kind='download-item' AND i.item_id=r.result_id JOIN download_job j ON j.id=i.job_id WHERE r.id=? AND i.demand_state='ACTIVE' AND j.state NOT IN ('COMPLETED','CANCELLED') LIMIT 1",
        )
        .get(row.receipt_id)
    )
      reasons.push("同步作业仍保留原件需求（含暂停作业）");
    if (
      db
        .prepare(
          "SELECT 1 FROM ingestion_outbox o JOIN sync_receipt r ON r.result_kind='download-item' AND r.result_id=o.item_id WHERE r.id=? AND o.state!='ACKNOWLEDGED' LIMIT 1",
        )
        .get(row.receipt_id)
    )
      reasons.push("同步成果仍在等待识别交接");
    if (
      db
        .prepare(
          "SELECT 1 FROM download_claim c JOIN sync_receipt r ON r.result_kind='download-item' AND r.result_id=c.item_id WHERE r.id=?",
        )
        .get(row.receipt_id)
    )
      reasons.push("下载写入者尚未完成恢复记账与释放");
    if (
      db
        .prepare(
          "SELECT 1 FROM local_sync_member m JOIN sync_job j ON j.id=m.job_id WHERE m.receipt_id=? AND j.state NOT IN ('DONE','CANCELED') LIMIT 1",
        )
        .get(row.receipt_id)
    )
      reasons.push("本地同步作业仍保留需求，暂停同样保留原件");
    const candidates = db
      .prepare(
        "SELECT c.id,c.task_id,c.state FROM ingestion_candidate c JOIN ingestion_source s ON s.source_id=c.source_id LEFT JOIN recognition_input i ON i.source_id=c.source_id LEFT JOIN recognition_rule r ON r.id=i.rule_id WHERE json_extract(s.source_grant_json,'$.id')=? AND c.relative_json=? AND (c.is_current=1 OR c.managed_item_id IS NOT NULL) AND (i.source_id IS NULL OR (i.active=1 AND r.deleted_at IS NULL)) AND NOT EXISTS(SELECT 1 FROM source_rule x WHERE x.local_source_id=s.source_id AND x.deleted_at IS NOT NULL)",
      )
      .all(plan.source.grant.id, segments) as {
      id: string;
      task_id: string | null;
      state: string;
    }[];
    if (
      candidates.some(
        (candidate) => !["PROCESSED", "SKIPPED", "SUPERSEDED"].includes(candidate.state),
      )
    )
      reasons.push("识别候选仍未完成，暂停的规则同样保留需求");
    // 生效输入即使尚未观察到候选也保留需求，避免清理赢过补扫或暂停规则。
    if (
      db
        .prepare(
          "SELECT 1 FROM recognition_input i JOIN recognition_rule r ON r.id=i.rule_id WHERE i.directory_id=? AND i.active=1 AND r.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM ingestion_candidate c WHERE c.source_id=i.source_id AND c.relative_json=? AND c.is_current=1 AND c.state IN ('PROCESSED','SKIPPED','SUPERSEDED')) LIMIT 1",
        )
        .get(plan.source.grant.id, segments)
    )
      reasons.push("另一识别输入尚未处理此成果");
    for (const table of ["ingestion_operation", "ingestion_accessory"] as const)
      if (
        db
          .prepare(
            `SELECT 1 FROM ${table} WHERE json_extract(plan_json,'$.source.id')=? AND json_extract(plan_json,'$.sourceSegments')=? AND phase!='RECORDED' LIMIT 1`,
          )
          .get(plan.source.grant.id, segments)
      )
        reasons.push("原件仍被整理复制或附属文件交付使用");
    const targetTasks = db
      .prepare("SELECT id FROM media_task WHERE target_path=?")
      .all(join(plan.target.grant.path, ...plan.target.segments)) as { id: string }[];
    for (const taskId of new Set([row.task_id, ...targetTasks.map((task) => task.id)])) {
      if (
        taskId &&
        db
          .prepare(
            "SELECT 1 FROM correction_item WHERE task_id=? AND state IN ('PENDING','RUNNING','NEEDS_ATTENTION') LIMIT 1",
          )
          .get(taskId)
      )
        reasons.push("媒体修正仍在进行或等待修复");
      if (
        taskId &&
        db
          .prepare(
            "SELECT 1 FROM media_correction_preparation WHERE task_id=? AND state IN ('PENDING','RUNNING','CANCELING') LIMIT 1",
          )
          .get(taskId)
      )
        reasons.push("媒体修正仍在核验，等待消费者释放");
    }
    return reasons;
  }
  claim(id: string) {
    const db = this.journal.database.connection;
    return db.transaction(() => {
      const row = this.journal.get(id);
      if (!["PENDING", "WAITING_REFERENCES"].includes(row.phase)) return row;
      const reasons = this.reasons(row);
      if (reasons.length) {
        if (row.phase === "PENDING")
          return this.journal.advance(
            id,
            "PENDING",
            "WAITING_REFERENCES",
            reasons.join("；").slice(0, 500),
          );
        db.prepare("UPDATE download_cleanup SET waiting_reason=? WHERE id=?").run(
          reasons.join("；").slice(0, 500),
          id,
        );
        return this.journal.get(id);
      }
      return this.journal.advance(id, row.phase, "CLAIMED");
    })();
  }
}
