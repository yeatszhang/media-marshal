import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreDatabase } from "../infrastructure/database";
import { IngestionSeasons } from "./seasons";
import type { CoreOutput } from "@media-marshal/contracts";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(count = 3) {
  const root = await mkdtemp(join(tmpdir(), "marshal-seasons-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const db = await CoreDatabase.open(join(root, "core.sqlite3")); cleanup.push(() => db.close()); const sql = db.connection, sourceId = randomUUID(), stamp = new Date().toISOString(), entries: { id: string; taskId: string; relative: string[]; path: string }[] = [];
  sql.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'季集来源','custom',?,?,'AUTO','COPY',?)").run(sourceId, root, root + "-目标", stamp);
  for (const part of ["上半季", "下半季"]) await mkdir(join(root, part));
  for (let n = 0; n < count; n++) {
    const id = randomUUID(), taskId = randomUUID(), relative = [n % 2 ? "上半季" : "下半季", `原片.E${n + 1}.mkv`], path = join(root, ...relative); await writeFile(path, "下载原件保留");
    sql.prepare("INSERT INTO media_task(id,source_id,source_path,status,parsed_json,created_at,updated_at) VALUES(?,?,?,'AWAITING_CONFIRMATION',?,?,?)").run(taskId, sourceId, path, JSON.stringify({ title: "剧集", type: "TV_SHOW", season: 1, episode: n + 1, episodeEnd: null }), stamp, stamp);
    sql.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,snapshot_json,is_current,state,task_id,created_at,updated_at) VALUES(?,?,?,? ,?,1,'QUEUED',?,?,?)").run(id, sourceId, JSON.stringify(relative), randomUUID(), JSON.stringify({ size: Buffer.byteLength("下载原件保留") }), taskId, stamp, stamp);
    sql.prepare("INSERT INTO task_candidate VALUES(?,?,?,?)").run(randomUUID(), taskId, JSON.stringify({ tmdbId: 7, mediaType: "TV_SHOW", title: "共同剧集" }), 0.8); entries.push({ id, taskId, relative, path });
  }
  const candidate = (id: string): CoreOutput<"ingestion.candidates">["items"][number] => { const entry = entries.find((item) => item.id === id)!; return { id, sourceId, relativePath: entry.relative.join("/"), state: "QUEUED", taskId: entry.taskId, reason: null, requiresConfirmation: true, size: Buffer.byteLength("下载原件保留"), updatedAt: stamp }; };
  const task = (taskId: string): CoreOutput<"ingestion.task"> => { const entry = entries.find((item) => item.taskId === taskId)!, row = sql.prepare("SELECT parsed_json,status FROM media_task WHERE id=?").get(taskId) as { parsed_json: string; status: string }; return { taskId, candidateId: entry.id, sourcePath: entry.path, state: row.status, parsed: { year: null, ...JSON.parse(row.parsed_json) }, matches: [], failure: null }; };
  return { db, sql, root, entries, sourceId, stamp, seasons: new IngestionSeasons(db, candidate, task) };
}
describe("只读季集候选索引", () => {
  it("跨父目录汇总完整 101 项，成员按真实数字排序分页，查询不创建任何整理或识别作业", async () => {
    const f = await fixture(101), result = f.seasons.list({}); expect(result).toMatchObject({ total: 1, items: [{ tmdbId: 7, season: 1, total: 101, bytes: 101 * Buffer.byteLength("下载原件保留") }] });
    const group = result.items[0]!, first = f.seasons.get({ id: group.id, sourceId: f.sourceId }), second = f.seasons.get({ id: group.id, sourceId: f.sourceId, page: 2 }); expect(first.items).toHaveLength(100); expect(first.items[0]!.task.parsed?.episode).toBe(1); expect(second.items[0]!.task.parsed?.episode).toBe(101);
    for (const table of ["desktop_job", "ingestion_operation", "ingestion_organize_batch"]) expect(f.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 }); expect(await readFile(f.entries[0]!.path, "utf8")).toBe("下载原件保留");
  });
  it("按来源、策略、候选和季号隔离，同文件的重复候选不重复计数，特别篇保留 S0", async () => {
    const f = await fixture(), task = f.entries[0]!.taskId;
    f.sql.prepare("INSERT INTO task_candidate VALUES(?,?,?,?)").run(randomUUID(), task, JSON.stringify({ tmdbId: 7, mediaType: "TV_SHOW", title: "共同剧集" }), 0.9); expect(f.seasons.list({}).items[0]!.total).toBe(3);
    f.sql.prepare("INSERT INTO task_candidate VALUES(?,?,?,?)").run(randomUUID(), task, JSON.stringify({ tmdbId: 8, mediaType: "TV_SHOW", title: "另一个候选" }), 0.7); expect(f.seasons.list({}).total).toBe(2);
    f.sql.prepare("UPDATE media_task SET parsed_json=json_set(parsed_json,'$.season',0) WHERE id=?").run(task); expect(f.seasons.list({}).items.some((group) => group.season === 0)).toBe(true);
    const target = randomUUID(); f.sql.prepare("INSERT INTO media_target_root(id,grant_json) VALUES(?,'{}')").run(target); f.sql.prepare("INSERT INTO ingestion_candidate_policy VALUES(?,?,?,?)").run(f.entries[1]!.id, "b".repeat(64), "{}", target); expect(f.seasons.list({}).total).toBe(4);
    const source = randomUUID(); f.sql.prepare("INSERT INTO desktop_source SELECT ?,name,kind,source_path||'-另一个',target_path,media_type,operation,automatic,version,paused,health,created_at FROM desktop_source WHERE id=?").run(source, f.sourceId); f.sql.prepare("UPDATE ingestion_candidate SET source_id=? WHERE id=?").run(source, f.entries[2]!.id); f.sql.prepare("UPDATE media_task SET source_id=? WHERE id=?").run(source, f.entries[2]!.taskId); expect(f.seasons.list({}).total).toBe(4);
    const group = f.seasons.list({}).items.find((group) => group.sourceId === f.sourceId)!; expect(() => f.seasons.get({ id: group.id, sourceId: source })).toThrow("季集候选组已变化");
  });
  it("旧匹配、已执行任务、缺季号、电影和已替代版本排除，编辑后旧组引用失效", async () => {
    const f = await fixture(5), old = f.seasons.list({}).items[0]!;
    f.sql.prepare("INSERT INTO ingestion_recognition_edit VALUES(?,1,0,'{}',?)").run(f.entries[0]!.taskId, f.stamp);
    f.sql.prepare("UPDATE media_task SET status='DONE' WHERE id=?").run(f.entries[1]!.taskId);
    f.sql.prepare("UPDATE media_task SET parsed_json=json_set(parsed_json,'$.season',NULL) WHERE id=?").run(f.entries[2]!.taskId);
    f.sql.prepare("UPDATE media_task SET parsed_json=json_set(parsed_json,'$.type','MOVIE') WHERE id=?").run(f.entries[3]!.taskId);
    f.sql.prepare("UPDATE ingestion_candidate SET is_current=0 WHERE id=?").run(f.entries[4]!.id);
    expect(f.seasons.list({})).toEqual({ items: [], total: 0 }); expect(() => f.seasons.get({ id: old.id, sourceId: f.sourceId })).toThrow("刷新季集列表");
    f.sql.prepare("UPDATE ingestion_recognition_edit SET matched_revision=1 WHERE task_id=?").run(f.entries[0]!.taskId); expect(f.seasons.list({}).items[0]!.total).toBe(1);
  });
});
