import { selectionSchema } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import { resolveCorrectionScope, CorrectionScopeError, type CorrectionScope, type CorrectionTaskSnapshot } from "../domain/correction-scope.js";
import { correctionConflict, correctionHash } from "./correction-assets.js";

/** 从完整任务集恢复来源／策略；修正后的任务沿历史找到原候选，不按页面或路径猜归属。 */
export function captureCorrectionScope(database: CoreDatabase, anchorId: string, scope: CorrectionScope) {
  const db = database.connection;
  const rows = db.prepare("SELECT id,source_id,status,target_path,confirmed_json,parsed_json,corrected_from_id,updated_at FROM media_task").all() as { id: string; source_id: string; status: string; target_path: string | null; confirmed_json: string | null; parsed_json: string | null; corrected_from_id: string | null; updated_at: string }[];
  const tasks = new Map(rows.map((row) => [row.id, row])), snapshots: CorrectionTaskSnapshot[] = [];
  for (const row of rows) {
    const selection = selectionSchema.safeParse(row.confirmed_json ? JSON.parse(row.confirmed_json) : null);
    // 仅遍历可能进入该范围的剧集；锚点总是交给领域规则解释不支持原因。
    if (row.id !== anchorId && (row.status !== "DONE" || !selection.success || selection.data.mediaType !== "TV_SHOW")) continue;
    let original = row; const seen = new Set<string>();
    while (original.corrected_from_id) {
      if (seen.has(original.id)) throw correctionConflict("修正历史包含循环，已停止计算批量范围；请核对原任务历史");
      seen.add(original.id); const parent = tasks.get(original.corrected_from_id);
      if (!parent || parent.source_id !== row.source_id) throw correctionConflict("修正历史的来源归属不完整，请核对原任务历史"); original = parent;
    }
    const origin = db.prepare(`SELECT c.version_key,c.managed_item_id,p.policy_key FROM ingestion_operation o JOIN ingestion_candidate c ON c.id=o.candidate_id LEFT JOIN ingestion_candidate_policy p ON p.candidate_id=c.id WHERE o.task_id=?`).get(original.id) as { version_key: string; managed_item_id: string | null; policy_key: string | null } | undefined;
    const receipt = db.prepare("SELECT plan_json,evidence_json FROM media_correction_operation WHERE new_task_id=? AND phase='RECORDED' UNION ALL SELECT plan_json,evidence_json FROM ingestion_operation WHERE task_id=? AND phase='RECORDED' LIMIT 1").get(row.id, row.id);
    const parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null, value = selection.success ? selection.data : null;
    snapshots.push({ id: row.id, sourceId: row.source_id, policyKey: origin?.policy_key ?? (origin && !origin.managed_item_id ? null : "unknown:" + original.id), status: row.status, mediaType: value?.mediaType ?? null, assetType: /\.(?:mkv|mp4|avi|mov|m4v|ts|m2ts|wmv|flv|webm|mpg|mpeg|rmvb)$/i.test(parsed?.originalFilename ?? "") ? "VIDEO_FILE" : "UNSUPPORTED", tmdbId: value?.tmdbId ?? null, season: value?.season ?? null, episode: value?.episode ?? null, episodeEnd: value?.episodeEnd ?? null, targetPath: row.target_path, updatedAt: row.updated_at, assetVersion: correctionHash({ candidate: origin?.version_key, receipt, parsed: row.parsed_json, confirmed: row.confirmed_json }) });
  }
  try { const resolved = resolveCorrectionScope(anchorId, scope, snapshots); return { ...resolved, fingerprint: correctionHash(resolved.evidence) }; }
  catch (error) { if (error instanceof CorrectionScopeError) throw correctionConflict(error.message); throw error; }
}
