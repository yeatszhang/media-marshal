import { DesktopError, recognitionRuleSnapshotSchema, embyTargetBindingSchema, type RecognitionRuleSnapshot } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import { createHash } from "node:crypto";

/** 候选当前配置与已受理文件计划分开；输入目录只由一个识别规则接管。 */
export function recognitionOwner(database: CoreDatabase, sourceId: string) {
  return database.connection.prepare("SELECT i.*,r.version,r.lifecycle_revision,r.paused,r.deleted_at,v.snapshot_json FROM recognition_input i JOIN recognition_rule r ON r.id=i.rule_id JOIN recognition_rule_version v ON v.rule_id=r.id AND v.version=r.version WHERE i.source_id=?").get(sourceId) as { source_id: string; rule_id: string; directory_id: string; mode: "ordinary" | "managed-completed"; active: number; version: number; lifecycle_revision: number; paused: number; deleted_at: string | null; snapshot_json: string } | undefined;
}
export function recognitionSnapshot(database: CoreDatabase, sourceId: string): RecognitionRuleSnapshot | null { const owner = recognitionOwner(database, sourceId); return owner ? recognitionRuleSnapshotSchema.parse(JSON.parse(owner.snapshot_json)) : null; }
export function recognitionRoute(database: CoreDatabase, sourceId: string, type: "MOVIE" | "TV_SHOW", targetId?: string) {
  const owner = recognitionOwner(database, sourceId); if (!owner) return null;
  if (!owner.active || owner.deleted_at) throw new DesktopError("CONFLICT", "此候选的识别输入已切换或规则已删除，请核对原任务；已受理计划保留原目标");
  const snapshot = recognitionRuleSnapshotSchema.parse(JSON.parse(owner.snapshot_json)), matches = snapshot.configuration.targets.filter((target) => target.mediaType === type && (!targetId || target.id === targetId));
  if (matches.length !== 1) throw new DesktopError("CONFLICT", matches.length ? `此文件匹配 ${matches.length} 个${type === "MOVIE" ? "电影" : "剧集"}目标，请人工选择目标后重新预览` : `识别规则没有所选类型的有效目标，请先配置${type === "MOVIE" ? "电影" : "剧集"}目标后重新预览`);
  const configuration = matches[0]!, target = snapshot.targets.find((value) => value.targetId === configuration.id)!;
  return { owner, snapshot, configuration, target, binding: recognitionEmbyBinding(database, configuration.id) };
}
export function recognitionEmbyBinding(database: CoreDatabase, targetId: string) {
  const row = database.connection.prepare("SELECT l.binding_json FROM emby_library l JOIN emby_connection c ON c.id=l.connection_id WHERE l.target_root_id=? AND c.valid=1 ORDER BY c.verified_at DESC LIMIT 1").get(targetId) as { binding_json: string | null } | undefined;
  return row?.binding_json ? embyTargetBindingSchema.parse(JSON.parse(row.binding_json)) : null;
}
export function recognitionScopeHash(snapshot: RecognitionRuleSnapshot) { return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"); }
export function recognitionCandidateContext(database: CoreDatabase, sourceId: string) {
  const owner = recognitionOwner(database, sourceId); if (!owner) return null;
  const snapshot = recognitionRuleSnapshotSchema.parse(JSON.parse(owner.snapshot_json));
  return { ruleId: owner.rule_id, version: owner.version, lifecycle: owner.lifecycle_revision, active: !!owner.active, deleted: !!owner.deleted_at, snapshot: recognitionScopeHash(snapshot), defaultVersion: snapshot.configuration.input.kind === "default" ? (database.connection.prepare("SELECT version FROM default_download_directory WHERE singleton=1").get() as { version: number }).version : null };
}
