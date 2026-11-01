import type { CoreDatabase } from "../../infrastructure/database.js";

interface Transition {
  id: string;
  source_id: string;
  state: string;
  next_state: string;
}
/** 状态更新与观察使用同一同步事务，日志只在提交后由调用者发出。 */
export function reconcileLocalSyncJobs(database: CoreDatabase, stamp: string) {
  const db = database.connection;
  return db.transaction(() => {
    const before = db
      .prepare(
        "SELECT j.id,j.source_id,j.state,CASE WHEN EXISTS(SELECT 1 FROM local_sync_member m WHERE m.job_id=j.id AND m.state='NEEDS_ATTENTION') THEN 'NEEDS_ATTENTION' ELSE 'DONE' END AS next_state FROM sync_job j WHERE EXISTS(SELECT 1 FROM local_sync_preview p WHERE p.job_id=j.id) AND j.state IN ('PENDING','RUNNING','NEEDS_ATTENTION') AND NOT EXISTS(SELECT 1 FROM local_sync_member m WHERE m.job_id=j.id AND m.state='PENDING')",
      )
      .all() as Transition[];
    db.prepare(
      "UPDATE sync_job SET state=CASE WHEN EXISTS(SELECT 1 FROM local_sync_member m WHERE m.job_id=sync_job.id AND m.state='NEEDS_ATTENTION') THEN 'NEEDS_ATTENTION' ELSE 'DONE' END,updated_at=? WHERE EXISTS(SELECT 1 FROM local_sync_preview p WHERE p.job_id=sync_job.id) AND state IN ('PENDING','RUNNING','NEEDS_ATTENTION') AND NOT EXISTS(SELECT 1 FROM local_sync_member m WHERE m.job_id=sync_job.id AND m.state='PENDING')",
    ).run(stamp);
    const members = db.prepare(
      "SELECT DISTINCT operation_id FROM local_sync_member WHERE job_id=? AND operation_id IS NOT NULL ORDER BY operation_id LIMIT 21",
    );
    return before
      .filter((row) => row.state !== row.next_state)
      .map((row) => {
        const operations = members.all(row.id) as { operation_id: string }[];
        return {
          jobId: row.id,
          sourceId: row.source_id,
          fromState: row.state,
          toState: row.next_state,
          operationIds: operations.slice(0, 20).map((member) => member.operation_id),
          operationsTruncated: operations.length > 20,
        };
      });
  })();
}
