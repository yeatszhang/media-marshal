/** 来源聚合只管理配置和关联；版本快照不承载执行状态或凭据。 */
export const sourceRuleMigrationSql = `
CREATE TABLE source_rule (
 id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('local','cloud')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), draft_revision INTEGER NOT NULL CHECK(draft_revision>0),
 draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
 paused INTEGER NOT NULL DEFAULT 1 CHECK(paused IN (0,1)), review_required INTEGER NOT NULL DEFAULT 0 CHECK(review_required IN (0,1)),
 local_source_id TEXT UNIQUE REFERENCES desktop_source(id), subscription_id TEXT UNIQUE REFERENCES cloud_subscription(id),
 ingestion_source_id TEXT REFERENCES desktop_source(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(type!='local' OR (subscription_id IS NULL AND ingestion_source_id IS NULL)),
 CHECK(type!='cloud' OR local_source_id IS NULL),
 CHECK(version>0 OR (paused=1 AND local_source_id IS NULL AND subscription_id IS NULL AND ingestion_source_id IS NULL))
);
CREATE TABLE source_rule_version (
 source_id TEXT NOT NULL REFERENCES source_rule(id), version INTEGER NOT NULL CHECK(version>0),
 configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)),
 local_source_id TEXT REFERENCES desktop_source(id), subscription_id TEXT REFERENCES cloud_subscription(id),
 ingestion_source_id TEXT REFERENCES desktop_source(id), target_root_id TEXT REFERENCES media_target_root(id),
 created_at TEXT NOT NULL, PRIMARY KEY(source_id,version)
);
CREATE TRIGGER source_rule_version_immutable BEFORE UPDATE ON source_rule_version
BEGIN SELECT RAISE(ABORT,'来源版本快照不可修改'); END;
CREATE TABLE source_rule_command (
 request_key TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_rule(id),
 signature TEXT NOT NULL CHECK(length(signature)=64), operation TEXT NOT NULL CHECK(operation IN ('configure','apply')),
 created_at TEXT NOT NULL
);
CREATE TABLE source_rule_preview (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_rule(id), version INTEGER NOT NULL,
 draft_revision INTEGER NOT NULL, request_key TEXT NOT NULL UNIQUE, configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)),
 download_preview_id TEXT REFERENCES cloud_preview(id), state TEXT NOT NULL CHECK(state IN ('READY','APPLIED','EXPIRED')),
 expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE download_source_demand (
 job_id TEXT PRIMARY KEY REFERENCES download_job(id), source_id TEXT NOT NULL, source_version INTEGER NOT NULL,
 FOREIGN KEY(source_id,source_version) REFERENCES source_rule_version(source_id,version)
);
CREATE INDEX download_source_demand_owner ON download_source_demand(source_id,source_version,job_id);
CREATE TRIGGER download_source_demand_immutable BEFORE UPDATE ON download_source_demand
BEGIN SELECT RAISE(ABORT,'下载来源快照不可修改'); END;
`;
