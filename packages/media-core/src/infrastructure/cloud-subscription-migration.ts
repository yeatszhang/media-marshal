export const cloudSubscriptionMigrationSql = `
CREATE TABLE cloud_subscription_runtime (
  subscription_id TEXT PRIMARY KEY REFERENCES cloud_subscription(id),
  state TEXT NOT NULL CHECK(state IN ('IDLE','SCANNING','RETRY_WAIT','PAUSED','AUTH_REQUIRED','BLOCKED_LOCAL','RESELECT_REQUIRED','FAILED','CANCELLED')),
  failure_json TEXT CHECK(failure_json IS NULL OR json_valid(failure_json)),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 3), retry_after TEXT, last_recovery_generation TEXT,
  last_files INTEGER NOT NULL DEFAULT 0 CHECK(last_files>=0), last_bytes INTEGER NOT NULL DEFAULT 0 CHECK(last_bytes>=0),
  last_reused INTEGER NOT NULL DEFAULT 0 CHECK(last_reused>=0), last_conflicts INTEGER NOT NULL DEFAULT 0 CHECK(last_conflicts>=0),
  last_complete INTEGER NOT NULL DEFAULT 0 CHECK(last_complete IN (0,1)), last_job_id TEXT REFERENCES download_job(id)
);
CREATE TABLE cloud_subscription_command (
  request_key TEXT PRIMARY KEY CHECK(length(request_key)=36), subscription_id TEXT NOT NULL REFERENCES cloud_subscription(id),
  operation TEXT NOT NULL CHECK(operation IN ('configure','scan','pause','resume','cancel')),
  signature TEXT NOT NULL CHECK(length(signature)=64), created_at TEXT NOT NULL
);
CREATE TABLE cloud_global_pause_job (
  job_id TEXT PRIMARY KEY REFERENCES download_job(id), created_at TEXT NOT NULL
);
CREATE TABLE cloud_scan_plan (
  scan_id TEXT PRIMARY KEY REFERENCES cloud_scan(id), preview_id TEXT REFERENCES cloud_preview(id) ON DELETE SET NULL,
  execution_preview_id TEXT REFERENCES cloud_preview(id) ON DELETE SET NULL,
  summary_json TEXT CHECK(summary_json IS NULL OR json_valid(summary_json))
);
INSERT INTO cloud_subscription_runtime(subscription_id,state) SELECT id,CASE WHEN enabled=1 THEN 'IDLE' ELSE 'PAUSED' END FROM cloud_subscription;
`;
