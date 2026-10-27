import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { CoreDatabase } from "../infrastructure/database";
import { normalizeParse } from "../domain/media";
import { RecognitionEdits, compareRecognitionPaths } from "./recognition-edits";
import type { CoreInput } from "@media-marshal/contracts";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(episodes: (number | [number, number] | null)[] = [10, 2, 1]) {
  const path = await mkdtemp(join(tmpdir(), "marshal-recognition-edit-")); cleanup.push(() => rm(path, { recursive: true, force: true }));
  const db = await CoreDatabase.open(join(path, "core.sqlite3")); cleanup.push(() => db.close()); const source = randomUUID(), stamp = new Date().toISOString();
  db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'测试来源','custom','/测试输入','/测试媒体','AUTO','COPY',?)").run(source, stamp);
  const tasks = episodes.map((episode, index) => { const id = randomUUID(), candidate = randomUUID(), filename = `Show.S01E${Array.isArray(episode) ? episode[0] : episode ?? index + 1}.mkv`, parsed = normalizeParse({ title: "Show", year: 2026, type: "episode", season: 1, episode: Array.isArray(episode) ? Array.from({ length: episode[1] - episode[0] + 1 }, (_, i) => episode[0] + i) : episode ?? undefined }, filename);
    db.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,parsed_json,created_at,updated_at) VALUES(?,?,?,'AWAITING_CONFIRMATION',?,?,?)").run(id, source, `/测试输入/${filename}`, JSON.stringify(parsed), stamp, stamp);
    db.connection.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,attribute_key,is_current,snapshot_json,state,task_id,created_at,updated_at) VALUES(?,?,?,?,?,1,'{}','QUEUED',?,?,?)").run(candidate, source, JSON.stringify([filename]), id, id, id, stamp, stamp); return id;
  });
  const edits = new RecognitionEdits(db, () => {}), request = (patch: CoreInput<"ingestion.preview-recognition-edit">["patch"] = { title: "新作品" }) => ({ items: tasks.map((taskId) => ({ taskId, expectedRevision: edits.revision(taskId) })), patch });
  return { db, tasks, edits, request };
}
describe("待确认识别字段预览与持久化", () => {
  it("对照 Java 自然文件名顺序生成连续集号，预览不修改任务", async () => {
    const f = await fixture(), request = { ...f.request({}), sequence: { start: 1, direction: "ASC" as const } }, preview = f.edits.preview(request);
    expect(preview.canApply).toBe(true); expect(preview.items.map((row) => row.taskId)).toEqual([f.tasks[2], f.tasks[1], f.tasks[0]]); expect(preview.items.map((row) => row.after?.episode)).toEqual([1, 2, 3]);
    expect(f.edits.revision(f.tasks[0]!)).toBe(0); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
    const reversed = f.edits.preview({ ...request, sequence: { start: 5, direction: "DESC" } }); expect(reversed.items.map((row) => row.taskId)).toEqual(f.tasks); expect(reversed.items.map((row) => row.after?.episode)).toEqual([5, 6, 7]);
  });
  it("缺失集号、合并集顺序生成、电影顺序生成分别定位阻断，不伪造范围", async () => {
    const f = await fixture([null, [2, 3]]); expect(f.edits.preview(f.request()).items[0]?.blockers.join()).toContain("已有季号和集号");
    const range = f.edits.preview({ ...f.request({}), sequence: { start: 1, direction: "ASC" } }); expect(range.canApply).toBe(false); expect(range.items.find((row) => row.taskId === f.tasks[1])?.blockers.join()).toContain("合并多集");
    expect(f.edits.preview({ ...f.request({ type: "MOVIE" }), sequence: { start: 1, direction: "ASC" } }).canApply).toBe(false);
  });
  it("重复或重叠季集定位双方文件及实际范围，取消重复项后可保存", async () => {
    const f = await fixture([[1, 3], [2, 4]]), request = f.request(), preview = f.edits.preview(request); expect(preview.canApply).toBe(false);
    expect(preview.items.every((row) => row.blockers.some((value) => value.includes("S1 E2–3") && value.includes("Show.S01E")))).toBe(true);
    const clean = { ...request, items: request.items.slice(0, 1) }, checked = f.edits.preview(clean); expect(checked.canApply).toBe(true); expect(f.edits.save({ ...clean, fingerprint: checked.fingerprint, requestKey: randomUUID(), rematch: false }).updated).toBe(1);
  });
  it("选择性修改公共字段保留其他字段，改成电影清空季集，重复保存不二次更新", async () => {
    const f = await fixture([1]), request = f.request({ type: "MOVIE" }), p = f.edits.preview(request), command = { ...request, fingerprint: p.fingerprint, requestKey: randomUUID(), rematch: false };
    expect(p.items[0]?.after).toEqual({ title: "Show", year: 2026, type: "MOVIE", season: null, episode: null, episodeEnd: null });
    const result = f.edits.save(command); expect(result).toMatchObject({ updated: 1, rematchQueued: 0 }); expect(f.edits.save(command)).toEqual(result); expect(f.edits.revision(f.tasks[0]!)).toBe(1); expect(f.edits.matchesStale(f.tasks[0]!)).toBe(true);
    expect(() => f.edits.save({ ...command, rematch: true })).toThrow("请求标识"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
  });
  it("同标题不同年份不能仅凭名称推断为同一作品，最终作品身份仍由整理预览核对", async () => {
    const f = await fixture([1, 2]); const row = f.db.connection.prepare("SELECT parsed_json FROM media_task WHERE id=?").get(f.tasks[1]) as { parsed_json: string };
    f.db.connection.prepare("UPDATE media_task SET parsed_json=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.parsed_json), year: 2025 }), f.tasks[1]);
    expect(f.edits.preview(f.request({ episode: 1 })).canApply).toBe(true); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
  });
  it("成员状态、文件版本、来源配置或识别版本变化使预览失效，整批保存回滚", async () => {
    const f = await fixture([1, 2]), request = f.request(), p = f.edits.preview(request), command = { ...request, fingerprint: p.fingerprint, requestKey: randomUUID(), rematch: true };
    f.db.connection.prepare("UPDATE desktop_source SET version=version+1").run(); expect(() => f.edits.save(command)).toThrow("重新预览"); expect(f.edits.revision(f.tasks[0]!)).toBe(0);
    const current = f.edits.preview(request); f.db.connection.exec("CREATE TRIGGER edit_fault BEFORE INSERT ON ingestion_recognition_command BEGIN SELECT RAISE(ABORT,'受控编辑故障'); END");
    expect(() => f.edits.save({ ...command, fingerprint: current.fingerprint })).toThrow("受控编辑故障"); expect(f.edits.revision(f.tasks[0]!)).toBe(0); expect(f.db.connection.prepare("SELECT DISTINCT status FROM media_task").all()).toEqual([{ status: "AWAITING_CONFIRMATION" }]);
    f.db.connection.exec("DROP TRIGGER edit_fault"); const saved = f.edits.save({ ...command, fingerprint: current.fingerprint }); expect(saved.rematchQueued).toBe(2); expect(f.db.connection.prepare("SELECT DISTINCT status FROM media_task").all()).toEqual([{ status: "PENDING" }]);
    const reopened = new RecognitionEdits(f.db, () => {}); expect(reopened.saved(f.tasks[0]!)?.title).toBe("新作品"); expect(reopened.revision(f.tasks[0]!)).toBe(1);
  });
  it("已经整理的任务不能通过编辑入口修改，重复任务和空编辑明确阻断", async () => {
    const f = await fixture([1]), request = f.request(); f.db.connection.prepare("UPDATE media_task SET status='DONE'").run(); const preview = f.edits.preview(request); expect(preview.canApply).toBe(false); expect(preview.items[0]?.blockers.join()).toContain("修正入口");
    expect(f.edits.preview({ items: [...request.items, ...request.items], patch: {} }).items.at(-1)?.blockers.join()).toContain("重复选择");
  });
  it("自然顺序支持超长数字和前导零且比较可逆", () => {
    expect(compareRecognitionPaths("E9999999999999999999.mkv", "E10000000000000000000.mkv")).toBeLessThan(0); expect(compareRecognitionPaths("E02.mkv", "E2.mkv")).toBe(-compareRecognitionPaths("E2.mkv", "E02.mkv"));
  });
});
