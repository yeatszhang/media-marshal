/** 成功收据不改写；清理日志和领取事实独立保存，不能靠回滚业务状态撤销文件动作。 */
const cleanupTargetMatches = `(c.task_id=NEW.task_id OR (SELECT target_path FROM media_task WHERE id=NEW.task_id)=json_extract(c.plan_json,'$.target.grant.path')||'/'||(SELECT group_concat(value,'/') FROM json_each(json_extract(c.plan_json,'$.target.segments'))))`;
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
CREATE UNIQUE INDEX download_cleanup_owned_file ON download_cleanup(
 json_extract(plan_json,'$.source.evidence.volumeId'),json_extract(plan_json,'$.source.evidence.inode'),json_extract(plan_json,'$.source.evidence.birthtimeNs')
);
CREATE TRIGGER download_cleanup_plan_immutable BEFORE UPDATE OF id,receipt_id,task_id,plan_json,created_at ON download_cleanup
BEGIN SELECT RAISE(ABORT,'下载清理计划与所有权证据不可修改'); END;
CREATE TRIGGER download_cleanup_claim_retained BEFORE UPDATE OF claimed ON download_cleanup
WHEN OLD.claimed=1 AND NEW.claimed=0
BEGIN SELECT RAISE(ABORT,'已领取的下载清理不能撤销文件事实'); END;
CREATE TRIGGER download_cleanup_candidate_claim BEFORE INSERT ON ingestion_candidate
WHEN EXISTS(SELECT 1 FROM download_cleanup c JOIN ingestion_source s ON s.source_id=NEW.source_id
 WHERE c.claimed=1 AND json_extract(c.plan_json,'$.source.grant.id')=json_extract(s.source_grant_json,'$.id')
 AND json_extract(c.plan_json,'$.source.evidence.inode')=json_extract(NEW.snapshot_json,'$.inode')
 AND json_extract(c.plan_json,'$.source.evidence.birthtimeNs')=json_extract(NEW.snapshot_json,'$.birthtimeNs'))
BEGIN SELECT RAISE(ABORT,'原下载成果已领取清理，请查询媒体库成果，不再接入新识别消费者'); END;
CREATE TRIGGER download_cleanup_candidate_resume BEFORE UPDATE OF state ON ingestion_candidate
WHEN NEW.state NOT IN ('PROCESSED','SKIPPED','SUPERSEDED') AND EXISTS(
 SELECT 1 FROM download_cleanup c JOIN ingestion_source s ON s.source_id=NEW.source_id
 WHERE c.claimed=1 AND json_extract(c.plan_json,'$.source.grant.id')=json_extract(s.source_grant_json,'$.id')
 AND json_extract(c.plan_json,'$.source.evidence.inode')=json_extract(NEW.snapshot_json,'$.inode')
 AND json_extract(c.plan_json,'$.source.evidence.birthtimeNs')=json_extract(NEW.snapshot_json,'$.birthtimeNs'))
BEGIN SELECT RAISE(ABORT,'原下载成果已领取清理，不能重新启用依赖原件的识别任务'); END;
CREATE TABLE download_cleanup_intent (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES ingestion_operation(id), accessory_id TEXT REFERENCES ingestion_accessory(id),
 task_id TEXT NOT NULL REFERENCES media_task(id),
 state TEXT NOT NULL CHECK(state IN ('PENDING','READY','NEEDS_ATTENTION')),
 cleanup_id TEXT REFERENCES download_cleanup(id), failure TEXT, created_at TEXT NOT NULL,
 UNIQUE(operation_id,accessory_id), CHECK((state='READY')=(cleanup_id IS NOT NULL))
);
CREATE TABLE download_cleanup_preview (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, receipt_ids_json TEXT NOT NULL CHECK(json_valid(receipt_ids_json)),
 state TEXT NOT NULL CHECK(state IN ('PREPARING','READY','BLOCKED','CONFIRMED','CANCELLED','EXPIRED')),
 plans_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(plans_json)), failure TEXT,
 expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE owned_attempt_cleanup (
 owner_kind TEXT NOT NULL CHECK(owner_kind IN ('ingestion_operation','ingestion_accessory','download_attempt','local_sync_operation')),
 owner_id TEXT NOT NULL, attempt_id TEXT NOT NULL, root_id TEXT NOT NULL, grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
 state TEXT NOT NULL CHECK(state IN ('PENDING','DONE','NEEDS_ATTENTION')), failure TEXT, updated_at TEXT NOT NULL,
 retained_bytes INTEGER NOT NULL DEFAULT 0 CHECK(retained_bytes>=0), released_bytes INTEGER NOT NULL DEFAULT 0 CHECK(released_bytes>=0),
 PRIMARY KEY(owner_kind,owner_id)
);
CREATE TABLE download_cleanup_binding_review (
 id INTEGER PRIMARY KEY, cleanup_id TEXT NOT NULL REFERENCES download_cleanup(id),
 state TEXT NOT NULL CHECK(state IN ('PENDING','APPROVED')), proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),
 requested_at TEXT NOT NULL, approved_at TEXT,
 CHECK((state='APPROVED')=(proof_json IS NOT NULL))
);
CREATE UNIQUE INDEX cleanup_binding_review_active ON download_cleanup_binding_review(cleanup_id) WHERE state='PENDING';
CREATE TRIGGER cleanup_binding_review_immutable BEFORE UPDATE ON download_cleanup_binding_review WHEN OLD.state='APPROVED'
BEGIN SELECT RAISE(ABORT,'清理重试的核验历史不可修改'); END;
CREATE TRIGGER download_cleanup_correction_claim BEFORE INSERT ON media_correction_preparation
WHEN EXISTS(SELECT 1 FROM download_cleanup c WHERE ${cleanupTargetMatches} AND c.claimed=1
 AND (c.phase IN ('CLAIMED','QUARANTINED','REMOVING') OR c.resume_phase IN ('CLAIMED','QUARANTINED','REMOVING')))
BEGIN SELECT RAISE(ABORT,'此媒体正在核验并清理下载原件，请等待原件清理到达安全点后重试修正'); END;
CREATE TRIGGER download_cleanup_correction_item_claim BEFORE INSERT ON correction_item
WHEN NEW.state IN ('PENDING','RUNNING') AND EXISTS(SELECT 1 FROM download_cleanup c WHERE ${cleanupTargetMatches} AND c.claimed=1
 AND (c.phase IN ('CLAIMED','QUARANTINED','REMOVING') OR c.resume_phase IN ('CLAIMED','QUARANTINED','REMOVING')))
BEGIN SELECT RAISE(ABORT,'此媒体正在核验并清理下载原件，请等待原件清理到达安全点后重试修正'); END;
CREATE TRIGGER download_cleanup_correction_item_resume BEFORE UPDATE OF state ON correction_item
WHEN NEW.state IN ('PENDING','RUNNING') AND EXISTS(SELECT 1 FROM download_cleanup c WHERE ${cleanupTargetMatches} AND c.claimed=1
 AND (c.phase IN ('CLAIMED','QUARANTINED','REMOVING') OR c.resume_phase IN ('CLAIMED','QUARANTINED','REMOVING')))
BEGIN SELECT RAISE(ABORT,'此媒体正在核验并清理下载原件，请等待原件清理到达安全点后重试修正'); END;
`;
