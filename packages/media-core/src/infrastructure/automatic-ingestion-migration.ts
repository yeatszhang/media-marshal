/** 自动授权与候选执行收据分别保存；迁移不为旧来源开启自动整理。 */
export const automaticIngestionMigrationSql = `
ALTER TABLE source_rule_preview ADD COLUMN automatic_preview_id TEXT;
CREATE TABLE source_automatic_consent (
 source_id TEXT NOT NULL REFERENCES source_rule(id), scope_hash TEXT NOT NULL,
 preview_id TEXT NOT NULL REFERENCES ingestion_preview(id), summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
 acknowledged_at TEXT NOT NULL, PRIMARY KEY(source_id,scope_hash)
);
CREATE TABLE ingestion_automatic (
 id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES ingestion_candidate(id),
 source_id TEXT NOT NULL REFERENCES source_rule(id), context TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING','RECOGNIZING','PREVIEWING','CONFIRMING','SUBMITTED','NEEDS_REVIEW')),
 task_id TEXT REFERENCES media_task(id), preview_id TEXT REFERENCES ingestion_preview(id), operation_id TEXT REFERENCES ingestion_operation(id),
 selection_json TEXT CHECK(selection_json IS NULL OR json_valid(selection_json)),
 recognition_key TEXT NOT NULL UNIQUE, preview_key TEXT NOT NULL UNIQUE, confirmation_key TEXT NOT NULL UNIQUE,
 failure TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;
