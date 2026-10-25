/** 批量识别只提交原候选的任务，逐项收据跨进程恢复。 */
export const recognitionBatchMigrationSql = `
CREATE TABLE ingestion_recognition_batch (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, signature TEXT NOT NULL,
 cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ingestion_recognition_batch_item (
 batch_id TEXT NOT NULL REFERENCES ingestion_recognition_batch(id), candidate_id TEXT NOT NULL REFERENCES ingestion_candidate(id),
 request_key TEXT NOT NULL UNIQUE, context_json TEXT NOT NULL, relative_path TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING','SUBMITTED','FAILED')), task_id TEXT REFERENCES media_task(id),
 failure TEXT, waiting_reason TEXT, ordinal INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(batch_id,candidate_id)
);
CREATE INDEX ingestion_recognition_batch_pending ON ingestion_recognition_batch_item(state,batch_id,ordinal);
`;
