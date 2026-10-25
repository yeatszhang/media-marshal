import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { CoreDatabase } from "../infrastructure/database";
import { SourceScans, type ScanResult } from "./scans";
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const db = await CoreDatabase.open(":memory:"); cleanup.push(() => db.close()); const sourceId = randomUUID(), stamp = new Date().toISOString();
  db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'扫描测试','custom','/输入','/目标','AUTO','COPY',?)").run(sourceId, stamp);
  let clock = Date.now(), waiting: string | null = null, context = "version-1";
  const scope = vi.fn(() => ({ physicalId: sourceId, name: "扫描测试", context, waiting })), scan = vi.fn(async (): Promise<ScanResult> => ({ discovered: 2, checkedPaths: ["1.mp4", "2.mp4"], issues: [] }));
  const jobs = new SourceScans(db, scope, scan, () => clock); cleanup.push(() => jobs.close());
  return { db, sourceId, scope, scan, jobs, input: () => ({ sourceId, requestKey: randomUUID() }), pause(value: string | null) { waiting = value; }, version(value: string) { context = value; }, advance() { clock += 5001; } };
}
describe("持久手动目录扫描", () => {
  it("立即返回 ID，重复收据与同来源并发合并，完成后新意图保留旧历史", async () => {
    const f = await fixture(); let release!: (value: ScanResult) => void; f.scan.mockImplementationOnce(() => new Promise((done) => { release = done; })); cleanup.push(() => release({ discovered: 2, checkedPaths: ["1.mp4", "2.mp4"], issues: [] }));
    const input = f.input(), first = f.jobs.enqueue(input); expect(first.state).toBe("PENDING"); expect(f.jobs.enqueue(input).id).toBe(first.id); expect(f.jobs.enqueue(f.input()).id).toBe(first.id); expect(f.scan).toHaveBeenCalledTimes(1);
    expect(f.db.connection.prepare("SELECT state FROM ingestion_source_scan").get()).toEqual({ state: "RUNNING" }); expect(() => f.jobs.enqueue({ ...input, sourceId: randomUUID() })).toThrow("其他来源");
    release({ discovered: 2, checkedPaths: ["1.mp4", "2.mp4"], issues: [] }); await f.jobs.idle(); expect(f.jobs.get({ id: first.id }).job).toMatchObject({ state: "COMPLETED", discovered: 2 }); expect(f.jobs.enqueue(input).id).toBe(first.id);
    const second = f.jobs.enqueue(f.input()); expect(second.id).not.toBe(first.id); await f.jobs.idle(); expect(f.jobs.list({}).total).toBe(2);
  });
  it("暂停与缺盘等待保留原 ID，恢复重新扫描；规则变化终止旧意图，不套用新配置", async () => {
    const f = await fixture(); f.pause("原目录尚未授权"); const job = f.jobs.enqueue(f.input()); await f.jobs.idle(); expect(f.scan).not.toHaveBeenCalled(); expect(f.jobs.get({ id: job.id }).job.state).toBe("WAITING_SOURCE");
    f.pause(null); f.advance(); f.jobs.kick(); await f.jobs.idle(); expect(f.jobs.get({ id: job.id }).job.state).toBe("COMPLETED");
    let release!: (value: ScanResult) => void; f.scan.mockImplementationOnce(() => new Promise((done) => { release = done; })); cleanup.push(() => release({ discovered: 2, checkedPaths: ["1.mp4", "2.mp4"], issues: [] }));
    const old = f.jobs.enqueue(f.input()); f.version("version-2"); release({ discovered: 99, checkedPaths: [], issues: [] }); await f.jobs.idle(); expect(f.jobs.get({ id: old.id }).job).toMatchObject({ state: "FAILED", discovered: 0, failure: expect.stringContaining("配置") });
    const next = f.jobs.enqueue(f.input()); await f.jobs.idle(); expect(f.jobs.get({ id: next.id }).job.state).toBe("COMPLETED");
  });
  it("逐项失败持久分页，修复重扫不抹掉旧问题；关闭查询不创建工作", async () => {
    const f = await fixture(); f.scan.mockResolvedValueOnce({ discovered: 1, checkedPaths: ["1.mp4"], issues: Array.from({ length: 101 }, (_, index) => ({ relativePath: `目录/${String(index).padStart(3, "0")}.mp4`, failure: "原文件不可读，请检查读取权限" })) });
    const job = f.jobs.enqueue(f.input()); await f.jobs.idle(); expect(f.jobs.get({ id: job.id }).job).toMatchObject({ state: "PARTIAL_FAILED", failed: 101, discovered: 1 }); expect(f.jobs.get({ id: job.id }).issues).toHaveLength(100); expect(f.jobs.get({ id: job.id, page: 2 }).issues).toHaveLength(1);
    f.jobs.list({}); f.jobs.get({ id: job.id }); expect(f.scan).toHaveBeenCalledTimes(1); f.jobs.enqueue(f.input()); await f.jobs.idle(); expect(f.jobs.get({ id: job.id }).total).toBe(101); expect(f.scan).toHaveBeenCalledTimes(2);
  });
  it("恢复在途意图先等待授权，关闭等待底层执行并保留 PENDING，不误记完成", async () => {
    const f = await fixture(), id = randomUUID(), stamp = new Date().toISOString();
    f.db.connection.prepare("INSERT INTO ingestion_source_scan(id,source_id,physical_source_id,source_name,context,state,created_at,updated_at) VALUES(?,?,?,'扫描测试','version-1','RUNNING',?,?)").run(id, f.sourceId, f.sourceId, stamp, stamp);
    f.pause("原目录等待授权"); const recovered = new SourceScans(f.db, f.scope, f.scan); cleanup.push(() => recovered.close()); expect(recovered.get({ id }).job.state).toBe("PENDING"); recovered.kick(); await recovered.idle(); expect(recovered.get({ id }).job.state).toBe("WAITING_SOURCE");
    f.pause(null); f.db.connection.prepare("UPDATE ingestion_source_scan SET next_attempt_at=0").run(); let release!: (value: ScanResult) => void; f.scan.mockImplementationOnce(() => new Promise((done) => { release = done; })); cleanup.push(() => release({ discovered: 2, checkedPaths: ["1.mp4", "2.mp4"], issues: [] }));
    recovered.kick(); let closed = false; const stopping = recovered.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false); expect(recovered.close()).toBe(recovered.close()); release({ discovered: 2, checkedPaths: ["1.mp4", "2.mp4"], issues: [] }); await stopping; expect(recovered.get({ id }).job.state).toBe("PENDING"); expect(() => recovered.enqueue(f.input())).toThrow("停止");
  });
});
