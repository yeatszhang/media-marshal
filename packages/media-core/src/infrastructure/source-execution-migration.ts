export const sourceExecutionMigrationSql = `
CREATE TABLE source_rule_control (
 request_key TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_rule(id),
 version INTEGER NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('pause','resume','scan')), created_at TEXT NOT NULL
);
CREATE TABLE source_rule_run (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('QUEUED','SCANNING','SUBMITTED','FAILED','ABANDONED')),
 preview_id TEXT REFERENCES cloud_preview(id), preview_key TEXT NOT NULL UNIQUE,
 job_id TEXT REFERENCES download_job(id), failure_json TEXT CHECK(failure_json IS NULL OR json_valid(failure_json)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(source_id,source_version) REFERENCES source_rule_version(source_id,version)
);
CREATE UNIQUE INDEX source_rule_run_active ON source_rule_run(source_id,source_version) WHERE state IN ('QUEUED','SCANNING');
CREATE TABLE source_rule_run_request (
 request_key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES source_rule_run(id), source_id TEXT NOT NULL, version INTEGER NOT NULL
);
CREATE TABLE source_rule_pause_job (
 source_id TEXT NOT NULL REFERENCES source_rule(id), job_id TEXT NOT NULL REFERENCES download_job(id),
 PRIMARY KEY(source_id,job_id)
);
`;
