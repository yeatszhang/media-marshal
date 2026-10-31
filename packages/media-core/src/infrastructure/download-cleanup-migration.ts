/** 成功收据不改写；清理日志和领取事实独立保存，不能靠回滚业务状态撤销文件动作。 */
export const downloadCleanupMigrationSql = `
CREATE TABLE download_cleanup (
 id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE REFERENCES sync_receipt(id),
 task_id TEXT REFERENCES media_task(id), plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
 phase TEXT NOT NULL CHECK(phase IN ('PENDING','WAITING_REFERENCES','CLAIMED','QUARANTINED','REMOVING','SOURCE_REMOVED','CACHE_PENDING','DONE','NEEDS_ATTENTION')),
 resume_phase TEXT CHECK(resume_phase IN ('PENDING','WAITING_REFERENCES','CLAIMED','QUARANTINED','REMOVING','SOURCE_REMOVED','CACHE_PENDING')),
 claimed INTEGER NOT NULL DEFAULT 0 CHECK(claimed IN (0,1)),
 freed_bytes INTEGER NOT NULL DEFAULT 0 CHECK(freed_bytes>=0),
 waiting_reason TEXT, failure TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((phase='NEEDS_ATTENTION')=(resume_phase IS NOT NULL)),
 CHECK(phase NOT IN ('CLAIMED','QUARANTINED','REMOVING','SOURCE_REMOVED','CACHE_PENDING','DONE') OR claimed=1)
);
CREATE INDEX download_cleanup_progress ON download_cleanup(phase,updated_at);
CREATE TRIGGER download_cleanup_plan_immutable BEFORE UPDATE OF id,receipt_id,task_id,plan_json,created_at ON download_cleanup
BEGIN SELECT RAISE(ABORT,'下载清理计划与所有权证据不可修改'); END;
CREATE TRIGGER download_cleanup_claim_retained BEFORE UPDATE OF claimed ON download_cleanup
WHEN OLD.claimed=1 AND NEW.claimed=0
BEGIN SELECT RAISE(ABORT,'已领取的下载清理不能撤销文件事实'); END;
`;
