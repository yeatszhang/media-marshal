/** 修正历史与文件日志分别记账；同一事务完成任务历史、文件占用释放和新 Emby 意图。 */
export const correctionMigrationSql = `
DROP INDEX correction_active_task;
CREATE UNIQUE INDEX correction_active_task ON correction_item(task_id) WHERE state IN ('PENDING','RUNNING','NEEDS_ATTENTION');
CREATE TABLE media_correction_preview (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES media_task(id),
 input_hash TEXT NOT NULL, plan_json TEXT NOT NULL, expires_at INTEGER NOT NULL, operation_id TEXT UNIQUE
);
CREATE TABLE media_correction_operation (
 id TEXT PRIMARY KEY REFERENCES correction_item(id), preview_id TEXT NOT NULL UNIQUE REFERENCES media_correction_preview(id),
 request_key TEXT NOT NULL UNIQUE, original_task_id TEXT NOT NULL REFERENCES media_task(id), new_task_id TEXT NOT NULL UNIQUE REFERENCES media_task(id),
 target_root_id TEXT NOT NULL REFERENCES media_target_root(id), target_slot TEXT NOT NULL, plan_json TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('PLANNED','RUNNING','NEEDS_ATTENTION','RECORDED')), evidence_json TEXT,
 failure TEXT, cleanup_pending INTEGER NOT NULL DEFAULT 1 CHECK(cleanup_pending IN (0,1)), cleanup_due INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(target_root_id,target_slot), CHECK(phase!='RECORDED' OR evidence_json IS NOT NULL)
);
CREATE TRIGGER correction_immutable_plan BEFORE UPDATE OF id,preview_id,request_key,original_task_id,new_task_id,target_root_id,plan_json ON media_correction_operation
BEGIN SELECT RAISE(ABORT,'修正业务计划不可变'); END;
CREATE TABLE media_correction_confirmation (
 request_key TEXT PRIMARY KEY, preview_id TEXT NOT NULL REFERENCES media_correction_preview(id), operation_id TEXT NOT NULL REFERENCES media_correction_operation(id)
);
ALTER TABLE emby_delivery RENAME TO emby_delivery_before_correction;
CREATE TABLE emby_delivery (
 task_id TEXT PRIMARY KEY REFERENCES media_task(id), operation_id TEXT UNIQUE REFERENCES ingestion_operation(id),
 correction_id TEXT UNIQUE REFERENCES media_correction_operation(id),
 connection_id TEXT REFERENCES emby_connection(id), connection_version INTEGER,
 state TEXT NOT NULL CHECK(state IN ('REFRESH_PENDING','WAITING_LIBRARY','COLLECTED','NEEDS_ATTENTION')),
 refresh_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, check_started_at INTEGER,
 last_failure TEXT, emby_item_id TEXT, updated_at TEXT NOT NULL,
 CHECK((operation_id IS NULL)!=(correction_id IS NULL))
);
INSERT INTO emby_delivery(task_id,operation_id,connection_id,connection_version,state,refresh_attempts,next_attempt_at,check_started_at,last_failure,emby_item_id,updated_at)
 SELECT task_id,operation_id,connection_id,connection_version,state,refresh_attempts,next_attempt_at,check_started_at,last_failure,emby_item_id,updated_at FROM emby_delivery_before_correction;
DROP TABLE emby_delivery_before_correction;
`;
