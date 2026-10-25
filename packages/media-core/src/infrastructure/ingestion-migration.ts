/** 旧来源不自动取得文件授权；授权必须由 Main 重新核验原卷及目录身份。 */
export const ingestionMigrationSql = `
CREATE TABLE media_target_root (
 id TEXT PRIMARY KEY, grant_json TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 0 CHECK(available IN (0,1))
);
CREATE TABLE ingestion_source (
 source_id TEXT PRIMARY KEY REFERENCES desktop_source(id), mode TEXT NOT NULL CHECK(mode IN ('local','managed')),
 download_root_id TEXT UNIQUE REFERENCES managed_download_root(id), source_grant_json TEXT NOT NULL,
 target_root_id TEXT NOT NULL REFERENCES media_target_root(id), source_version INTEGER NOT NULL,
 available INTEGER NOT NULL DEFAULT 0 CHECK(available IN (0,1)),
 CHECK((mode='managed' AND download_root_id IS NOT NULL) OR (mode='local' AND download_root_id IS NULL))
);
CREATE TABLE media_library_route (
 media_type TEXT PRIMARY KEY CHECK(media_type IN ('MOVIE','TV_SHOW')), target_root_id TEXT NOT NULL REFERENCES media_target_root(id)
);
CREATE TABLE ingestion_candidate (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES desktop_source(id), relative_json TEXT NOT NULL,
 version_key TEXT NOT NULL, snapshot_json TEXT NOT NULL, expected_sha256 TEXT,
 managed_item_id TEXT REFERENCES download_item(id), managed_version_key TEXT,
 state TEXT NOT NULL CHECK(state IN ('OBSERVING','READY','UNAVAILABLE','SUPERSEDED','QUEUED','PROCESSED','SKIPPED')),
 task_id TEXT UNIQUE REFERENCES media_task(id), reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(source_id,relative_json,version_key), UNIQUE(managed_item_id,managed_version_key),
 CHECK((managed_item_id IS NULL)=(managed_version_key IS NULL))
);
CREATE INDEX ingestion_candidate_scan ON ingestion_candidate(source_id,state,updated_at);
CREATE TABLE ingestion_preview (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES media_task(id),
 input_hash TEXT NOT NULL, plan_json TEXT NOT NULL, expires_at INTEGER NOT NULL, operation_id TEXT
);
CREATE TABLE ingestion_operation (
 id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES ingestion_candidate(id), task_id TEXT NOT NULL UNIQUE REFERENCES media_task(id),
 request_key TEXT NOT NULL UNIQUE, target_root_id TEXT NOT NULL REFERENCES media_target_root(id), target_slot TEXT NOT NULL,
 plan_json TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
 phase TEXT NOT NULL CHECK(phase IN ('PLANNED','COPYING','VERIFIED','FILE_COMMITTED','RECORDED','NEEDS_ATTENTION')),
 evidence_json TEXT, failure_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(target_root_id,target_slot)
);
CREATE TABLE emby_connection (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL, server_id TEXT NOT NULL,
 base_url TEXT NOT NULL, valid INTEGER NOT NULL DEFAULT 1, verified_at TEXT NOT NULL
);
CREATE TABLE emby_library (
 connection_id TEXT NOT NULL REFERENCES emby_connection(id), library_id TEXT NOT NULL, library_path TEXT NOT NULL,
 target_root_id TEXT NOT NULL REFERENCES media_target_root(id), PRIMARY KEY(connection_id,target_root_id)
);
CREATE TABLE emby_refresh_window (
 connection_id TEXT NOT NULL REFERENCES emby_connection(id), connection_version INTEGER NOT NULL, next_refresh_at INTEGER NOT NULL,
 PRIMARY KEY(connection_id,connection_version)
);
CREATE TABLE emby_delivery (
 task_id TEXT PRIMARY KEY REFERENCES media_task(id), operation_id TEXT NOT NULL UNIQUE REFERENCES ingestion_operation(id),
 connection_id TEXT REFERENCES emby_connection(id), connection_version INTEGER,
 state TEXT NOT NULL CHECK(state IN ('REFRESH_PENDING','WAITING_LIBRARY','COLLECTED','NEEDS_ATTENTION')),
 refresh_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, check_started_at INTEGER,
 last_failure TEXT, emby_item_id TEXT, updated_at TEXT NOT NULL
);
`;
export const ingestionAccessoryMigrationSql = `
CREATE TABLE ingestion_accessory (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES ingestion_operation(id), target_root_id TEXT NOT NULL REFERENCES media_target_root(id),
 plan_json TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
 phase TEXT NOT NULL CHECK(phase IN ('PLANNED','COPYING','VERIFIED','FILE_COMMITTED','RECORDED','NEEDS_ATTENTION')),
 evidence_json TEXT, failure_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX ingestion_accessory_parent ON ingestion_accessory(operation_id,phase);
`;
