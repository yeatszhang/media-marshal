import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreDatabase } from "../infrastructure/database";
import { RecognitionBatches, type BatchAvailability } from "./recognition-batches";
import { IngestionDirectories } from "./directories";
import type { CoreOutput } from "@media-marshal/contracts";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(count = 3) {
  const root = await mkdtemp(join(tmpdir(), "marshal-recognition-batch-")); cleanup.push(() => rm(root, { recursive: true, force: true })); const path = join(root, "core.sqlite3"), db = await CoreDatabase.open(path); cleanup.push(() => db.close());
  let clock = Date.now(); const stamp = new Date(clock).toISOString(), source = randomUUID(), ids: string[] = [], eligibility = new Map<string, BatchAvailability>();
  db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'目录识别测试','custom','/测试输入','/测试目标','AUTO','COPY',?)").run(source, stamp);
  for (let n = 0; n < count; n++) { const id = randomUUID(); ids.push(id); db.connection.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,attribute_key,is_current,snapshot_json,state,created_at,updated_at) VALUES(?,?,?,?,?,1,?,'READY',?,?)").run(id, source, JSON.stringify(["剧集", `E${n + 1}.mp4`]), id, id, JSON.stringify({ size: 10 }), stamp, stamp); }
  const paths = (id: string) => (JSON.parse((db.connection.prepare("SELECT relative_json FROM ingestion_candidate WHERE id=?").get(id) as { relative_json: string }).relative_json) as string[]).join("/");
  let claims = 0;
  const ports = { capture: (id: string) => ({ relativePath: paths(id), context: "原来源版本" }), availability: (id: string): BatchAvailability => eligibility.get(id) ?? { state: "READY" }, recognize: async (id: string) => {
    const previous = db.connection.prepare("SELECT task_id FROM ingestion_candidate WHERE id=?").get(id) as { task_id: string | null }; if (previous.task_id) return { taskId: previous.task_id };
    const taskId = randomUUID(); db.connection.transaction(() => { db.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'PENDING',?,?)").run(taskId, source, `/测试输入/${paths(id)}`, stamp, stamp); db.connection.prepare("UPDATE ingestion_candidate SET task_id=?,state='QUEUED',reason=NULL WHERE id=?").run(taskId, id); })(); claims++; return { taskId };
  } };
  const batches = new RecognitionBatches(db, ports, () => clock); cleanup.push(() => batches.close());
  const directories = new IngestionDirectories(db, (id): CoreOutput<"ingestion.candidates">["items"][number] => ({ id, sourceId: source, relativePath: paths(id), state: "READY", taskId: null, requiresConfirmation: true, reason: null, size: 10, updatedAt: stamp }), (taskId) => ({ taskId, candidateId: ids[0]!, state: "AWAITING_CONFIRMATION", parsed: null, matches: [], failure: null }));
  return { db, path, ids, source, ports, batches, directories, eligibility, claims: () => claims, advance() { clock += 5001; }, stamp };
}
describe("持久批量识别与目录范围", () => {
  it("创建和读取只保存提交意图，同请求和并发批次复用候选原任务，不创建 COPY", async () => {
    const f = await fixture(), input = { candidateIds: f.ids, requestKey: randomUUID() }, first = f.batches.create(input); expect(f.batches.create(input).id).toBe(first.id); expect(f.claims()).toBe(0);
    const other = f.batches.create({ ...input, requestKey: randomUUID() }); await f.batches.tick(); await f.batches.tick(); expect(f.claims()).toBe(3); expect(f.batches.get(first.id)).toMatchObject({ submitted: 3, failed: 0, pending: 0 }); expect(f.batches.get(other.id).submitted).toBe(3);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 }); expect(() => f.batches.create({ ...input, candidateIds: f.ids.slice(0, 1) })).toThrow("另一组候选");
  });
  it("等待不会堵住后续批次，失败逐项保存；匹配失败与提交失败分别计数", async () => {
    const f = await fixture(101); for (const id of f.ids.slice(0, 100)) f.eligibility.set(id, { state: "WAIT", reason: "等待原磁盘" });
    const waiting = f.batches.create({ candidateIds: f.ids.slice(0, 100), requestKey: randomUUID() }), runnable = f.batches.create({ candidateIds: [f.ids[100]!], requestKey: randomUUID() }); await f.batches.tick(); await f.batches.tick(); expect(f.batches.get(runnable.id).submitted).toBe(1); expect(f.batches.get(waiting.id).pending).toBe(100);
    const failed = f.ids[0]!, success = f.ids[1]!; f.eligibility.set(failed, { state: "FAILED", reason: "文件版本已变化，请重新选择" }); f.eligibility.set(success, { state: "READY" }); f.advance(); await f.batches.tick();
    const taskId = (f.db.connection.prepare("SELECT task_id FROM ingestion_candidate WHERE id=?").get(success) as { task_id: string }).task_id; f.db.connection.prepare("UPDATE media_task SET status='AWAITING_CONFIRMATION' WHERE id=?").run(taskId); f.db.connection.prepare("UPDATE ingestion_candidate SET reason='TMDB 密钥无效，请重新配置' WHERE id=?").run(success);
    expect(f.batches.get(waiting.id)).toMatchObject({ failed: 1, recognitionFailed: 1, submitted: 1, pending: 98 }); expect(f.batches.items({ id: waiting.id }).items.find((row) => row.candidateId === failed)?.failure).toContain("版本已变化");
  });
  it("任务已领取而批次补记失败时保留可见等待，重开执行器复用同任务", async () => {
    const f = await fixture(1), job = f.batches.create({ candidateIds: f.ids, requestKey: randomUUID() }); f.db.connection.exec("CREATE TRIGGER receipt_fault BEFORE UPDATE OF state ON ingestion_recognition_batch_item WHEN NEW.state='SUBMITTED' BEGIN SELECT RAISE(ABORT,'受控补记故障'); END");
    await f.batches.tick(); expect(f.claims()).toBe(1); expect(f.batches.items({ id: job.id }).items[0]).toMatchObject({ state: "PENDING", taskId: expect.any(String), waitingReason: expect.stringContaining("等待补记") }); await f.batches.close(); f.db.connection.exec("DROP TRIGGER receipt_fault"); f.advance();
    const resumed = new RecognitionBatches(f.db, f.ports, () => Date.now() + 10000); cleanup.push(() => resumed.close()); await resumed.tick(); expect(resumed.get(job.id)).toMatchObject({ state: "SUBMITTED", submitted: 1 }); expect(f.claims()).toBe(1);
  });
  it("取消只停止未提交项，已经提交任务和失败详情保留", async () => {
    const f = await fixture(5), job = f.batches.create({ candidateIds: f.ids, requestKey: randomUUID() }); await f.batches.tick(); expect(f.claims()).toBe(4); f.batches.cancel(job.id); await f.batches.tick(); expect(f.claims()).toBe(4); expect(f.batches.get(job.id)).toMatchObject({ state: "CANCELLED", submitted: 4, pending: 1 }); expect(f.batches.items({ id: job.id }).items.find((row) => row.state === "PENDING")?.waitingReason).toContain("未提交");
  });
  it("真实数据库重开后恢复同一批次，纯查询不重放提交", async () => {
    const f = await fixture(2); f.eligibility.set(f.ids[0]!, { state: "WAIT", reason: "等待原盘" }); const job = f.batches.create({ candidateIds: f.ids, requestKey: randomUUID() }); await f.batches.tick(); expect(f.claims()).toBe(1); await f.batches.close(); f.db.close();
    const db = await CoreDatabase.open(f.path); cleanup.push(() => db.close()); let claims = 0;
    const resumed = new RecognitionBatches(db, { capture() { throw new Error("查询不应重新捕获意图"); }, availability: () => ({ state: "READY" }), recognize: async (candidateId) => { const previous = db.connection.prepare("SELECT task_id FROM ingestion_candidate WHERE id=?").get(candidateId) as { task_id: string | null }; if (previous.task_id) return { taskId: previous.task_id }; const taskId = randomUUID(); db.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'PENDING',?,?)").run(taskId, f.source, "/测试输入/恢复.mp4", f.stamp, f.stamp); db.connection.prepare("UPDATE ingestion_candidate SET task_id=? WHERE id=?").run(taskId, candidateId); claims++; return { taskId }; } }, () => Date.now() + 10000); cleanup.push(() => resumed.close());
    expect(resumed.list({}).items[0]).toMatchObject({ id: job.id, submitted: 1, pending: 1 }); expect(resumed.items({ id: job.id }).total).toBe(2); expect(claims).toBe(0); await resumed.tick(); expect(resumed.get(job.id)).toMatchObject({ submitted: 2, pending: 0 }); expect(claims).toBe(1); expect(db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 2 });
  });
  it("目录按来源与整理策略分开，成员分页不会把当前页当整组，共同候选要求全部成员支持", async () => {
    const f = await fixture(101), groups = f.directories.list({}); expect(groups.items).toHaveLength(1); const group = groups.items[0]!; expect(group).toMatchObject({ total: 101, ready: 101 });
    expect(f.directories.get({ id: group.id, sourceId: f.source, page: 1 }).items).toHaveLength(100); expect(f.directories.get({ id: group.id, sourceId: f.source, page: 2 }).items).toHaveLength(1);
    const job = f.batches.create({ candidateIds: f.ids.slice(0, 2), requestKey: randomUUID() }); await f.batches.tick(); const tasks = f.batches.items({ id: job.id }).items;
    for (const task of tasks) { f.db.connection.prepare("UPDATE media_task SET status='AWAITING_CONFIRMATION' WHERE id=?").run(task.taskId); const metadata = { tmdbId: 7, mediaType: "TV_SHOW", title: "共同作品", originalTitle: null, year: 2026, evidence: "filename", score: { confidence: 0.9 } }; f.db.connection.prepare("INSERT INTO task_candidate VALUES(?,?,?,?)").run(randomUUID(), task.taskId, JSON.stringify(metadata), 0.9); }
    const detail = f.directories.get({ id: group.id, sourceId: f.source }); expect(detail.options[0]).toMatchObject({ supportedFiles: 2, common: false });
    const policyTarget = randomUUID(); f.db.connection.prepare("INSERT INTO media_target_root(id,grant_json) VALUES(?,'{}')").run(policyTarget); f.db.connection.prepare("INSERT INTO ingestion_candidate_policy VALUES(?,?,?,?)").run(f.ids[0], "a".repeat(64), "{}", policyTarget); expect(f.directories.list({}).items).toHaveLength(2);
    expect(() => f.directories.get({ id: group.id, sourceId: randomUUID() })).toThrow("归属已变化");
  });
});
