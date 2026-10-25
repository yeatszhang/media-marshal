import { createHash } from "node:crypto";
import { DesktopError, type CoreInput, type CoreOutput, type IngestionSeason } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";

// 同一任务可有多个候选；每个候选组只计一次该文件，旧匹配和已执行任务不参与分组。
const members = `WITH members AS (
 SELECT c.id,c.task_id,c.source_id,s.name AS source_name,c.relative_json,coalesce(p.policy_key,'local') AS policy,
 json_extract(tc.metadata_json,'$.tmdbId') AS tmdb_id,json_extract(t.parsed_json,'$.season') AS season,
 json_extract(t.parsed_json,'$.episode') AS episode,json_extract(t.parsed_json,'$.episodeEnd') AS episode_end,
 max(json_extract(tc.metadata_json,'$.title')) AS title,max(json_extract(c.snapshot_json,'$.size')) AS bytes
 FROM ingestion_candidate c JOIN desktop_source s ON s.id=c.source_id JOIN media_task t ON t.id=c.task_id
 JOIN task_candidate tc ON tc.task_id=t.id LEFT JOIN ingestion_candidate_policy p ON p.candidate_id=c.id
 LEFT JOIN ingestion_recognition_edit e ON e.task_id=t.id
 WHERE (c.managed_item_id IS NOT NULL OR c.is_current=1) AND c.state='QUEUED' AND t.status='AWAITING_CONFIRMATION' AND t.source_id=c.source_id
 AND (e.revision IS NULL OR e.revision=e.matched_revision) AND json_extract(tc.metadata_json,'$.mediaType')='TV_SHOW'
 AND json_extract(t.parsed_json,'$.type')='TV_SHOW' AND json_type(t.parsed_json,'$.season')='integer'
 AND json_extract(t.parsed_json,'$.season') BETWEEN 0 AND 999
 AND json_type(tc.metadata_json,'$.tmdbId')='integer' AND json_extract(tc.metadata_json,'$.tmdbId') BETWEEN 1 AND 9007199254740991
 GROUP BY c.id,json_extract(tc.metadata_json,'$.tmdbId')
)`;
const group = " GROUP BY source_id,policy,tmdb_id,season";
const select = "SELECT source_id,source_name,policy,tmdb_id,season,min(title) AS title,count(*) AS total,coalesce(sum(bytes),0) AS bytes FROM members";
interface Group { source_id: string; source_name: string; policy: string; tmdb_id: number; season: number; title: string | null; total: number; bytes: number }
/** 候选季集组是只读索引，不授权整季执行；逐文件版本、真实季集与目标仍由整理预览核验。 */
export class IngestionSeasons {
  constructor(private readonly database: CoreDatabase, private readonly candidate: (id: string) => CoreOutput<"ingestion.candidates">["items"][number], private readonly task: (id: string) => CoreOutput<"ingestion.task">) {
    database.connection.function("ingestion_season_id", { deterministic: true }, (source, policy, tmdbId, season) => this.key(String(source), String(policy), Number(tmdbId), Number(season)));
  }
  private key(source: string, policy: string, tmdbId: number, season: number) { return createHash("sha256").update(JSON.stringify(["season-v1", source, policy, tmdbId, season])).digest("hex"); }
  private dto(row: Group): IngestionSeason { return { id: this.key(row.source_id, row.policy, row.tmdb_id, row.season), sourceId: row.source_id, sourceName: row.source_name.slice(0, 100), tmdbId: row.tmdb_id, season: row.season, title: (row.title ?? `TMDB ${row.tmdb_id}`).slice(0, 500), total: row.total, bytes: row.bytes }; }
  list(input: CoreInput<"ingestion.seasons">): CoreOutput<"ingestion.seasons"> {
    const db = this.database.connection, rows = db.prepare(members + select + group + " ORDER BY source_name,source_id,tmdb_id,season,policy LIMIT 25 OFFSET ?").all(((input.page ?? 1) - 1) * 25) as Group[];
    const total = (db.prepare(members + " SELECT count(*) AS n FROM (SELECT 1 FROM members" + group + ")").get() as { n: number }).n;
    return { total, items: rows.map((row) => this.dto(row)) };
  }
  get(input: CoreInput<"ingestion.season">): CoreOutput<"ingestion.season"> {
    const db = this.database.connection, row = db.prepare(members + select + " WHERE source_id=?" + group + " HAVING ingestion_season_id(source_id,policy,tmdb_id,season)=?").get(input.sourceId, input.id) as Group | undefined;
    if (!row) throw new DesktopError("CONFLICT", "此季集候选组已变化或没有当前待确认文件，请刷新季集列表；已保存的预览和文件不受影响");
    const rows = db.prepare(members + " SELECT id,task_id FROM members WHERE source_id=? AND policy=? AND tmdb_id=? AND season=? ORDER BY episode IS NULL,episode,episode_end,relative_json,id LIMIT 100 OFFSET ?").all(row.source_id, row.policy, row.tmdb_id, row.season, ((input.page ?? 1) - 1) * 100) as { id: string; task_id: string }[];
    return { season: this.dto(row), items: rows.map((row) => ({ candidate: this.candidate(row.id), task: this.task(row.task_id) })) };
  }
}
