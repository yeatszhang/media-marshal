import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CoreDatabase } from "../infrastructure/database";
import { CorrectionPreparations } from "./correction-preparations";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "marshal-correction-preparation-")); cleanup.push(() => rm(path, { recursive: true, force: true }));
  const database = await CoreDatabase.open(join(path, "core.sqlite3")); cleanup.push(() => database.close()); const db = database.connection, taskId = randomUUID(), sourceId = randomUUID(), previewId = randomUUID(), stamp = new Date().toISOString();
  db.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'隔离来源','custom','/隔离输入','/隔离目标','MOVIE','COPY',?)").run(sourceId, stamp);
  db.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'DONE',?,?)").run(taskId, sourceId, "/隔离输入/原片.mp4", stamp, stamp);
  db.prepare("INSERT INTO media_correction_preview(id,request_key,task_id,input_hash,plan_json,expires_at) VALUES(?,?,?,'fixture','{}',?)").run(previewId, randomUUID(), taskId, Date.now() + 600000);
  const handlers: ConstructorParameters<typeof CorrectionPreparations>[1] = { taskId: () => taskId, run: async () => ({ previewId }), recover: () => null };
  const queue = new CorrectionPreparations(database, handlers); cleanup.push(() => queue.close());
  return { database, db, queue, taskId, previewId, handlers, input: { requestKey: randomUUID(), taskId, selection: { tmdbId: 1, mediaType: "MOVIE" } } };
}
function gate() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { promise, release }; }
describe("修正只读核验的持久收据和取消", () => {
  it("请求先返回编号；同内容并发合并，其他内容和跨动作请求键被拒绝", async () => {
    const f = await fixture(), held = gate(); cleanup.push(() => held.release()); let calls = 0;
    f.handlers.run = async () => { calls++; await held.promise; return { previewId: f.previewId }; };
    const row = f.queue.enqueue("PREVIEW", f.input); expect(row).toMatchObject({ state: "PENDING", taskId: f.taskId }); expect(calls).toBe(0);
    expect(f.queue.enqueue("PREVIEW", f.input).id).toBe(row.id); expect(f.queue.enqueue("PREVIEW", { ...f.input, requestKey: randomUUID() }).id).toBe(row.id);
    expect(() => f.queue.enqueue("CONFIRM", f.input)).toThrow("请求标识"); expect(() => f.queue.enqueue("PREVIEW", { ...f.input, selection: { tmdbId: 2 } })).toThrow("请求标识");
    expect(() => f.queue.enqueue("PREVIEW", { ...f.input, requestKey: randomUUID(), selection: { tmdbId: 2 } })).toThrow("其他修正核验");
    const flight = f.queue.tick(); expect(calls).toBe(1); held.release(); await flight;
    expect(f.queue.get(row.id)).toMatchObject({ state: "READY", previewId: f.previewId, operationId: null }); expect(f.queue.enqueue("PREVIEW", f.input).id).toBe(row.id); expect(calls).toBe(1);
  });
  it("取消正在读取的核验传递信号，逐文件字节进度可查询，停止后不创建预览", async () => {
    const f = await fixture(); let aborted = false;
    f.handlers.run = async (_kind, _input, signal, progress) => {
      progress({ currentPath: "/隔离目标/中文大文件.mkv", readBytes: 1024, totalBytes: 4096 });
      await new Promise<void>((_done, fail) => signal.addEventListener("abort", () => { aborted = true; fail(new Error("读取已中断")); }, { once: true })); return { previewId: f.previewId };
    };
    const row = f.queue.enqueue("PREVIEW", f.input), flight = f.queue.tick(); expect(f.queue.get(row.id)).toMatchObject({ state: "RUNNING", readBytes: 1024, totalBytes: 4096, currentPath: "/隔离目标/中文大文件.mkv" });
    expect(f.queue.cancel(row.id).state).toBe("CANCELING"); await flight; expect(aborted).toBe(true); expect(f.queue.get(row.id)).toMatchObject({ state: "CANCELED", previewId: null, operationId: null });
  });
  it("排队中取消不执行；已提交结果即使等待被取消也仍返回原结果", async () => {
    const f = await fixture(), held = gate(); cleanup.push(() => held.release()); let calls = 0;
    f.handlers.run = async () => { calls++; await held.promise; return { previewId: f.previewId }; };
    const first = f.queue.enqueue("PREVIEW", f.input); expect(f.queue.cancel(first.id).state).toBe("CANCELED"); await f.queue.tick(); expect(calls).toBe(0);
    const second = f.queue.enqueue("PREVIEW", { ...f.input, requestKey: randomUUID() }), flight = f.queue.tick(); f.queue.cancel(second.id); held.release(); await flight;
    expect(f.queue.get(second.id)).toMatchObject({ state: "READY", previewId: f.previewId }); expect(calls).toBe(1);
  });
  it("恢复未完成请求标记中断，不自动重放；结果已提交则补记原编号", async () => {
    const f = await fixture(), first = f.queue.enqueue("PREVIEW", f.input); await f.queue.close();
    f.db.prepare("UPDATE media_correction_preparation SET state='RUNNING' WHERE id=?").run(first.id); let calls = 0;
    const queue = new CorrectionPreparations(f.database, { ...f.handlers, run: async () => { calls++; return { previewId: f.previewId }; } }); cleanup.push(() => queue.close());
    expect(queue.get(first.id)).toMatchObject({ state: "INTERRUPTED", previewId: null, failure: { code: "INTERRUPTED" } }); await queue.tick(); expect(calls).toBe(0);
    f.db.prepare("UPDATE media_correction_preparation SET state='RUNNING' WHERE id=?").run(first.id);
    const recovered = new CorrectionPreparations(f.database, { ...f.handlers, recover: () => ({ previewId: f.previewId }) }); cleanup.push(() => recovered.close());
    expect(recovered.get(first.id)).toMatchObject({ state: "READY", previewId: f.previewId }); expect(f.db.prepare("SELECT count(*) AS n FROM media_correction_preparation").get()).toEqual({ n: 1 });
  });
  it("原始异常不泄漏敏感响应；停止核验保留中断收据与已完成结果", async () => {
    const f = await fixture(); f.handlers.run = async () => { throw new Error("SECRET fixture_cookie=不能回显"); };
    const first = f.queue.enqueue("PREVIEW", f.input); await f.queue.tick(); expect(f.queue.get(first.id)).toMatchObject({ state: "FAILED", failure: { code: "INTERNAL_ERROR" } }); expect(JSON.stringify(f.queue.get(first.id))).not.toContain("SECRET");
    f.handlers.run = async (_kind, _input, signal) => { await new Promise<void>((_done, fail) => signal.addEventListener("abort", () => fail(new Error("停止")), { once: true })); return { previewId: f.previewId }; };
    const second = f.queue.enqueue("PREVIEW", { ...f.input, requestKey: randomUUID() }); const flight = f.queue.tick(); await f.queue.close(); await flight;
    expect(f.queue.get(second.id)).toMatchObject({ state: "INTERRUPTED", failure: { code: "INTERRUPTED" } }); expect(f.queue.get(first.id).state).toBe("FAILED");
  });
  it("并发核验有全局上限，取消排队项后才能接入其他任务", async () => {
    const f = await fixture(), ids = [f.taskId, ...Array.from({ length: 16 }, () => randomUUID())];
    for (const [index, id] of ids.slice(1).entries()) f.db.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) SELECT ?,source_id,source_path||?,'DONE',created_at,updated_at FROM media_task WHERE id=?").run(id, String(index), f.taskId);
    f.handlers.taskId = (_kind, input) => (input as { taskId: string }).taskId;
    const queued = ids.slice(0, 16).map((taskId) => f.queue.enqueue("PREVIEW", { ...f.input, taskId, requestKey: randomUUID() })); const last = { ...f.input, taskId: ids[16]!, requestKey: randomUUID() };
    expect(() => f.queue.enqueue("PREVIEW", last)).toThrow("16 项"); f.queue.cancel(queued[0]!.id); expect(f.queue.enqueue("PREVIEW", last).state).toBe("PENDING");
  });
});
