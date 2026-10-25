export const sourceExecutionPreviewMigrationSql = `
ALTER TABLE source_rule_run ADD COLUMN force_redownload INTEGER NOT NULL DEFAULT 0 CHECK(force_redownload IN (0,1));
ALTER TABLE source_rule_run_request ADD COLUMN preview_id TEXT REFERENCES cloud_preview(id);
DROP INDEX source_rule_run_active;
CREATE UNIQUE INDEX source_rule_run_active ON source_rule_run(source_id,source_version,force_redownload) WHERE state IN ('QUEUED','SCANNING');
CREATE TABLE source_rule_execution_preview (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_version INTEGER NOT NULL,
 request_key TEXT NOT NULL UNIQUE, force_redownload INTEGER NOT NULL CHECK(force_redownload IN (0,1)),
 download_preview_id TEXT NOT NULL REFERENCES cloud_preview(id), run_id TEXT REFERENCES source_rule_run(id),
 expires_at INTEGER NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(source_id,source_version) REFERENCES source_rule_version(source_id,version)
);
CREATE TABLE source_rule_execution_confirmation (
 request_key TEXT PRIMARY KEY, preview_id TEXT NOT NULL REFERENCES source_rule_execution_preview(id),
 run_id TEXT NOT NULL REFERENCES source_rule_run(id)
);
`;
