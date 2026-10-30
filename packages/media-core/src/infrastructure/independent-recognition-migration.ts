import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { recognitionRuleConfigurationSchema, sourceConfigurationSchema } from "@media-marshal/contracts";
import { managedRootGrantSchema } from "@media-marshal/contracts/internal";
import { legacyConfigurationFingerprint, projectLegacyCloudSync } from "./independent-sync-migration.js";
import { legacySyncFilters } from "../sources/legacy-sync-filters.js";

/** 输入不再被迫绑定单一媒体目标；自动意图的所有者可为独立识别规则。 */
export const independentRecognitionMigrationSql = `
CREATE TABLE ingestion_source_v33 (
 source_id TEXT PRIMARY KEY REFERENCES desktop_source(id), mode TEXT NOT NULL CHECK(mode IN ('local','managed')),
 download_root_id TEXT UNIQUE REFERENCES managed_download_root(id), source_grant_json TEXT NOT NULL,
 target_root_id TEXT REFERENCES media_target_root(id), source_version INTEGER NOT NULL,
 available INTEGER NOT NULL DEFAULT 0 CHECK(available IN (0,1)),
 CHECK((mode='managed' AND download_root_id IS NOT NULL) OR (mode='local' AND download_root_id IS NULL))
);
INSERT INTO ingestion_source_v33 SELECT * FROM ingestion_source;
DROP TABLE ingestion_source;
ALTER TABLE ingestion_source_v33 RENAME TO ingestion_source;
CREATE TABLE ingestion_automatic_v33 (
 id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES ingestion_candidate(id),
 source_id TEXT NOT NULL, context TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PENDING','RECOGNIZING','PREVIEWING','CONFIRMING','SUBMITTED','NEEDS_REVIEW')),
 task_id TEXT REFERENCES media_task(id), preview_id TEXT REFERENCES ingestion_preview(id), operation_id TEXT REFERENCES ingestion_operation(id),
 selection_json TEXT CHECK(selection_json IS NULL OR json_valid(selection_json)),
 recognition_key TEXT NOT NULL UNIQUE, preview_key TEXT NOT NULL UNIQUE, confirmation_key TEXT NOT NULL UNIQUE,
 failure TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO ingestion_automatic_v33 SELECT * FROM ingestion_automatic;
DROP TABLE ingestion_automatic;
ALTER TABLE ingestion_automatic_v33 RENAME TO ingestion_automatic;
ALTER TABLE ingestion_source_scan ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'legacy' CHECK(owner_kind IN ('legacy','recognition'));
DROP INDEX ingestion_source_scan_active;
CREATE UNIQUE INDEX ingestion_source_scan_active ON ingestion_source_scan(owner_kind,source_id) WHERE state IN ('PENDING','RUNNING','WAITING_SOURCE');
CREATE TABLE recognition_runtime (
 rule_id TEXT PRIMARY KEY REFERENCES recognition_rule(id), claimed INTEGER NOT NULL DEFAULT 0 CHECK(claimed IN (0,1)),
 edited INTEGER NOT NULL DEFAULT 0 CHECK(edited IN (0,1)), legacy_fingerprint TEXT, failure TEXT, scan_generation INTEGER NOT NULL DEFAULT 0 CHECK(scan_generation>=0)
);
CREATE TABLE recognition_legacy_owner (
 source_id TEXT PRIMARY KEY REFERENCES source_rule(id), rule_id TEXT NOT NULL REFERENCES recognition_rule(id)
);
CREATE TABLE recognition_target_identity (
 id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES recognition_rule(id), directory_id TEXT NOT NULL REFERENCES configuration_directory(id),
 media_type TEXT NOT NULL CHECK(media_type IN ('MOVIE','TV_SHOW')), name TEXT NOT NULL
);
CREATE TRIGGER recognition_target_identity_immutable BEFORE UPDATE OF rule_id,directory_id,media_type ON recognition_target_identity
BEGIN SELECT RAISE(ABORT,'映射目标身份不可改写，请新建目标并保留原任务关联'); END;
CREATE TRIGGER ingestion_automatic_owner BEFORE INSERT ON ingestion_automatic
WHEN NOT EXISTS(SELECT 1 FROM source_rule WHERE id=NEW.source_id) AND NOT EXISTS(SELECT 1 FROM recognition_rule WHERE id=NEW.source_id)
BEGIN SELECT RAISE(ABORT,'自动意图缺少有效配置所有者'); END;
CREATE TABLE recognition_configuration_preview (
 id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES recognition_rule(id), request_key TEXT NOT NULL UNIQUE,
 version INTEGER NOT NULL, draft_revision INTEGER NOT NULL, lifecycle_revision INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), default_dependency INTEGER NOT NULL CHECK(default_dependency IN (0,1)),
 state TEXT NOT NULL CHECK(state IN ('READY','APPLIED','EXPIRED')), expires_at INTEGER NOT NULL
);
CREATE TABLE recognition_input (
 source_id TEXT PRIMARY KEY REFERENCES desktop_source(id), rule_id TEXT NOT NULL REFERENCES recognition_rule(id),
 directory_id TEXT NOT NULL REFERENCES configuration_directory(id), mode TEXT NOT NULL CHECK(mode IN ('ordinary','managed-completed')),
 active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE INDEX recognition_input_owner ON recognition_input(rule_id,active);
CREATE TABLE recognition_receipt (
 receipt_id TEXT PRIMARY KEY REFERENCES sync_receipt(id), source_id TEXT NOT NULL REFERENCES desktop_source(id),
 candidate_id TEXT REFERENCES ingestion_candidate(id), state TEXT NOT NULL CHECK(state IN ('ACCEPTED','UNAVAILABLE')),
 failure TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX recognition_receipt_candidate ON recognition_receipt(candidate_id);
CREATE TABLE recognition_automatic_consent (
 rule_id TEXT NOT NULL REFERENCES recognition_rule(id), rule_version INTEGER NOT NULL,
 sample_preview_id TEXT NOT NULL REFERENCES ingestion_preview(id), scope_hash TEXT NOT NULL, acknowledged_at TEXT NOT NULL,
 PRIMARY KEY(rule_id,rule_version)
);
CREATE TABLE emby_library_v33 (
 connection_id TEXT NOT NULL REFERENCES emby_connection(id), library_id TEXT NOT NULL, library_path TEXT NOT NULL,
 target_root_id TEXT NOT NULL, binding_json TEXT CHECK(binding_json IS NULL OR json_valid(binding_json)),
 PRIMARY KEY(connection_id,target_root_id)
);
INSERT INTO emby_library_v33 SELECT * FROM emby_library;
DROP TABLE emby_library;
ALTER TABLE emby_library_v33 RENAME TO emby_library;
CREATE TRIGGER emby_library_target BEFORE INSERT ON emby_library
WHEN NOT EXISTS(SELECT 1 FROM media_target_root WHERE id=NEW.target_root_id) AND NOT EXISTS(SELECT 1 FROM recognition_target_identity WHERE id=NEW.target_root_id)
BEGIN SELECT RAISE(ABORT,'Emby 关联缺少有效映射目标'); END;
`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stableId = (value: unknown) => { const bytes = Buffer.from(hash(value).slice(0, 32), "hex"); bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128; const s = bytes.toString("hex"); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`; };
export function recognitionLegacyFingerprint(db: Database.Database, ruleId: string) {
  return hash(db.prepare("SELECT s.id,s.version,s.draft_revision,s.lifecycle_revision,s.paused,s.deleted_at,s.draft_json,v.configuration_json FROM recognition_legacy_owner r JOIN source_rule s ON s.id=r.source_id LEFT JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version WHERE r.rule_id=? ORDER BY s.id").all(ruleId));
}
/** v28 后旧入口仍可变更；重新分组当前策略，原快照和文件计划原样保留。 */
export function migrateIndependentRecognition(db: Database.Database) {
  const stamp = new Date().toISOString();
  const directory = (id: string, path: string, kind: "ordinary" | "media" | "managed", raw: string | null) => {
    let grant: string | null = null;
    if (raw) { const parsed = managedRootGrantSchema.safeParse(JSON.parse(raw)); if (parsed.success && parsed.data.id === id && parsed.data.path === path) grant = JSON.stringify(parsed.data); }
    const previous = db.prepare("SELECT path,kind FROM configuration_directory WHERE id=?").get(id) as { path: string; kind: string } | undefined;
    if (previous && (previous.path !== path || previous.kind !== kind)) throw new Error("识别迁移目录身份冲突，已保留原配置并停止升级");
    db.prepare("INSERT INTO configuration_directory(id,version,path,grant_json,kind,legacy_id,created_at) VALUES(?,1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET grant_json=coalesce(configuration_directory.grant_json,excluded.grant_json)").run(id, path, grant, kind, id, stamp);
    return { id, version: 1, path };
  };
  for (const target of db.prepare("SELECT id,grant_json FROM media_target_root").all() as { id: string; grant_json: string }[]) { const parsed = managedRootGrantSchema.parse(JSON.parse(target.grant_json)); directory(target.id, parsed.path, "media", target.grant_json); }
  const rows = db.prepare("SELECT s.*,v.configuration_json,v.target_root_id FROM source_rule s LEFT JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version ORDER BY s.created_at,s.id").all() as { id: string; version: number; draft_revision: number; lifecycle_revision: number; paused: number; deleted_at: string | null; draft_json: string; configuration_json: string | null; target_root_id: string | null; local_source_id: string | null; created_at: string }[];
  for (const root of db.prepare("SELECT id,canonical_path,volume_identity FROM managed_download_root").all() as { id: string; canonical_path: string; volume_identity: string }[]) directory(root.id, root.canonical_path, "managed", JSON.stringify({ id: root.id, path: root.canonical_path, volume: JSON.parse(root.volume_identity) }));
  for (const row of rows) {
    db.prepare("INSERT OR IGNORE INTO legacy_configuration_owner(source_id) VALUES(?)").run(row.id);
    const draft = sourceConfigurationSchema.parse(JSON.parse(row.draft_json)); if (draft.type !== "cloud") continue;
    const runtime = db.prepare("SELECT claimed,edited,legacy_fingerprint FROM sync_runtime WHERE source_id=?").get(row.id) as { claimed: number; edited: number; legacy_fingerprint: string | null } | undefined;
    const fingerprint = legacyConfigurationFingerprint(db, row.id); if (runtime?.claimed || runtime?.legacy_fingerprint === fingerprint || runtime?.edited) continue;
    const old = db.prepare("SELECT version,draft_revision FROM sync_source_rule WHERE id=?").get(row.id) as { version: number; draft_revision: number } | undefined, active = row.configuration_json ? sourceConfigurationSchema.parse(JSON.parse(row.configuration_json)) : null;
    const version = active ? Math.max(old?.version ?? 0, row.version) + 1 : old?.version ?? 0;
    db.prepare("INSERT INTO sync_source_rule VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,draft_revision=excluded.draft_revision,lifecycle_revision=excluded.lifecycle_revision,draft_json=excluded.draft_json,paused=excluded.paused,deleted_at=excluded.deleted_at,review_json=excluded.review_json,legacy_configuration_json=excluded.legacy_configuration_json,updated_at=excluded.updated_at").run(row.id, version, Math.max(old?.draft_revision ?? 0, row.draft_revision) + 1, row.lifecycle_revision, JSON.stringify(projectLegacyCloudSync(draft)), row.paused, row.deleted_at, '["LEGACY_SCOPE_REVIEW_REQUIRED"]', JSON.stringify({ draft, configuration: active }), row.created_at, stamp);
    if (active?.type === "cloud" && legacySyncFilters(active.filters) !== null) { const target = db.prepare("SELECT id,version,path FROM configuration_directory WHERE id=?").get(active.downloadRootId); db.prepare("INSERT INTO sync_source_version VALUES(?,?,?)").run(row.id, version, JSON.stringify({ sourceId: row.id, sourceVersion: version, configuration: projectLegacyCloudSync(active), inputDirectory: null, targetDirectory: target, defaultDirectoryVersion: null })); }
    db.prepare("INSERT INTO sync_runtime(source_id,legacy_fingerprint) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET legacy_fingerprint=excluded.legacy_fingerprint").run(row.id, fingerprint);
  }
  const groups = new Map<string, { row: (typeof rows)[number]; input: { id: string; version: number; path: string }; target: { id: string; version: number; path: string }; configuration: ReturnType<typeof recognitionRuleConfigurationSchema.parse>; mode: "ordinary" | "managed-completed"; reasons: string[] }[]>();
  for (const row of rows) {
    const original = sourceConfigurationSchema.parse(JSON.parse(row.configuration_json ?? row.draft_json)); if (!original.organization) continue;
    let input: { id: string; version: number; path: string };
    if (original.type === "cloud") {
      const root = db.prepare("SELECT canonical_path,volume_identity FROM managed_download_root WHERE id=?").get(original.downloadRootId) as { canonical_path: string; volume_identity: string } | undefined;
      if (!root) throw new Error("旧识别输入缺少原下载根，已停止升级");
      input = directory(original.downloadRootId, root.canonical_path, "managed", JSON.stringify({ id: original.downloadRootId, path: root.canonical_path, volume: JSON.parse(root.volume_identity) }));
    } else {
      const source = db.prepare("SELECT source_grant_json FROM ingestion_source WHERE source_id=?").get(row.local_source_id ?? row.id) as { source_grant_json: string } | undefined;
      const parsed = source ? managedRootGrantSchema.safeParse(JSON.parse(source.source_grant_json)) : null;
      const existing = db.prepare("SELECT id FROM configuration_directory WHERE kind='ordinary' AND path=? LIMIT 2").all(original.sourcePath) as { id: string }[];
      input = directory(parsed?.success ? parsed.data.id : existing.length === 1 ? existing[0]!.id : stableId(["recognition-unverified", row.id]), original.sourcePath, "ordinary", source?.source_grant_json ?? null);
    }
    const targetRows = db.prepare("SELECT id,version,path FROM configuration_directory WHERE kind='media' AND path=? ORDER BY id LIMIT 2").all(original.organization.targetPath) as { id: string; version: number; path: string }[];
    const target = targetRows.length === 1 ? targetRows[0]! : directory(row.target_root_id ?? stableId(["recognition-target-directory", row.id]), original.organization.targetPath, "media", null);
    const types = original.organization.mediaType === "AUTO" ? ["MOVIE", "TV_SHOW"] as const : [original.organization.mediaType];
    const configuration = recognitionRuleConfigurationSchema.parse({ name: original.name, input: { kind: "directory", directoryId: input.id }, client: original.type === "local" && original.client === "quark" ? "quark" : "custom", ignoredFilePatterns: original.type === "local" ? original.ignoredFilePatterns ?? null : null, automatic: false, targets: types.map((mediaType) => ({ id: stableId(["recognition-target", row.id, mediaType, target.id]), name: mediaType === "MOVIE" ? "电影" : "剧集", mediaType, directoryId: target.id, template: null })) });
    const reasons = ["LEGACY_SCOPE_REVIEW_REQUIRED", ...(original.organization.automatic ? ["AUTOMATIC_REAUTHORIZATION_REQUIRED"] : []), ...([input, target].some((value) => !db.prepare("SELECT 1 FROM configuration_directory WHERE id=? AND grant_json IS NOT NULL").get(value.id)) ? ["LEGACY_AUTHORIZATION_MISSING"] : [])];
    const key = hash([input.path, target.path, original.organization.mediaType, original.organization.automatic, configuration.client, configuration.ignoredFilePatterns, row.paused, !!row.deleted_at, row.configuration_json ? null : row.id]);
    const group = groups.get(key) ?? []; group.push({ row, input, target, configuration, mode: original.type === "cloud" ? "managed-completed" : "ordinary", reasons }); groups.set(key, group);
  }
  const used = new Set<string>();
  for (const group of groups.values()) {
    const first = group[0]!, { row, input, configuration, mode, target } = first;
    const conflicting = [...groups.values()].some((other) => other !== group && other[0]!.input.path === input.path), reasons = [...new Set(group.flatMap((value) => value.reasons).concat(conflicting ? ["LEGACY_POLICY_CONFLICT"] : []))];
    const existing = db.prepare("SELECT version,draft_revision FROM recognition_rule WHERE id=?").get(row.id) as { version: number; draft_revision: number } | undefined;
    const version = row.configuration_json ? Math.max(existing?.version ?? 0, row.version) + 1 : existing?.version ?? 0;
    db.prepare("INSERT INTO recognition_rule VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,draft_revision=excluded.draft_revision,lifecycle_revision=excluded.lifecycle_revision,draft_json=excluded.draft_json,paused=excluded.paused,deleted_at=excluded.deleted_at,review_json=excluded.review_json,updated_at=excluded.updated_at").run(row.id, version, Math.max(existing?.draft_revision ?? 0, row.draft_revision) + 1, row.lifecycle_revision, JSON.stringify(configuration), conflicting ? 1 : row.paused, row.deleted_at, JSON.stringify(reasons), row.created_at, stamp);
    if (row.configuration_json) db.prepare("INSERT INTO recognition_rule_version VALUES(?,?,?)").run(row.id, version, JSON.stringify({ ruleId: row.id, ruleVersion: version, configuration, inputDirectory: input, inputMode: mode, defaultDirectoryVersion: null, targets: configuration.targets.map((item) => ({ targetId: item.id, directory: target, embyBinding: null })) }));
    for (const item of group) {
      db.prepare("INSERT OR IGNORE INTO recognition_rule_legacy_reference VALUES(?,?,?,?)").run(item.row.id, item.row.version, row.id, JSON.stringify({ draft: JSON.parse(item.row.draft_json), configuration: item.row.configuration_json ? JSON.parse(item.row.configuration_json) : null }));
      db.prepare("INSERT INTO recognition_legacy_owner VALUES(?,?)").run(item.row.id, row.id);
    }
    used.add(row.id);
  }
  for (const row of db.prepare("SELECT id FROM recognition_rule").all() as { id: string }[]) {
    if (!used.has(row.id)) db.prepare("UPDATE recognition_rule SET paused=1,review_json='[\"LEGACY_SCOPE_REVIEW_REQUIRED\"]' WHERE id=?").run(row.id);
    db.prepare("INSERT INTO recognition_runtime(rule_id,legacy_fingerprint) VALUES(?,?)").run(row.id, recognitionLegacyFingerprint(db, row.id));
  }
  for (const row of db.prepare("SELECT rule_id,snapshot_json FROM recognition_rule_version ORDER BY rule_id,version").all() as { rule_id: string; snapshot_json: string }[]) {
    const configuration = recognitionRuleConfigurationSchema.parse(JSON.parse(row.snapshot_json).configuration);
    for (const target of configuration.targets) db.prepare("INSERT OR IGNORE INTO recognition_target_identity VALUES(?,?,?,?,?)").run(target.id, row.rule_id, target.directoryId, target.mediaType, target.name);
  }
}
