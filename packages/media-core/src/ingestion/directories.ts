import { createHash } from "node:crypto";
import { DesktopError, type CoreInput, type CoreOutput, type IngestionDirectory } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { MediaMatch } from "../domain/matching.js";

const parent = "json_remove(c.relative_json,'$[#-1]')", policy = "coalesce(p.policy_key,'local')";
const from = " FROM ingestion_candidate c JOIN desktop_source s ON s.id=c.source_id LEFT JOIN ingestion_candidate_policy p ON p.candidate_id=c.id LEFT JOIN media_task t ON t.id=c.task_id";
const pending = " (c.managed_item_id IS NOT NULL OR c.is_current=1) AND c.state IN ('OBSERVING','READY','UNAVAILABLE','QUEUED')";
interface Group { source_id: string; name: string; parent: string; policy: string; total: number; ready: number; awaiting: number; bytes: number }

/** 目录身份只由已登记候选计算；请求中的摘要不能指定任意文件系统路径。 */
export class IngestionDirectories {
  constructor(private readonly database: CoreDatabase, private readonly candidate: (id: string) => CoreOutput<"ingestion.candidates">["items"][number], private readonly task: (id: string) => CoreOutput<"ingestion.task">) {
    database.connection.function("ingestion_directory_id", { deterministic: true }, (source, relative, rule) => this.key(String(source), String(relative), String(rule)));
  }
  private key(source: string, relative: string, rule: string) { return createHash("sha256").update(JSON.stringify([source, relative, rule])).digest("hex"); }
  private select = `SELECT c.source_id,s.name,${parent} AS parent,${policy} AS policy,count(*) AS total,sum(CASE WHEN c.state='READY' AND c.task_id IS NULL THEN 1 ELSE 0 END) AS ready,sum(CASE WHEN t.status='AWAITING_CONFIRMATION' THEN 1 ELSE 0 END) AS awaiting,coalesce(sum(json_extract(c.snapshot_json,'$.size')),0) AS bytes${from}`;
  private dto(row: Group): IngestionDirectory { return { id: this.key(row.source_id, row.parent, row.policy), sourceId: row.source_id, sourceName: row.name.slice(0, 100), relativePath: (JSON.parse(row.parent) as string[]).join("/"), total: row.total, ready: row.ready, awaiting: row.awaiting, bytes: row.bytes }; }
  list(input: CoreInput<"ingestion.directories">) {
    const db = this.database.connection, group = ` GROUP BY c.source_id,${parent},${policy}`;
    const rows = db.prepare(this.select + ` WHERE ${pending}` + group + " ORDER BY s.name,c.source_id,parent,policy LIMIT 25 OFFSET ?").all(((input.page ?? 1) - 1) * 25) as Group[];
    const total = (db.prepare(`SELECT count(*) AS n FROM (SELECT 1${from} WHERE ${pending}${group})`).get() as { n: number }).n;
    return { items: rows.map((row) => this.dto(row)), total };
  }
  get(input: CoreInput<"ingestion.directory">): CoreOutput<"ingestion.directory"> {
    const db = this.database.connection;
    const row = db.prepare(this.select + ` WHERE c.source_id=? AND ${pending} GROUP BY ${parent},${policy} HAVING ingestion_directory_id(c.source_id,${parent},${policy})=?`).get(input.sourceId, input.id) as Group | undefined;
    if (!row) throw new DesktopError("CONFLICT", "此目录已没有待处理候选或归属已变化，请刷新目录列表");
    const where = ` c.source_id=? AND ${parent}=? AND ${policy}=? AND ${pending}`, args = [row.source_id, row.parent, row.policy];
    const members = db.prepare(`SELECT c.id,c.task_id${from} WHERE ${where} ORDER BY c.relative_json,c.id LIMIT 100 OFFSET ?`).all(...args, ((input.page ?? 1) - 1) * 100) as { id: string; task_id: string | null }[];
    const options = db.prepare(`SELECT tc.metadata_json,count(DISTINCT t.id) AS supported${from} JOIN task_candidate tc ON tc.task_id=t.id LEFT JOIN ingestion_recognition_edit e ON e.task_id=t.id WHERE ${where} AND t.status='AWAITING_CONFIRMATION' AND (e.revision IS NULL OR e.revision=e.matched_revision) GROUP BY json_extract(tc.metadata_json,'$.mediaType'),json_extract(tc.metadata_json,'$.tmdbId') ORDER BY supported DESC,avg(tc.confidence) DESC LIMIT 100`).all(...args) as { metadata_json: string; supported: number }[];
    return { directory: this.dto(row), items: members.map((member) => ({ candidate: this.candidate(member.id), task: member.task_id ? this.task(member.task_id) : null })), options: options.map((entry) => {
      const match = JSON.parse(entry.metadata_json) as MediaMatch;
      return { tmdbId: match.tmdbId, mediaType: match.mediaType, title: match.title, originalTitle: match.originalTitle, year: match.year, confidence: match.score.confidence, evidence: match.evidence, explanation: `${entry.supported}/${row.total} 个文件有此候选；仍须逐文件核对季集、来源与整理目标`, supportedFiles: entry.supported, common: entry.supported === row.total && row.awaiting === row.total };
    }) };
  }
}
