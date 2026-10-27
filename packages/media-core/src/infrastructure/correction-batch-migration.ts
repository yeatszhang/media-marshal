/** 批次冻结完整范围；确认及所有单条意图一并落库，文件执行仍逐项推进。 */
export const correctionBatchMigrationSql = `
CREATE TRIGGER correction_preview_immutable BEFORE UPDATE OF id,request_key,task_id,input_hash,plan_json ON media_correction_preview
BEGIN SELECT RAISE(ABORT,'修正预览计划不可变'); END;
CREATE TABLE media_correction_batch (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, input_json TEXT NOT NULL,
 anchor_task_id TEXT NOT NULL REFERENCES media_task(id), scope TEXT NOT NULL CHECK(scope IN ('SAME_SEASON','SAME_SERIES')),
 generation TEXT NOT NULL, fingerprint TEXT NOT NULL, scope_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PREVIEWING','READY','BLOCKED','CONFIRMING','SUBMITTED','CANCELED','INTERRUPTED')),
 expires_at INTEGER, accepted_at INTEGER, failure_json TEXT, current_task_id TEXT REFERENCES media_task(id),
 current_path TEXT, read_bytes INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE media_correction_batch_member (
 batch_id TEXT NOT NULL REFERENCES media_correction_batch(id), task_id TEXT NOT NULL REFERENCES media_task(id),
 ordinal INTEGER NOT NULL CHECK(ordinal>=0), selected INTEGER NOT NULL CHECK(selected IN (0,1)), snapshot_json TEXT NOT NULL,
 preview_key TEXT NOT NULL UNIQUE, confirm_key TEXT NOT NULL UNIQUE, preview_id TEXT UNIQUE REFERENCES media_correction_preview(id),
 operation_id TEXT UNIQUE REFERENCES media_correction_operation(id), failure_json TEXT,
 PRIMARY KEY(batch_id,task_id), UNIQUE(batch_id,ordinal)
);
CREATE TABLE media_correction_batch_confirmation (
 request_key TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES media_correction_batch(id)
);
CREATE TRIGGER correction_batch_immutable BEFORE UPDATE OF id,request_key,input_hash,input_json,anchor_task_id,scope,generation,fingerprint,scope_json ON media_correction_batch
BEGIN SELECT RAISE(ABORT,'批量修正范围与请求不可变'); END;
CREATE TRIGGER correction_batch_member_immutable BEFORE UPDATE OF batch_id,task_id,ordinal,selected,snapshot_json,preview_key,confirm_key ON media_correction_batch_member
BEGIN SELECT RAISE(ABORT,'批量修正成员不可变'); END;
`;
