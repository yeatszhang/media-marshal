import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { DesktopError, recognitionFieldsSchema, type CoreInput, type CoreOutput, type RecognitionFields } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import { normalizeParse, type ParsedMedia } from "../domain/media.js";

type Input = CoreInput<"ingestion.preview-recognition-edit">;
type Item = CoreOutput<"ingestion.preview-recognition-edit">["items"][number];
interface Row { id: string; source_path: string; status: string; parsed_json: string | null; candidate_id: string; source_id: string; state: string; version_key: string; snapshot_json: string; expected_sha256: string | null; is_current: number; managed_item_id: string | null; source_version: number; revision: number; operation_id: string | null }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message: string) => new DesktopError("CONFLICT", message);
const fields = (parsed: ParsedMedia): RecognitionFields => ({ title: parsed.title, year: parsed.year, type: parsed.type, season: parsed.season, episode: parsed.episode, episodeEnd: parsed.episodeEnd });

/** 自然顺序不把长数字转换成浮点数；同名由路径与持久 ID 确定顺序。 */
export function compareRecognitionPaths(left: string, right: string): number {
  const a = left.normalize("NFC").split(/(\d+)/), b = right.normalize("NFC").split(/(\d+)/);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index] ?? "", y = b[index] ?? ""; if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) { const n = x.replace(/^0+/, "") || "0", m = y.replace(/^0+/, "") || "0"; if (n.length !== m.length) return n.length - m.length; if (n !== m) return n < m ? -1 : 1; }
    else return x < y ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 编辑只更新识别事实；重新匹配由原持久任务执行，绝不创建 COPY。 */
export class RecognitionEdits {
  constructor(private readonly database: CoreDatabase, private readonly check: (candidateId: string) => void, private readonly now = Date.now) {}
  revision(taskId: string) { return (this.database.connection.prepare("SELECT revision FROM ingestion_recognition_edit WHERE task_id=?").get(taskId) as { revision: number } | undefined)?.revision ?? 0; }
  saved(taskId: string) { const row = this.database.connection.prepare("SELECT parsed_json FROM ingestion_recognition_edit WHERE task_id=?").get(taskId) as { parsed_json: string } | undefined; return row ? JSON.parse(row.parsed_json) as ParsedMedia : null; }
  matchesStale(taskId: string) { return !!this.database.connection.prepare("SELECT 1 FROM ingestion_recognition_edit WHERE task_id=? AND revision!=matched_revision").get(taskId); }
  matched(taskId: string, revision: number) { this.database.connection.prepare("UPDATE ingestion_recognition_edit SET matched_revision=? WHERE task_id=? AND revision=?").run(revision, taskId, revision); }
  private row(taskId: string) {
    return this.database.connection.prepare("SELECT t.id,t.source_path,t.status,t.parsed_json,c.id AS candidate_id,c.source_id,c.state,c.version_key,c.snapshot_json,c.expected_sha256,c.is_current,c.managed_item_id,s.version AS source_version,coalesce(e.revision,0) AS revision,o.id AS operation_id FROM media_task t JOIN ingestion_candidate c ON c.task_id=t.id JOIN desktop_source s ON s.id=c.source_id LEFT JOIN ingestion_recognition_edit e ON e.task_id=t.id LEFT JOIN ingestion_operation o ON o.task_id=t.id WHERE t.id=?").get(taskId) as Row | undefined;
  }
  private scope(row: Row) {
    return this.database.connection.prepare("SELECT DISTINCT s.id,s.version,s.lifecycle_revision,s.deleted_at,s.paused,s.review_required FROM source_rule s LEFT JOIN download_source_demand d ON d.source_id=s.id LEFT JOIN download_job_item ji ON ji.job_id=d.job_id WHERE s.local_source_id=? OR (ji.item_id=? AND d.source_version=s.version) ORDER BY s.id").all(row.source_id, row.managed_item_id);
  }
  private plan(input: Input) {
    const snapshots: unknown[] = [], records = new Map<string, { row: Row; parsed: ParsedMedia }>(), items: Item[] = [], warnings: string[] = [], seen = new Set<string>();
    const ordered = input.items.map((request) => ({ request, row: this.row(request.taskId) })).sort((a, b) => (input.sequence?.direction === "DESC" ? -1 : 1) * (compareRecognitionPaths(a.row?.source_path ?? a.request.taskId, b.row?.source_path ?? b.request.taskId) || a.request.taskId.localeCompare(b.request.taskId)));
    for (let index = 0; index < ordered.length; index++) {
      const { request, row } = ordered[index]!, blockers: string[] = []; let before: RecognitionFields | null = null, after: RecognitionFields | null = null;
      if (!row) blockers.push("任务不存在或不是本地整理候选，请刷新列表后重新选择");
      else {
        snapshots.push({ row, scope: this.scope(row) });
        if (row.revision !== request.expectedRevision) blockers.push(`识别信息已更新为第 ${row.revision} 版，请重新打开编辑`);
        if (row.status !== "AWAITING_CONFIRMATION" || row.state !== "QUEUED" || row.operation_id) blockers.push("此任务不在待确认状态，或已有文件操作；请等待处理完成后使用修正入口");
        try { this.check(row.candidate_id); } catch (error) { blockers.push(error instanceof DesktopError ? error.message.slice(0, 500) : "候选或来源状态不可核实，请刷新来源后重试"); }
        try {
          const parsed: ParsedMedia = row.parsed_json ? JSON.parse(row.parsed_json) : normalizeParse({}, basename(row.source_path));
          before = recognitionFieldsSchema.parse(fields(parsed)); after = { ...before, ...input.patch };
          if (after.type === "MOVIE") { after.season = null; after.episode = null; after.episodeEnd = null; }
          if (!after.title?.trim()) blockers.push("请填写解析标题");
          if (!after.type) blockers.push("请选择电影或剧集");
          if (input.sequence) {
            if (after.type !== "TV_SHOW") blockers.push("顺序集号只用于剧集，请先统一媒体类型");
            if (before.episodeEnd !== null && before.episodeEnd !== before.episode) blockers.push("合并多集文件不支持顺序生成，请单独编辑其起止集号");
            if (input.patch.episode !== undefined || input.patch.episodeEnd !== undefined) blockers.push("顺序生成与直接修改集号不能同时使用，请选择一种方式");
            after.episode = input.sequence.start + index; after.episodeEnd = null;
          }
          if (after.type === "TV_SHOW") {
            if (after.season === null || after.episode === null) blockers.push("保留集号时每条剧集必须已有季号和集号，请补齐或使用顺序生成");
            else if (after.episode > 10000 || (after.episodeEnd !== null && (after.episodeEnd < after.episode || after.episodeEnd - after.episode >= 1000))) blockers.push("结束集号不能小于起始集号，范围须少于一千集且集号不超过 10000");
          }
          records.set(row.id, { row, parsed: { ...parsed, ...after, episodes: after.episode === null ? [] : Array.from({ length: Math.min(1000, Math.max(0, (after.episodeEnd ?? after.episode) - after.episode + 1)) }, (_, offset) => after!.episode! + offset) } });
        } catch { blockers.push("原识别字段不完整，请重新识别此文件后再编辑"); }
      }
      if (seen.has(request.taskId)) blockers.push("同一任务被重复选择，请取消重复项"); seen.add(request.taskId);
      if (!Object.keys(input.patch).length && !input.sequence) blockers.push("请至少选择一个要修改的字段或启用顺序集号");
      items.push({ taskId: request.taskId, revision: row?.revision ?? 0, sourcePath: row?.source_path ?? request.taskId, before, after, blockers });
    }
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
      const x = items[a]!, y = items[b]!, p = x.after, q = y.after;
      if (p?.type !== "TV_SHOW" || q?.type !== "TV_SHOW" || !p.title || p.title.trim().normalize("NFC").toLowerCase() !== q.title?.trim().normalize("NFC").toLowerCase() || p.year !== q.year || p.season !== q.season || p.episode === null || q.episode === null) continue;
      const start = Math.max(p.episode, q.episode), end = Math.min(p.episodeEnd ?? p.episode, q.episodeEnd ?? q.episode);
      if (start <= end) { const coordinate = `S${p.season} E${start}${end > start ? `–${end}` : ""}`; x.blockers.push(`与「${basename(y.sourcePath).slice(0, 120)}」重复或重叠：${coordinate}；请修改集号或取消选择重复文件`); y.blockers.push(`与「${basename(x.sourcePath).slice(0, 120)}」重复或重叠：${coordinate}；请修改集号或取消选择重复文件`); }
    }
    if (new Set(items.map((item) => dirname(item.sourcePath))).size > 1) warnings.push("本次选择跨多个目录；公共字段会应用到每一项，请逐项核对，目录摘要不代表整组可确认");
    warnings.push("保存仅修改识别信息，已有 TMDB 候选会标记为待重新匹配；文件整理仍须另行预览并确认");
    const preview: CoreOutput<"ingestion.preview-recognition-edit"> = { fingerprint: hash({ input, snapshots }), canApply: items.every((item) => !item.blockers.length), items: items.map((item) => ({ ...item, blockers: item.blockers.slice(0, 20) })), warnings };
    return { preview, records };
  }
  preview(input: Input) { return this.plan(input).preview; }
  save(input: CoreInput<"ingestion.save-recognition-edit">) {
    const db = this.database.connection, signature = hash(input), old = db.prepare("SELECT signature,result_json FROM ingestion_recognition_command WHERE request_key=?").get(input.requestKey) as { signature: string; result_json: string } | undefined;
    if (old) { if (old.signature !== signature) throw conflict("请求标识已用于另一项识别编辑，请重新预览"); return JSON.parse(old.result_json) as CoreOutput<"ingestion.save-recognition-edit">; }
    return db.transaction(() => {
      const { fingerprint: expected, requestKey: _key, rematch, ...request } = input, { preview, records } = this.plan(request);
      if (preview.fingerprint !== expected) throw conflict("识别字段、文件版本或来源已变化，请重新预览后保存");
      if (!preview.canApply) { const first = preview.items.find((row) => row.blockers.length)!; throw conflict(`「${basename(first.sourcePath).slice(0, 100)}」：${first.blockers[0]}`); }
      const stamp = new Date(this.now()).toISOString(), result: CoreOutput<"ingestion.save-recognition-edit"> = { updated: records.size, rematchQueued: rematch ? records.size : 0, items: [] };
      for (const { row, parsed } of records.values()) {
        const revision = row.revision + 1;
        db.prepare("INSERT INTO ingestion_recognition_edit(task_id,revision,parsed_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,parsed_json=excluded.parsed_json,updated_at=excluded.updated_at").run(row.id, revision, JSON.stringify(parsed), stamp);
        db.prepare("UPDATE media_task SET parsed_json=?,title=?,status=?,updated_at=? WHERE id=?").run(JSON.stringify(parsed), parsed.title, rematch ? "PENDING" : "AWAITING_CONFIRMATION", stamp, row.id);
        db.prepare("UPDATE ingestion_candidate SET reason=NULL WHERE id=?").run(row.candidate_id);
        db.prepare("UPDATE ingestion_preview SET expires_at=0 WHERE task_id=? AND operation_id IS NULL").run(row.id);
        if (rematch) db.prepare("DELETE FROM task_candidate WHERE task_id=?").run(row.id);
        result.items.push({ taskId: row.id, revision });
      }
      db.prepare("INSERT INTO ingestion_recognition_command VALUES(?,?,?,?)").run(input.requestKey, signature, JSON.stringify(result), stamp); return result;
    })();
  }
}
