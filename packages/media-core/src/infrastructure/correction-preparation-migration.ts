/** 长时间只读核验有独立收据；进程中断后不自动重放用户确认。 */
export const correctionPreparationMigrationSql = `
CREATE TABLE media_correction_preparation (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES media_task(id),
 kind TEXT NOT NULL CHECK(kind IN ('PREVIEW','CONFIRM')), input_hash TEXT NOT NULL, input_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','CANCELING','READY','FAILED','CANCELED','INTERRUPTED')),
 preview_id TEXT REFERENCES media_correction_preview(id), operation_id TEXT REFERENCES media_correction_operation(id),
 current_path TEXT, read_bytes INTEGER NOT NULL DEFAULT 0 CHECK(read_bytes>=0), total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes>=0),
 failure_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(state!='READY' OR (kind='PREVIEW' AND preview_id IS NOT NULL AND operation_id IS NULL) OR (kind='CONFIRM' AND operation_id IS NOT NULL AND preview_id IS NULL))
);
CREATE UNIQUE INDEX correction_preparation_active_task ON media_correction_preparation(task_id) WHERE state IN ('PENDING','RUNNING','CANCELING');
CREATE TABLE media_correction_preparation_request (
 request_key TEXT PRIMARY KEY, kind TEXT NOT NULL, input_hash TEXT NOT NULL, preparation_id TEXT NOT NULL REFERENCES media_correction_preparation(id)
);
CREATE TRIGGER correction_preparation_immutable BEFORE UPDATE OF id,task_id,kind,input_hash,input_json ON media_correction_preparation
BEGIN SELECT RAISE(ABORT,'修正核验请求不可变'); END;
`;
