/** 修正范围只计算成员与证据，不读目录、不改数据库，也不授权文件操作。 */
export interface CorrectionTaskSnapshot {
  id: string; sourceId: string | null; policyKey: string | null; status: string;
  mediaType: string | null; assetType: string | null; tmdbId: number | null;
  season: number | null; episode: number | null; episodeEnd: number | null;
  targetPath: string | null; updatedAt: string; assetVersion: string;
}
export type CorrectionScope = "SAME_SEASON" | "SAME_SERIES";
export class CorrectionScopeError extends Error {
  constructor(readonly code: "ANCHOR_MISSING" | "ANCHOR_UNSUPPORTED" | "SCOPE_INVALID" | "SEASON_MISSING" | "DUPLICATE_MEMBER", message: string) { super(message); this.name = "CorrectionScopeError"; }
}
const ordinaryVideo = (task: CorrectionTaskSnapshot) => task.assetType === null || task.assetType === "VIDEO_FILE";
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const nullable = (a: number | null, b: number | null) => a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;
const fileName = (path: string | null) => (path ?? "").split(/[\\/]/).at(-1) ?? "";
/** 沿用旧范围排序的大小写无关自然顺序；长数字按长度和字典序比较。 */
function natural(a: string, b: string) {
  const left = a.normalize("NFC").toLowerCase(), right = b.normalize("NFC").toLowerCase(), x = left.match(/\d+|\D+/g) ?? [], y = right.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const first = x[i]!, second = y[i]!; if (first === second) continue;
    if (/^\d+$/.test(first) && /^\d+$/.test(second)) { const n = first.replace(/^0+/, "") || "0", m = second.replace(/^0+/, "") || "0", result = n.length - m.length || compare(n, m); if (result) return result; }
    else return compare(first, second);
  }
  return left.length - right.length;
}
export function correctionMemberBlockers(task: CorrectionTaskSnapshot) {
  const blockers: string[] = [];
  if (!ordinaryVideo(task)) blockers.push("修正只支持普通视频文件");
  if (task.season === null || !Number.isInteger(task.season) || task.season < 0 || task.season > 999) blockers.push("缺少有效季号");
  const end = task.episodeEnd ?? task.episode;
  if (task.episode === null || !Number.isInteger(task.episode) || task.episode < 1 || end === null || !Number.isInteger(end) || end < task.episode || end > 10000 || end - task.episode >= 1000) blockers.push("缺少有效集号或合并集范围");
  if (!task.targetPath?.trim()) blockers.push("缺少当前目标路径");
  return blockers;
}
export function resolveCorrectionScope(anchorId: string, scope: CorrectionScope, tasks: readonly CorrectionTaskSnapshot[]) {
  if (scope !== "SAME_SEASON" && scope !== "SAME_SERIES") throw new CorrectionScopeError("SCOPE_INVALID", "批量修正范围必须是同季或同剧");
  const seen = new Set<string>(); for (const task of tasks) { if (seen.has(task.id)) throw new CorrectionScopeError("DUPLICATE_MEMBER", `修正范围重复包含任务 ${task.id}，请重新读取完整范围`); seen.add(task.id); }
  const anchor = tasks.find((task) => task.id === anchorId); if (!anchor) throw new CorrectionScopeError("ANCHOR_MISSING", "修正锚点任务不存在，请刷新任务列表");
  const reasons: string[] = [];
  if (anchor.status !== "DONE") reasons.push("只有已完成任务支持批量修正");
  if (anchor.mediaType !== "TV_SHOW") reasons.push("同季或同剧修正只支持剧集");
  if (!ordinaryVideo(anchor)) reasons.push("只支持普通视频文件");
  if (!Number.isSafeInteger(anchor.tmdbId) || anchor.tmdbId! < 1) reasons.push("缺少有效 TMDB ID");
  if (!anchor.sourceId) reasons.push("缺少来源归属");
  if (!anchor.targetPath?.trim()) reasons.push("缺少当前目标路径");
  if (reasons.length) throw new CorrectionScopeError("ANCHOR_UNSUPPORTED", reasons.join("；"));
  if (scope === "SAME_SEASON" && anchor.season === null) throw new CorrectionScopeError("SEASON_MISSING", "同季批量修正要求锚点任务具有季号");
  const members = tasks.filter((task) => task.status === "DONE" && task.mediaType === "TV_SHOW" && task.tmdbId === anchor.tmdbId && task.sourceId === anchor.sourceId && task.policyKey === anchor.policyKey && (scope === "SAME_SERIES" || task.season === anchor.season))
    .map((task) => ({ ...task })).sort((a, b) => nullable(a.season, b.season) || nullable(a.episode, b.episode) || nullable(a.episodeEnd, b.episodeEnd) || natural(fileName(a.targetPath), fileName(b.targetPath)) || compare(a.id, b.id));
  // 固定字段顺序且包含来源／策略、版本和范围；SHA-256 由后续 Core 用例计算。
  const evidence = JSON.stringify({ version: 1, anchorId, scope, members: members.map((task) => [task.id, task.updatedAt, task.status, task.targetPath, task.assetType, task.tmdbId, task.sourceId, task.policyKey, task.season, task.episode, task.episodeEnd, task.assetVersion]) });
  return { members, blockers: members.map((task) => ({ taskId: task.id, reasons: correctionMemberBlockers(task) })).filter((item) => item.reasons.length), evidence };
}
