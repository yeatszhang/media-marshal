/** 手动补扫意图与执行结果独立于页面等待；不创建识别或文件作业。 */
export const sourceScanMigrationSql = `
CREATE TABLE ingestion_source_scan (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL, physical_source_id TEXT NOT NULL REFERENCES desktop_source(id),
 source_name TEXT NOT NULL, context TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','WAITING_SOURCE','COMPLETED','PARTIAL_FAILED','FAILED')),
 discovered INTEGER NOT NULL DEFAULT 0 CHECK(discovered>=0), failure TEXT,
 next_attempt_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ingestion_source_scan_active ON ingestion_source_scan(source_id) WHERE state IN ('PENDING','RUNNING','WAITING_SOURCE');
CREATE TABLE ingestion_source_scan_request (
 request_key TEXT PRIMARY KEY, source_id TEXT NOT NULL, scan_id TEXT NOT NULL REFERENCES ingestion_source_scan(id)
);
CREATE TABLE ingestion_source_scan_issue (
 scan_id TEXT NOT NULL REFERENCES ingestion_source_scan(id), relative_path TEXT NOT NULL, failure TEXT NOT NULL,
 PRIMARY KEY(scan_id,relative_path)
);
`;
