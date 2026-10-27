import { DesktopError } from "@media-marshal/contracts";
import { assertUniqueEpisodes } from "../domain/media.js";
import type { CoreDatabase } from "../infrastructure/database.js";
export interface MediaSelection { tmdbId: number; mediaType: "MOVIE" | "TV_SHOW"; season: number | null; episode: number | null; episodeEnd: number | null }
/** 自动／人工整理与修正共用占用核对；已被修正的历史不继续占用旧坐标。 */
export function assertMediaCoordinates(database: CoreDatabase, selection: MediaSelection, exceptTaskId: string, fileName: string) {
  if (selection.mediaType !== "TV_SHOW") return;
  const db = database.connection;
  const rows = db.prepare(`SELECT o.plan_json FROM ingestion_operation o JOIN media_task t ON t.id=o.task_id WHERE t.status!='CORRECTED' AND t.id!=?
    UNION ALL SELECT o.plan_json FROM media_correction_operation o JOIN media_task t ON t.id=o.new_task_id WHERE t.status!='CORRECTED' AND t.id!=? AND o.original_task_id!=?`).all(exceptTaskId, exceptTaskId, exceptTaskId) as { plan_json: string }[];
  const others: MediaSelection[] = [];
  for (const row of rows) {
    const plan = JSON.parse(row.plan_json) as { selection?: MediaSelection; sourceSegments?: string[]; targetSegments?: string[] }, other = plan.selection;
    if (other?.mediaType !== "TV_SHOW" || other.tmdbId !== selection.tmdbId) continue; others.push(other);
    if (other.season !== selection.season) continue;
    const start = Math.max(other.episode!, selection.episode!), end = Math.min(other.episodeEnd ?? other.episode!, selection.episodeEnd ?? selection.episode!);
    if (start <= end) throw new DesktopError("CONFLICT", `「${fileName.slice(0, 100)}」与已领取文件「${(plan.sourceSegments?.at(-1) ?? plan.targetSegments?.at(-1) ?? "原任务").slice(0, 100)}」重复或重叠：S${selection.season} E${start}${end > start ? `–${end}` : ""}；请修改季集后重新预览`);
  }
  assertUniqueEpisodes([...others, selection].map((value) => ({ tmdbId: value.tmdbId, season: value.season!, episode: value.episode!, episodeEnd: value.episodeEnd })));
}
