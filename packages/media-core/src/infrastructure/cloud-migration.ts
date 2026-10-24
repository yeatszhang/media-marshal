// 云端业务事实独立于组件私有数据库；不保存 Cookie、URL、组件配置或命令行。
export const cloudMigrationSql = `
CREATE TABLE cloud_account (
  id TEXT PRIMARY KEY CHECK(length(id)=36), name TEXT NOT NULL,
  provider_kind TEXT NOT NULL CHECK(provider_kind='quark'),
  status TEXT NOT NULL CHECK(status IN ('UNCONFIGURED','READY','AUTH_REQUIRED','RESELECT_REQUIRED','DISCONNECTED','UNAVAILABLE')),
  credential_ref TEXT CHECK(credential_ref IS NULL OR (length(credential_ref)=36 AND substr(credential_ref,9,1)='-' AND substr(credential_ref,14,1)='-' AND substr(credential_ref,19,1)='-' AND substr(credential_ref,24,1)='-' AND replace(lower(credential_ref),'-','') NOT GLOB '*[^0-9a-f]*')),
  capabilities_json TEXT CHECK(capabilities_json IS NULL OR json_valid(capabilities_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE provider_binding (
  id TEXT PRIMARY KEY CHECK(length(id)=36), account_id TEXT NOT NULL REFERENCES cloud_account(id),
  implementation_id TEXT NOT NULL, configuration_version INTEGER NOT NULL CHECK(configuration_version>0),
  generation TEXT NOT NULL UNIQUE CHECK(length(generation)=36),
  state TEXT NOT NULL CHECK(state IN ('CANDIDATE','ACTIVE','RETIRED')),
  identity_key TEXT CHECK(identity_key IS NULL OR (length(identity_key)=64 AND identity_key NOT GLOB '*[^0-9a-f]*')), created_at TEXT NOT NULL,
  UNIQUE(id,account_id), UNIQUE(id,generation)
);
CREATE UNIQUE INDEX provider_binding_active ON provider_binding(account_id) WHERE state='ACTIVE';
CREATE TABLE managed_download_root (
  id TEXT PRIMARY KEY CHECK(length(id)=36), grant_id TEXT NOT NULL UNIQUE CHECK(length(grant_id)=36),
  canonical_path TEXT NOT NULL UNIQUE, volume_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('AVAILABLE','UNAVAILABLE','REVIEW_REQUIRED')),
  created_at TEXT NOT NULL
);
CREATE TABLE remote_entry (
  id TEXT PRIMARY KEY CHECK(length(id)=36), account_id TEXT NOT NULL REFERENCES cloud_account(id),
  parent_ref TEXT, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('file','directory')),
  size INTEGER CHECK(size IS NULL OR size>=0), modified_at TEXT,
  version_json TEXT CHECK(version_json IS NULL OR json_valid(version_json)),
  last_scan_id TEXT REFERENCES cloud_scan(id), observed_at TEXT NOT NULL,
  UNIQUE(id,account_id),
  FOREIGN KEY(parent_ref,account_id) REFERENCES remote_entry(id,account_id)
);
CREATE INDEX remote_entry_parent ON remote_entry(account_id,parent_ref,id);
CREATE TABLE remote_binding (
  remote_ref TEXT NOT NULL, binding_id TEXT NOT NULL, account_id TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)), locator_key TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(remote_ref,binding_id), UNIQUE(binding_id,locator_key),
  FOREIGN KEY(remote_ref,account_id) REFERENCES remote_entry(id,account_id),
  FOREIGN KEY(binding_id,account_id) REFERENCES provider_binding(id,account_id)
);
CREATE TABLE cloud_subscription (
  id TEXT PRIMARY KEY CHECK(length(id)=36), account_id TEXT NOT NULL REFERENCES cloud_account(id),
  remote_root_ref TEXT NOT NULL, target_root_id TEXT NOT NULL REFERENCES managed_download_root(id),
  filters_json TEXT NOT NULL CHECK(json_valid(filters_json)), interval_seconds INTEGER NOT NULL CHECK(interval_seconds BETWEEN 60 AND 604800),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), configuration_version INTEGER NOT NULL CHECK(configuration_version>0),
  confirmed_preview_id TEXT REFERENCES cloud_preview(id), last_scan_at TEXT, next_scan_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(id,account_id),
  FOREIGN KEY(remote_root_ref,account_id) REFERENCES remote_entry(id,account_id),
  FOREIGN KEY(confirmed_preview_id,account_id) REFERENCES cloud_preview(id,account_id),
  CHECK(enabled=0 OR confirmed_preview_id IS NOT NULL)
);
CREATE INDEX cloud_subscription_due ON cloud_subscription(enabled,next_scan_at);
CREATE TABLE cloud_scan (
  id TEXT PRIMARY KEY CHECK(length(id)=36), subscription_id TEXT REFERENCES cloud_subscription(id),
  account_id TEXT NOT NULL REFERENCES cloud_account(id), remote_root_ref TEXT NOT NULL,
  generation TEXT NOT NULL CHECK(length(generation)=36), configuration_version INTEGER NOT NULL CHECK(configuration_version>0),
  state TEXT NOT NULL CHECK(state IN ('SCANNING','COMPLETE','INCOMPLETE','FAILED','ABANDONED')),
  cursor TEXT, started_at TEXT NOT NULL, completed_at TEXT,
  FOREIGN KEY(subscription_id,account_id) REFERENCES cloud_subscription(id,account_id),
  FOREIGN KEY(remote_root_ref,account_id) REFERENCES remote_entry(id,account_id),
  CHECK(state!='COMPLETE' OR (cursor IS NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX cloud_scan_active ON cloud_scan(subscription_id) WHERE state='SCANNING';
CREATE TABLE cloud_preview (
  id TEXT PRIMARY KEY CHECK(length(id)=36), account_id TEXT NOT NULL REFERENCES cloud_account(id),
  remote_root_ref TEXT NOT NULL, target_root_id TEXT NOT NULL REFERENCES managed_download_root(id),
  request_key TEXT NOT NULL UNIQUE CHECK(length(request_key)=36),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  state TEXT NOT NULL CHECK(state IN ('BUILDING','READY','CONFIRMED','EXPIRED')),
  configuration_version INTEGER NOT NULL CHECK(configuration_version>0),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, UNIQUE(id,account_id),
  FOREIGN KEY(remote_root_ref,account_id) REFERENCES remote_entry(id,account_id)
);
CREATE TABLE download_job (
  id TEXT PRIMARY KEY CHECK(length(id)=36), account_id TEXT NOT NULL REFERENCES cloud_account(id),
  subscription_id TEXT REFERENCES cloud_subscription(id), preview_id TEXT NOT NULL REFERENCES cloud_preview(id),
  request_key TEXT NOT NULL UNIQUE CHECK(length(request_key)=36),
  state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','VERIFYING','COMMITTING','COMPLETED','PAUSING','PAUSED','CANCELLING','CANCELLED','RETRY_WAIT','AUTH_REQUIRED','FAILED','BLOCKED_LOCAL','RECONCILING')),
  configuration_version INTEGER NOT NULL CHECK(configuration_version>0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(id,account_id),
  FOREIGN KEY(subscription_id,account_id) REFERENCES cloud_subscription(id,account_id),
  FOREIGN KEY(preview_id,account_id) REFERENCES cloud_preview(id,account_id)
);
CREATE INDEX download_job_updated ON download_job(updated_at DESC,id);
CREATE TABLE download_item (
  id TEXT PRIMARY KEY CHECK(length(id)=36), account_id TEXT NOT NULL REFERENCES cloud_account(id), remote_ref TEXT NOT NULL,
  version_key TEXT NOT NULL CHECK(length(version_key)=64 AND version_key NOT GLOB '*[^0-9a-f]*'), version_json TEXT NOT NULL CHECK(json_valid(version_json)),
  request_variant TEXT NOT NULL DEFAULT '', target_root_id TEXT NOT NULL REFERENCES managed_download_root(id),
  target_path_key TEXT NOT NULL, target_segments_json TEXT NOT NULL CHECK(json_valid(target_segments_json)),
  expected_size INTEGER NOT NULL CHECK(expected_size>=0),
  state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','VERIFYING','COMMITTING','COMPLETED','PAUSING','PAUSED','CANCELLING','CANCELLED','RETRY_WAIT','AUTH_REQUIRED','FAILED','BLOCKED_LOCAL','RECONCILING')),
  local_sha256 TEXT, completed_size INTEGER CHECK(completed_size IS NULL OR completed_size>=0),
  failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN ('AUTH_REQUIRED','RATE_LIMITED','NETWORK_UNAVAILABLE','REMOTE_CHANGED','REMOTE_NOT_FOUND','LOCAL_UNAVAILABLE','UNSUPPORTED_CAPABILITY','COMPONENT_UNAVAILABLE','CONFLICT','INVALID_REQUEST','INTERRUPTED','TIMEOUT','INTERNAL_ERROR')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(id,account_id), UNIQUE(id,version_key), UNIQUE(id,target_root_id,target_path_key),
  UNIQUE(account_id,remote_ref,version_key,request_variant,target_root_id,target_path_key),
  FOREIGN KEY(remote_ref,account_id) REFERENCES remote_entry(id,account_id),
  CHECK(state!='COMPLETED' OR (local_sha256 IS NOT NULL AND length(local_sha256)=64 AND local_sha256 NOT GLOB '*[^0-9a-f]*' AND completed_size IS NOT NULL AND completed_size=expected_size))
);
CREATE INDEX download_item_queue ON download_item(account_id,state,created_at,id);
CREATE TABLE download_job_item (
  job_id TEXT NOT NULL, item_id TEXT NOT NULL, account_id TEXT NOT NULL,
  demand_state TEXT NOT NULL CHECK(demand_state IN ('ACTIVE','CANCELLED')),
  PRIMARY KEY(job_id,item_id),
  FOREIGN KEY(job_id,account_id) REFERENCES download_job(id,account_id),
  FOREIGN KEY(item_id,account_id) REFERENCES download_item(id,account_id)
);
CREATE INDEX download_item_demands ON download_job_item(item_id,demand_state);
CREATE TABLE download_attempt (
  id TEXT PRIMARY KEY CHECK(length(id)=36), account_id TEXT NOT NULL, binding_id TEXT NOT NULL,
  core_generation TEXT NOT NULL CHECK(length(core_generation)=36), binding_generation TEXT NOT NULL CHECK(length(binding_generation)=36),
  host_generation TEXT NOT NULL CHECK(length(host_generation)=36), idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),
  execution_id TEXT UNIQUE, staging_key TEXT NOT NULL UNIQUE CHECK(length(staging_key)=36),
  state TEXT NOT NULL CHECK(state IN ('CLAIMED','RUNNING','STOPPING','STOPPED','EXITED','UNCERTAIN')),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)), retries INTEGER NOT NULL DEFAULT 0 CHECK(retries>=0),
  exit_code INTEGER, stop_evidence_json TEXT CHECK(stop_evidence_json IS NULL OR json_valid(stop_evidence_json)),
  created_at TEXT NOT NULL, stopped_at TEXT, UNIQUE(id,account_id),
  FOREIGN KEY(binding_id,account_id) REFERENCES provider_binding(id,account_id),
  FOREIGN KEY(binding_id,binding_generation) REFERENCES provider_binding(id,generation),
  CHECK(state NOT IN ('STOPPED','EXITED') OR (stopped_at IS NOT NULL AND stop_evidence_json IS NOT NULL))
);
CREATE UNIQUE INDEX download_account_writer ON download_attempt(account_id) WHERE state IN ('CLAIMED','RUNNING','STOPPING','UNCERTAIN');
CREATE TABLE download_claim (
  item_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, account_id TEXT NOT NULL,
  target_root_id TEXT NOT NULL, target_path_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0), UNIQUE(attempt_id,ordinal), UNIQUE(target_root_id,target_path_key),
  FOREIGN KEY(item_id,account_id) REFERENCES download_item(id,account_id),
  FOREIGN KEY(attempt_id,account_id) REFERENCES download_attempt(id,account_id),
  FOREIGN KEY(item_id,target_root_id,target_path_key) REFERENCES download_item(id,target_root_id,target_path_key)
);
CREATE TABLE download_commit_intent (
  item_id TEXT PRIMARY KEY REFERENCES download_item(id), attempt_id TEXT NOT NULL REFERENCES download_attempt(id),
  account_id TEXT NOT NULL,
  version_key TEXT NOT NULL, local_sha256 TEXT NOT NULL CHECK(length(local_sha256)=64), size INTEGER NOT NULL CHECK(size>=0),
  file_evidence_json TEXT NOT NULL CHECK(json_valid(file_evidence_json)),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','COMMITTED','RECORDED','RECONCILING')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(item_id,version_key) REFERENCES download_item(id,version_key),
  FOREIGN KEY(item_id,account_id) REFERENCES download_item(id,account_id),
  FOREIGN KEY(attempt_id,account_id) REFERENCES download_attempt(id,account_id)
);
CREATE TABLE ingestion_outbox (
  id TEXT PRIMARY KEY CHECK(length(id)=36), item_id TEXT NOT NULL, version_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','DELIVERING','ACKNOWLEDGED')),
  candidate_id TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempts>=0),
  next_attempt_at TEXT, failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN ('AUTH_REQUIRED','RATE_LIMITED','NETWORK_UNAVAILABLE','REMOTE_CHANGED','REMOTE_NOT_FOUND','LOCAL_UNAVAILABLE','UNSUPPORTED_CAPABILITY','COMPONENT_UNAVAILABLE','CONFLICT','INVALID_REQUEST','INTERRUPTED','TIMEOUT','INTERNAL_ERROR')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(item_id,version_key), FOREIGN KEY(item_id,version_key) REFERENCES download_item(id,version_key),
  CHECK(state!='ACKNOWLEDGED' OR candidate_id IS NOT NULL)
);
CREATE INDEX ingestion_outbox_due ON ingestion_outbox(state,next_attempt_at);
CREATE TRIGGER ingestion_outbox_completed BEFORE INSERT ON ingestion_outbox
WHEN (SELECT state FROM download_item WHERE id=NEW.item_id)!='COMPLETED'
BEGIN SELECT RAISE(ABORT,'尚未提交的下载项不能投递'); END;
`;
