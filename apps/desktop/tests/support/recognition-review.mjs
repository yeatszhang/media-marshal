// 待核对 UI 的合成识别结果；不代表解析／TMDB／模型质量，也不生成文件发布计划。
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { normalizeParse } from "../../../../packages/media-core/dist/domain/media.js";
export function seedRecognitionReview(
  database,
  { title = "翠鸟谋杀案", tmdbId = 7, year = 2026 } = {},
) {
  const sql = database.connection,
    stamp = new Date().toISOString(),
    taskIds = [];
  for (const candidate of sql
    .prepare("SELECT * FROM ingestion_candidate WHERE task_id IS NULL ORDER BY relative_json")
    .all()) {
    const parts = JSON.parse(candidate.relative_json),
      name = parts.at(-1),
      match = /S(\d+)E0?(\d+)/i.exec(name),
      id = randomUUID();
    const root = sql
      .prepare("SELECT source_path FROM desktop_source WHERE id=?")
      .get(candidate.source_id).source_path;
    const parsed = match
      ? { title, type: "episode", season: Number(match[1]), episode: Number(match[2]), year }
      : { title, type: "movie", year };
    sql
      .prepare(
        "INSERT INTO media_task(id,source_id,source_path,title,status,parsed_json,created_at,updated_at) VALUES(?,?,?,?,'AWAITING_CONFIRMATION',?,?,?)",
      )
      .run(
        id,
        candidate.source_id,
        join(root, ...parts),
        title,
        JSON.stringify(normalizeParse(parsed, name)),
        stamp,
        stamp,
      );
    sql
      .prepare("UPDATE ingestion_candidate SET task_id=?,state='QUEUED' WHERE id=?")
      .run(id, candidate.id);
    sql.prepare("INSERT INTO task_candidate VALUES(?,?,?,?)").run(
      randomUUID(),
      id,
      JSON.stringify({
        tmdbId,
        mediaType: match ? "TV_SHOW" : "MOVIE",
        title,
        originalTitle: match ? "Marble Hall Murders" : title,
        year,
        score: { confidence: 0.92, titleScore: 1, yearScore: 1 },
        evidence: "both",
        parentOnlyCapped: false,
      }),
      0.92,
    );
    taskIds.push(id);
  }
  return taskIds;
}
export function seedScanIssue(database) {
  const sql = database.connection,
    source = sql.prepare("SELECT id FROM desktop_source LIMIT 1").get().id,
    scan = randomUUID(),
    stamp = new Date().toISOString();
  sql
    .prepare(
      "INSERT INTO ingestion_source_scan(id,source_id,physical_source_id,source_name,context,state,discovered,failure,created_at,updated_at) VALUES(?,?,?,?,?,'PARTIAL_FAILED',6,?,?,?)",
    )
    .run(
      scan,
      source,
      source,
      "隔离交互夹具",
      "{}",
      "部分文件未能核对，请检查文件权限后重新扫描",
      stamp,
      stamp,
    );
  sql
    .prepare("INSERT INTO ingestion_source_scan_issue VALUES(?,?,?)")
    .run(
      scan,
      "翠鸟谋杀案 (2026)/poster.jpg",
      "文件暂不可读，请检查原文件、磁盘和读取权限后重新扫描",
    );
  return scan;
}
