/** 批量预览不领取文件操作；人工确认意图和逐项提交收据独立持久化。 */
export const organizeBatchMigrationSql = `
CREATE TABLE ingestion_organize_batch (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, signature TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PREVIEWING','READY','BLOCKED','CONFIRMING','SUBMITTED','CANCELLED')),
 template TEXT, include_accessories INTEGER NOT NULL CHECK(include_accessories IN (0,1)),
 expires_at INTEGER NOT NULL, failure TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ingestion_organize_batch_item (
 batch_id TEXT NOT NULL REFERENCES ingestion_organize_batch(id), task_id TEXT NOT NULL REFERENCES media_task(id),
 ordinal INTEGER NOT NULL, request_key TEXT NOT NULL UNIQUE, confirm_key TEXT NOT NULL UNIQUE,
 source_path TEXT NOT NULL, selection_json TEXT NOT NULL, context_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING','READY','BLOCKED','SUBMITTED','FAILED')),
 preview_id TEXT UNIQUE REFERENCES ingestion_preview(id), manifest_json TEXT, operation_id TEXT REFERENCES ingestion_operation(id),
 errors_json TEXT NOT NULL DEFAULT '[]', waiting_reason TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(batch_id,task_id)
);
CREATE TABLE ingestion_organize_batch_confirmation (
 request_key TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES ingestion_organize_batch(id), created_at TEXT NOT NULL
);
CREATE INDEX ingestion_organize_batch_items ON ingestion_organize_batch_item(batch_id,state,ordinal);
`;
