import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { sourceConfigurationSchema, recognitionRuleConfigurationSchema, type SourceConfiguration } from "@media-marshal/contracts";
import { managedRootGrantSchema, localFileEvidenceSchema } from "@media-marshal/contracts/internal";
import { legacySyncFilters } from "../sources/legacy-sync-filters.js";

/** 追加新配置投影；旧配置、候选与已受理操作快照仍为历史恢复依据。 */
export const syncRecognitionMigrationSql = `
CREATE TABLE configuration_directory (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0), path TEXT NOT NULL,
 grant_json TEXT CHECK(grant_json IS NULL OR json_valid(grant_json)),
 kind TEXT NOT NULL CHECK(kind IN ('ordinary','managed','media')),
 legacy_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE default_download_directory (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version>=0),
 directory_id TEXT REFERENCES configuration_directory(id)
);
INSERT INTO default_download_directory VALUES(1,0,NULL);
CREATE TABLE sync_source_rule (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>=0), draft_revision INTEGER NOT NULL CHECK(draft_revision>0),
 lifecycle_revision INTEGER NOT NULL CHECK(lifecycle_revision>=0),
 draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
 paused INTEGER NOT NULL CHECK(paused IN (0,1)), deleted_at TEXT,
 review_json TEXT NOT NULL CHECK(json_valid(review_json)),
 legacy_configuration_json TEXT CHECK(legacy_configuration_json IS NULL OR json_valid(legacy_configuration_json)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE sync_source_version (
 source_id TEXT NOT NULL REFERENCES sync_source_rule(id), version INTEGER NOT NULL CHECK(version>0),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 PRIMARY KEY(source_id,version)
);
CREATE TRIGGER sync_source_version_immutable BEFORE UPDATE ON sync_source_version
BEGIN SELECT RAISE(ABORT,'同步来源版本快照不可修改'); END;
CREATE TABLE recognition_rule (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>=0), draft_revision INTEGER NOT NULL CHECK(draft_revision>0),
 lifecycle_revision INTEGER NOT NULL CHECK(lifecycle_revision>=0),
 draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
 paused INTEGER NOT NULL CHECK(paused IN (0,1)), deleted_at TEXT,
 review_json TEXT NOT NULL CHECK(json_valid(review_json)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE recognition_rule_version (
 rule_id TEXT NOT NULL REFERENCES recognition_rule(id), version INTEGER NOT NULL CHECK(version>0),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 PRIMARY KEY(rule_id,version)
);
CREATE TRIGGER recognition_rule_version_immutable BEFORE UPDATE ON recognition_rule_version
BEGIN SELECT RAISE(ABORT,'识别规则版本快照不可修改'); END;
CREATE TABLE recognition_rule_legacy_reference (
 source_id TEXT NOT NULL REFERENCES source_rule(id), source_version INTEGER NOT NULL,
 rule_id TEXT NOT NULL REFERENCES recognition_rule(id),
 configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)),
 PRIMARY KEY(source_id,source_version)
);
CREATE INDEX recognition_legacy_rule ON recognition_rule_legacy_reference(rule_id,source_id);
CREATE TABLE sync_receipt (
 id TEXT PRIMARY KEY, source_kind TEXT NOT NULL CHECK(source_kind IN ('local','cloud')),
 source_namespace TEXT NOT NULL, source_object_key TEXT NOT NULL, source_version_key TEXT NOT NULL,
 version_json TEXT NOT NULL CHECK(json_valid(version_json)),
 target_directory_id TEXT NOT NULL, target_slot TEXT NOT NULL, target_segments_json TEXT NOT NULL CHECK(json_valid(target_segments_json)),
 local_sha256 TEXT NOT NULL CHECK(length(local_sha256)=64 AND local_sha256 NOT GLOB '*[^0-9a-f]*'),
 size INTEGER NOT NULL CHECK(size>=0), completed_at TEXT NOT NULL,
 result_kind TEXT NOT NULL CHECK(result_kind IN ('download-item','local-sync')),
 result_id TEXT NOT NULL, request_variant TEXT NOT NULL,
 UNIQUE(result_kind,result_id)
);
CREATE INDEX sync_receipt_lookup ON sync_receipt(source_kind,source_namespace,source_object_key,source_version_key,target_directory_id,target_slot);
CREATE TRIGGER sync_receipt_immutable BEFORE UPDATE ON sync_receipt
BEGIN SELECT RAISE(ABORT,'成功同步收据不可修改'); END;
`;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stableId = (value: unknown) => {
  const bytes = Buffer.from(hash(value).slice(0, 32), "hex"); bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const parseGrant = (value: string | null) => {
  if (!value) return null;
  try { const parsed = managedRootGrantSchema.safeParse(JSON.parse(value)); return parsed.success ? parsed.data : null; } catch { return null; }
};
interface RuleRow { id: string; type: "local" | "cloud"; version: number; draft_revision: number; lifecycle_revision: number; draft_json: string; paused: number; deleted_at: string | null; review_required: number; local_source_id: string | null; ingestion_source_id: string | null; created_at: string; updated_at: string; active_json: string | null; target_root_id: string | null }
interface Directory { id: string; version: number; path: string }

/** 不读取媒体文件，也不从目录是否存在推断成功、删除或授权。 */
export function migrateSyncRecognition(db: Database.Database): void {
  const stamp = new Date().toISOString();
  const register = (id: string, path: string, kind: string, grant: string | null, legacyId: string): Directory => {
    const parsed = parseGrant(grant);
    const actual = parsed?.id === id && parsed.path === path ? JSON.stringify(parsed) : null;
    const old = db.prepare("SELECT path,grant_json FROM configuration_directory WHERE id=?").get(id) as { path: string; grant_json: string | null } | undefined;
    if (old && (old.path !== path || (old.grant_json && actual && old.grant_json !== actual))) throw new Error("目录历史身份冲突，已停止职责拆分迁移");
    if (!old) db.prepare("INSERT INTO configuration_directory VALUES(?,1,?,?,?,?,?)").run(id, path, actual, kind, legacyId, stamp);
    return { id, version: 1, path };
  };
  const downloadRoots = db.prepare("SELECT id,canonical_path,volume_identity FROM managed_download_root ORDER BY id").all() as { id: string; canonical_path: string; volume_identity: string }[];
  for (const root of downloadRoots) register(root.id, root.canonical_path, "managed", JSON.stringify({ id: root.id, path: root.canonical_path, volume: JSON.parse(root.volume_identity) }), root.id);
  for (const root of db.prepare("SELECT id,grant_json FROM media_target_root ORDER BY id").all() as { id: string; grant_json: string }[]) {
    const parsed = parseGrant(root.grant_json); if (parsed) register(root.id, parsed.path, "media", root.grant_json, root.id);
  }
  const directory = (id: string) => db.prepare("SELECT id,version,path FROM configuration_directory WHERE id=?").get(id) as Directory | undefined;
  const authorized = (id: string) => !!db.prepare("SELECT 1 FROM configuration_directory WHERE id=? AND grant_json IS NOT NULL").get(id);
  const rules = db.prepare("SELECT r.*,v.configuration_json AS active_json,v.target_root_id FROM source_rule r LEFT JOIN source_rule_version v ON v.source_id=r.id AND v.version=r.version ORDER BY r.id").all() as RuleRow[];
  const inputIdentity = (input: Directory) => {
    const row = db.prepare("SELECT grant_json FROM configuration_directory WHERE id=?").get(input.id) as { grant_json: string | null };
    if (!row.grant_json) return hash(["unverified", input.id]);
    const grant = managedRootGrantSchema.parse(JSON.parse(row.grant_json));
    return hash([grant.volume.volumeId, grant.volume.rootInode, grant.volume.rootBirthtimeNs]);
  };
  const projectCloud = (configuration: Extract<SourceConfiguration, { type: "cloud" }>) => ({ type: "cloud", name: configuration.name, accountId: configuration.accountId, remoteRef: configuration.remoteRef, target: { kind: "directory", directoryId: configuration.downloadRootId }, filters: legacySyncFilters(configuration.filters) ?? [], periodic: configuration.periodic });
  const projections: { row: RuleRow; configuration: SourceConfiguration; input: Directory; inputKey: string; target: Directory; reasons: string[]; policyKey: string }[] = [];
  for (const row of rules) {
    const draft = sourceConfigurationSchema.parse(JSON.parse(row.draft_json));
    const configuration = row.active_json ? sourceConfigurationSchema.parse(JSON.parse(row.active_json)) : draft;
    if (configuration.type === "cloud") {
      const filters = legacySyncFilters(configuration.filters);
      const reasons = row.review_required || !row.active_json || filters === null ? ["LEGACY_SCOPE_REVIEW_REQUIRED"] : [];
      const projected = projectCloud(configuration);
      if (draft.type !== "cloud") throw new Error("来源草稿类型与有效配置冲突，已停止职责拆分迁移");
      if (legacySyncFilters(draft.filters) === null && !reasons.length) reasons.push("LEGACY_SCOPE_REVIEW_REQUIRED");
      db.prepare("INSERT INTO sync_source_rule VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(row.id, row.version, row.draft_revision, row.lifecycle_revision, JSON.stringify(projectCloud(draft)), row.paused, row.deleted_at, JSON.stringify(reasons), JSON.stringify({ draft, configuration }), row.created_at, row.updated_at);
      const target = directory(configuration.downloadRootId);
      if (target && row.version && row.active_json && filters !== null) db.prepare("INSERT INTO sync_source_version VALUES(?,?,?)").run(row.id, row.version, JSON.stringify({ sourceId: row.id, sourceVersion: row.version, configuration: projected, inputDirectory: null, targetDirectory: target, defaultDirectoryVersion: null }));
    }
    if (!configuration.organization) continue;
    const reasons: string[] = row.review_required || !row.active_json ? ["LEGACY_SCOPE_REVIEW_REQUIRED"] : [];
    if (hash(draft) !== hash(configuration)) reasons.push("LEGACY_SCOPE_REVIEW_REQUIRED");
    if (configuration.organization.automatic) reasons.push("AUTOMATIC_REAUTHORIZATION_REQUIRED");
    let input: Directory | undefined;
    if (configuration.type === "cloud") { input = directory(configuration.downloadRootId); reasons.push("LEGACY_SCOPE_REVIEW_REQUIRED"); }
    else {
      const physical = db.prepare("SELECT source_grant_json FROM ingestion_source WHERE source_id=? AND mode='local'").get(row.local_source_id ?? row.id) as { source_grant_json: string } | undefined;
      const grant = parseGrant(physical?.source_grant_json ?? null);
      input = register(grant?.id ?? stableId(["unverified-input", row.id]), configuration.sourcePath, "ordinary", physical?.source_grant_json ?? null, row.local_source_id ?? row.id);
    }
    if (!input) throw new Error("历史同步输入缺少原下载根，已停止职责拆分迁移");
    let target = row.target_root_id ? directory(row.target_root_id) : undefined;
    if (!target || target.path !== configuration.organization.targetPath) {
      const matches = db.prepare("SELECT id,version,path FROM configuration_directory WHERE kind='media' AND path=? ORDER BY id").all(configuration.organization.targetPath) as Directory[];
      target = matches.length === 1 ? matches[0] : register(row.target_root_id ?? stableId(["unverified-target", row.id]), configuration.organization.targetPath, "media", null, row.id);
    }
    if (!authorized(input.id) || !authorized(target!.id)) reasons.push("LEGACY_AUTHORIZATION_MISSING");
    const inputKey = inputIdentity(input);
    const policyKey = hash([inputKey, configuration.organization.targetPath, configuration.organization.mediaType, configuration.organization.automatic, configuration.type === "local" ? configuration.client : "custom", configuration.type === "local" ? configuration.ignoredFilePatterns ?? null : null, row.paused, row.deleted_at !== null, row.active_json ? null : row.id]);
    projections.push({ row, configuration, input, inputKey, target: target!, reasons, policyKey });
  }
  const groups = new Map<string, typeof projections>();
  for (const projection of projections) { const group = groups.get(projection.policyKey) ?? []; group.push(projection); groups.set(projection.policyKey, group); }
  for (const group of groups.values()) {
    const first = group[0]!, { row, configuration, input, target } = first;
    const conflict = projections.some((other) => other.inputKey === first.inputKey && other.policyKey !== first.policyKey);
    const reasons = [...new Set(group.flatMap((item) => item.reasons).concat(conflict ? ["LEGACY_POLICY_CONFLICT"] : []))];
    const types = configuration.organization!.mediaType === "AUTO" ? ["MOVIE", "TV_SHOW"] : [configuration.organization!.mediaType];
    const targets = types.map((mediaType) => ({ id: stableId(["recognition-target", row.id, mediaType, target.id]), name: mediaType === "MOVIE" ? "电影" : "剧集", mediaType, directoryId: target.id, template: null }));
    const config = recognitionRuleConfigurationSchema.parse({ name: configuration.name, input: { kind: "directory", directoryId: input.id }, client: configuration.type === "local" && configuration.client === "quark" ? "quark" : "custom", ignoredFilePatterns: configuration.type === "local" ? configuration.ignoredFilePatterns ?? null : null, targets, operation: "COPY", automatic: false });
    db.prepare("INSERT INTO recognition_rule VALUES(?,?,?,?,?,?,?,?,?,?)").run(row.id, row.version, row.draft_revision, row.lifecycle_revision, JSON.stringify(config), conflict ? 1 : row.paused, row.deleted_at, JSON.stringify(reasons), row.created_at, row.updated_at);
    if (row.version && row.active_json) db.prepare("INSERT INTO recognition_rule_version VALUES(?,?,?)").run(row.id, row.version, JSON.stringify({ ruleId: row.id, ruleVersion: row.version, configuration: config, inputDirectory: input, inputMode: configuration.type === "cloud" ? "managed-completed" : "ordinary", defaultDirectoryVersion: null, targets: targets.map((item) => ({ targetId: item.id, directory: target, embyBinding: null })) }));
    for (const item of group) db.prepare("INSERT INTO recognition_rule_legacy_reference VALUES(?,?,?,?)").run(item.row.id, item.row.version, row.id, JSON.stringify({ draft: JSON.parse(item.row.draft_json), configuration: item.configuration }));
  }
  // 成功事实独立于文件当前存在性；迁移不碰磁盘，也不为未完成项补造收据。
  let cursor = "";
  for (;;) {
    const items = db.prepare("SELECT i.*,c.state AS commit_state,c.file_evidence_json FROM download_item i LEFT JOIN download_commit_intent c ON c.item_id=i.id WHERE i.id>? AND (i.state='COMPLETED' OR c.state='RECORDED') ORDER BY i.id LIMIT 250").all(cursor) as { id: string; account_id: string; remote_ref: string; version_key: string; version_json: string; target_root_id: string; target_path_key: string; target_segments_json: string; local_sha256: string | null; completed_size: number | null; expected_size: number; updated_at: string; request_variant: string; file_evidence_json: string | null }[];
    if (!items.length) break; cursor = items.at(-1)!.id;
    for (const item of items) {
      if (!item.local_sha256 || !/^[a-f0-9]{64}$/.test(item.local_sha256) || item.completed_size !== item.expected_size) continue;
      const evidence = item.file_evidence_json ? localFileEvidenceSchema.safeParse(JSON.parse(item.file_evidence_json)) : null;
      if (evidence && (!evidence.success || evidence.data.sha256 !== item.local_sha256 || evidence.data.size !== item.completed_size)) continue;
      db.prepare("INSERT INTO sync_receipt VALUES(?,'cloud',?,?,?,?,?,?,?,?,?,?,'download-item',?,?)").run(stableId(["download-receipt", item.id]), item.account_id, item.remote_ref, item.version_key, item.version_json, item.target_root_id, item.target_path_key, item.target_segments_json, item.local_sha256, item.completed_size, item.updated_at, item.id, item.request_variant);
    }
  }
}
