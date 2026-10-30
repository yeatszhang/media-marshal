import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sourceConfigurationSchema, syncSourceConfigurationSchema, type SourceConfiguration } from "@media-marshal/contracts";
import { managedRootGrantSchema } from "@media-marshal/contracts/internal";
import { legacySyncFilters } from "../sources/legacy-sync-filters.js";

/** 独立来源的配置预览、执行意图和本地文件提交各自持久化。 */
export const independentSyncMigrationSql = `
CREATE TABLE configuration_command (
 request_key TEXT PRIMARY KEY, signature TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json))
);
CREATE TABLE sync_configuration_preview (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sync_source_rule(id), request_key TEXT NOT NULL UNIQUE,
 version INTEGER NOT NULL, draft_revision INTEGER NOT NULL, lifecycle_revision INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), download_preview_id TEXT REFERENCES cloud_preview(id),
 local_preview_id TEXT, mode TEXT NOT NULL CHECK(mode IN ('configuration','execution')), force INTEGER NOT NULL CHECK(force IN (0,1)),
 rebind_default INTEGER NOT NULL CHECK(rebind_default IN (0,1)), default_dependency INTEGER NOT NULL CHECK(default_dependency IN (0,1)),
 state TEXT NOT NULL CHECK(state IN ('READY','APPLIED','EXPIRED')),
 expires_at INTEGER NOT NULL
);
CREATE TABLE sync_runtime (
 source_id TEXT PRIMARY KEY REFERENCES sync_source_rule(id), next_scan_at INTEGER, failure TEXT,
 claimed INTEGER NOT NULL DEFAULT 0 CHECK(claimed IN (0,1)), edited INTEGER NOT NULL DEFAULT 0 CHECK(edited IN (0,1)), legacy_fingerprint TEXT
);
CREATE TABLE sync_periodic_preview (
 source_id TEXT PRIMARY KEY REFERENCES sync_source_rule(id), preview_id TEXT NOT NULL REFERENCES sync_configuration_preview(id)
);
CREATE TABLE legacy_configuration_owner (
 source_id TEXT PRIMARY KEY REFERENCES source_rule(id),
 sync_claimed INTEGER NOT NULL DEFAULT 0 CHECK(sync_claimed IN (0,1)),
 recognition_claimed INTEGER NOT NULL DEFAULT 0 CHECK(recognition_claimed IN (0,1))
);
CREATE TABLE sync_job (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sync_source_rule(id), source_version INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), request_key TEXT NOT NULL UNIQUE,
 preview_id TEXT, download_job_id TEXT REFERENCES download_job(id),
 state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','DONE','NEEDS_ATTENTION','CANCELED')),
 failure TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE sync_cloud_demand (
 job_id TEXT PRIMARY KEY REFERENCES download_job(id), sync_job_id TEXT NOT NULL REFERENCES sync_job(id),
 source_id TEXT NOT NULL REFERENCES sync_source_rule(id), source_version INTEGER NOT NULL
);
CREATE TABLE local_sync_preview (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, signature TEXT NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), files_json TEXT NOT NULL CHECK(json_valid(files_json)),
 force INTEGER NOT NULL CHECK(force IN (0,1)), expires_at INTEGER NOT NULL, job_id TEXT REFERENCES sync_job(id)
);
CREATE TABLE local_sync_operation (
 id TEXT PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE, source_namespace TEXT NOT NULL,
 source_object_key TEXT NOT NULL, source_version_key TEXT NOT NULL, version_json TEXT NOT NULL CHECK(json_valid(version_json)),
 target_directory_id TEXT NOT NULL REFERENCES configuration_directory(id), target_slot TEXT NOT NULL,
 plan_json TEXT NOT NULL CHECK(json_valid(plan_json)), attempt_id TEXT NOT NULL UNIQUE,
 phase TEXT NOT NULL CHECK(phase IN ('PLANNED','COPYING','VERIFIED','RECORDED','NEEDS_ATTENTION')),
 evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)), failure TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE local_sync_member (
 job_id TEXT NOT NULL REFERENCES sync_job(id), ordinal INTEGER NOT NULL,
 relative_path TEXT NOT NULL, operation_id TEXT REFERENCES local_sync_operation(id), receipt_id TEXT REFERENCES sync_receipt(id),
 state TEXT NOT NULL CHECK(state IN ('PENDING','REUSED','REMOVED','DONE','NEEDS_ATTENTION')),
 failure TEXT, PRIMARY KEY(job_id,ordinal)
);
CREATE INDEX local_sync_member_operation ON local_sync_member(operation_id,job_id);
`;

export function legacyConfigurationFingerprint(db: Database.Database, id: string) {
  const row = db.prepare("SELECT r.version,r.draft_revision,r.lifecycle_revision,r.paused,r.deleted_at,r.draft_json,v.configuration_json FROM source_rule r LEFT JOIN source_rule_version v ON v.source_id=r.id AND v.version=r.version WHERE r.id=?").get(id);
  return row ? createHash("sha256").update(JSON.stringify(row)).digest("hex") : null;
}
export function projectLegacyCloudSync(configuration: Extract<SourceConfiguration, { type: "cloud" }>) { return syncSourceConfigurationSchema.parse({ type: "cloud", name: configuration.name, accountId: configuration.accountId, remoteRef: configuration.remoteRef, target: { kind: "directory", directoryId: configuration.downloadRootId }, filters: legacySyncFilters(configuration.filters) ?? [{ action: "exclude", pattern: "**", caseSensitive: true }], periodic: configuration.periodic }); }

/** 补齐 v28 后旧入口产生的变动；追加快照而不改写已发布迁移或原版本。 */
export function migrateIndependentSync(db: Database.Database) {
  const stamp = new Date().toISOString();
  for (const root of db.prepare("SELECT id,canonical_path,volume_identity FROM managed_download_root").all() as { id: string; canonical_path: string; volume_identity: string }[]) {
    const grant = managedRootGrantSchema.safeParse({ id: root.id, path: root.canonical_path, volume: JSON.parse(root.volume_identity) });
    if (!db.prepare("SELECT 1 FROM configuration_directory WHERE id=?").get(root.id)) db.prepare("INSERT INTO configuration_directory(id,version,path,grant_json,kind,legacy_id,created_at) VALUES(?,1,?,?,'managed',?,?)").run(root.id, root.canonical_path, grant.success ? JSON.stringify(grant.data) : null, root.id, stamp);
  }
  const rows = db.prepare("SELECT r.*,v.configuration_json FROM source_rule r LEFT JOIN source_rule_version v ON v.source_id=r.id AND v.version=r.version ORDER BY r.id").all() as { id: string; type: string; version: number; draft_revision: number; lifecycle_revision: number; paused: number; deleted_at: string | null; draft_json: string; configuration_json: string | null; created_at: string; updated_at: string }[];
  for (const row of rows) {
    db.prepare("INSERT INTO legacy_configuration_owner(source_id) VALUES(?)").run(row.id);
    if (row.type !== "cloud") continue;
    const draft = sourceConfigurationSchema.parse(JSON.parse(row.draft_json)), active = row.configuration_json ? sourceConfigurationSchema.parse(JSON.parse(row.configuration_json)) : null;
    if (draft.type !== "cloud" || active && active.type !== "cloud") throw new Error("旧网盘来源类型不一致，已停止独立同步迁移");
    const config = active ? projectLegacyCloudSync(active) : null, projected = projectLegacyCloudSync(draft);
    const existing = db.prepare("SELECT * FROM sync_source_rule WHERE id=?").get(row.id) as { version: number; draft_revision: number; lifecycle_revision: number; paused: number; deleted_at: string | null; draft_json: string } | undefined;
    const oldSnapshot = existing ? db.prepare("SELECT snapshot_json FROM sync_source_version WHERE source_id=? AND version=?").get(row.id, existing.version) as { snapshot_json: string } | undefined : undefined;
    const changed = !existing || existing.version !== row.version || existing.draft_revision !== row.draft_revision || existing.lifecycle_revision !== row.lifecycle_revision || existing.paused !== row.paused || existing.deleted_at !== row.deleted_at || !isDeepStrictEqual(JSON.parse(existing.draft_json), projected) || config && !isDeepStrictEqual(oldSnapshot ? JSON.parse(oldSnapshot.snapshot_json).configuration : null, config);
    if (changed) {
      const version = active ? existing ? Math.max(existing.version, row.version) + 1 : row.version : existing?.version ?? 0;
      const review = JSON.stringify(["LEGACY_SCOPE_REVIEW_REQUIRED"]);
      db.prepare("INSERT INTO sync_source_rule(id,version,draft_revision,lifecycle_revision,draft_json,paused,deleted_at,review_json,legacy_configuration_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,draft_revision=excluded.draft_revision,lifecycle_revision=excluded.lifecycle_revision,draft_json=excluded.draft_json,paused=excluded.paused,deleted_at=excluded.deleted_at,review_json=excluded.review_json,legacy_configuration_json=excluded.legacy_configuration_json,updated_at=excluded.updated_at").run(row.id, version, Math.max(existing?.draft_revision ?? 0, row.draft_revision) + 1, row.lifecycle_revision, JSON.stringify(projected), row.paused, row.deleted_at, review, JSON.stringify({ draft, configuration: active }), row.created_at, stamp);
      if (config?.type === "cloud" && active?.type === "cloud" && legacySyncFilters(active.filters) !== null) {
        const target = db.prepare("SELECT id,version,path FROM configuration_directory WHERE id=?").get(active.downloadRootId);
        if (target) db.prepare("INSERT INTO sync_source_version VALUES(?,?,?)").run(row.id, version, JSON.stringify({ sourceId: row.id, sourceVersion: version, configuration: config, inputDirectory: null, targetDirectory: target, defaultDirectoryVersion: null }));
      }
    }
    db.prepare("INSERT INTO sync_runtime(source_id,legacy_fingerprint) VALUES(?,?)").run(row.id, legacyConfigurationFingerprint(db, row.id));
  }
}
