import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DesktopError } from "@media-marshal/contracts";
import { CoreDatabase } from "../infrastructure/database.js";
import { normalizeParse } from "../domain/media.js";
import { CodexJobs, type CodexJobPorts } from "./codex-jobs.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "marshal-codex-jobs-"))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const db = await CoreDatabase.open(join(root, "core.sqlite3")); cleanup.push(() => db.close());
  const member = { taskId: randomUUID(), candidateId: randomUUID(), relativePath: "作品/01.mkv", context: "frozen-context", revision: 0, parsed: normalizeParse({}, "01.mkv") };
  const ports: CodexJobPorts = { capture: vi.fn(() => [member]), run: vi.fn(async (_job, _members, _signal, progress) => { progress({ taskId: member.taskId, relativePath: member.relativePath, state: "UPDATED", failure: null, operationId: null }); }) };
  let clock = 0; const jobs = new CodexJobs(db, ports, () => clock); cleanup.push(() => jobs.close());
  return { db, ports, jobs, member, now: () => clock, advance: () => { clock += 6000; }, input: () => ({ taskId: member.taskId, directory: true, organize: false, requestKey: randomUUID() }) };
}
it("重复请求只执行一次，查询不触发模型；同一请求键不能替换范围", async () => {
  const f = await fixture(), input = f.input(), first = f.jobs.enqueue(input); expect(f.jobs.enqueue(input).id).toBe(first.id);
  await f.jobs.tick(); expect(f.jobs.get(first.id).state).toBe("COMPLETED"); f.jobs.list(); f.jobs.get(first.id);
  expect(f.ports.run).toHaveBeenCalledTimes(1);
  expect(() => f.jobs.enqueue({ ...input, directory: false })).toThrow("请求标识");
});
it("原目录暂不可用持久等待，恢复后继续同一作业", async () => {
  const f = await fixture(); vi.mocked(f.ports.run).mockRejectedValueOnce(new DesktopError("LOCAL_UNAVAILABLE", "等待原卷授权恢复"));
  const first = f.jobs.enqueue(f.input()); await f.jobs.tick(); expect(f.jobs.get(first.id)).toMatchObject({ state: "PENDING", failure: "等待原卷授权恢复" });
  await f.jobs.tick(); expect(f.ports.run).toHaveBeenCalledTimes(1); f.advance(); await f.jobs.tick();
  expect(f.jobs.get(first.id).state).toBe("COMPLETED"); expect(f.jobs.list().total).toBe(1);
});
it("重建服务将中断作业恢复为待处理，保留逐项进度及原请求收据", async () => {
  const f = await fixture(), input = f.input(), job = f.jobs.enqueue(input); await f.jobs.tick(); await f.jobs.close();
  const key = "recognition.codex.job." + job.id, row = f.db.connection.prepare("SELECT value FROM app_setting WHERE key=?").get(key) as { value: string }, stored = JSON.parse(row.value); stored.state = "RUNNING";
  f.db.connection.prepare("UPDATE app_setting SET value=? WHERE key=?").run(JSON.stringify(stored), key);
  const resumed = new CodexJobs(f.db, f.ports, f.now); cleanup.push(() => resumed.close());
  expect(resumed.get(job.id)).toMatchObject({ state: "PENDING", items: [expect.objectContaining({ state: "UPDATED" })] });
  expect(resumed.enqueue(input).id).toBe(job.id); await resumed.tick(); expect(resumed.get(job.id).state).toBe("COMPLETED");
});
it("取消保留已更新项并中断后续，未分类异常不透传原始敏感信息", async () => {
  const f = await fixture(); let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  vi.mocked(f.ports.run).mockImplementationOnce(async (_job, _members, signal, progress) => {
    progress({ taskId: f.member.taskId, relativePath: f.member.relativePath, state: "UPDATED", failure: null, operationId: null }); entered();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DesktopError("INTERRUPTED", "停止")), { once: true }));
  });
  const job = f.jobs.enqueue(f.input()); await started; f.jobs.cancel(job.id); await f.jobs.tick();
  expect(f.jobs.get(job.id)).toMatchObject({ state: "CANCELLED", items: [expect.objectContaining({ state: "UPDATED" })] });
  vi.mocked(f.ports.run).mockRejectedValueOnce(new Error("private-api-secret"));
  const failed = f.jobs.enqueue(f.input()); await f.jobs.tick(); expect(f.jobs.get(failed.id)).toMatchObject({ state: "FAILED", failure: expect.stringContaining("CLI 登录状态") });
  expect(JSON.stringify(f.jobs.get(failed.id))).not.toContain("private-api-secret");
});
