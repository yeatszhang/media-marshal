export const cloudDownloadMigrationSql = `
CREATE TABLE download_item_runtime (
  item_id TEXT PRIMARY KEY REFERENCES download_item(id), attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  retry_after TEXT, bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes>=0), speed REAL NOT NULL DEFAULT 0 CHECK(speed>=0), total_bytes INTEGER,
  sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence>=0)
);
CREATE TABLE download_attempt_item (
  attempt_id TEXT NOT NULL REFERENCES download_attempt(id), item_id TEXT NOT NULL REFERENCES download_item(id),
  PRIMARY KEY(attempt_id,item_id)
);
CREATE TABLE download_control (
  request_key TEXT PRIMARY KEY CHECK(length(request_key)=36), job_id TEXT NOT NULL REFERENCES download_job(id),
  operation TEXT NOT NULL CHECK(operation IN ('pause','resume','cancel','retry')), created_at TEXT NOT NULL
);
CREATE TABLE cloud_account_backoff (
  account_id TEXT PRIMARY KEY REFERENCES cloud_account(id), until_at TEXT NOT NULL
);
`;
