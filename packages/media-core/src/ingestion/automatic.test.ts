import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DesktopError, type OrganizePreview, type Recognition } from "@media-marshal/contracts";
import { CoreDatabase } from "../infrastructure/database";
import { AutomaticIngestion, type AutomaticAvailability, type AutomaticHooks } from "./automatic";
import { selectAutomaticWork } from "./automatic-selection";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function recognized(taskId = randomUUID(), candidateId = randomUUID()): Recognition {
  return { taskId, candidateId, state: "AWAITING_CONFIRMATION", parsed: { title: "作品", type: "MOVIE", year: 2026, season: null, episode: null, episodeEnd: null }, revision: 0, matches: [{ tmdbId: 7, mediaType: "MOVIE", title: "作品", originalTitle: null, year: 2026, confidence: 0.9, evidence: "filename", explanation: "名称与年份一致" }], failure: null };
}
async function fixture() {
  const db = await CoreDatabase.open(":memory:"); cleanup.push(() => db.close());
  const sourceId = randomUUID(), candidateId = randomUUID(), targetId = randomUUID(), stamp = new Date().toISOString();
  db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'隔离意图','custom','/输入','/媒体','AUTO','COPY',?)").run(sourceId, stamp);
  db.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,local_source_id,created_at,updated_at) VALUES(?,'local',1,1,?,?,?,?)").run(sourceId, JSON.stringify({ type: "local", name: "隔离意图", sourcePath: "/输入", organization: { targetPath: "/媒体" } }), sourceId, stamp, stamp);
  const candidate = (id = candidateId) => db.connection.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,attribute_key,is_current,snapshot_json,state,created_at,updated_at) VALUES(?,?,?,'version','attributes',1,'{}','READY',?,?)").run(id, sourceId, JSON.stringify([id + ".mkv"]), stamp, stamp);
  candidate(); db.connection.prepare("INSERT INTO media_target_root(id,grant_json,available) VALUES(?,'{}',1)").run(targetId);
  let availability: AutomaticAvailability = { state: "READY" }, clock = Date.now();
  const tasks = new Map<string, Recognition>();
  const hooks: AutomaticHooks = {
    check: vi.fn(() => availability), available: vi.fn(async () => availability),
    recognize: vi.fn(async (id, _key) => {
      const taskId = randomUUID(); db.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'AWAITING_CONFIRMATION',?,?)").run(taskId, sourceId, "/输入/" + id + ".mkv", stamp, stamp);
      tasks.set(taskId, recognized(taskId, id)); return { taskId };
    }),
    task: (id) => tasks.get(id)!,
    preview: vi.fn(async (taskId, requestKey) => {
      let row = db.connection.prepare("SELECT id FROM ingestion_preview WHERE request_key=?").get(requestKey) as { id: string } | undefined;
      if (!row) { row = { id: randomUUID() }; db.connection.prepare("INSERT INTO ingestion_preview(id,request_key,task_id,input_hash,plan_json,expires_at) VALUES(?,?,?,'input','{}',?)").run(row.id, requestKey, taskId, clock + 600000); }
      return { id: row.id, taskId, title: "作品", mediaType: "MOVIE", sourcePath: "/输入/作品.mkv", targetPath: "/媒体/作品.mkv", size: 20, season: null, episode: null, episodeEnd: null, expiresAt: clock + 600000, operationId: null } satisfies OrganizePreview;
    }),
    confirm: vi.fn(async (previewId, requestKey, check) => {
      check(); const id = randomUUID(), preview = db.connection.prepare("SELECT task_id FROM ingestion_preview WHERE id=?").get(previewId) as { task_id: string }, task = tasks.get(preview.task_id)!;
      db.connection.prepare("INSERT INTO ingestion_operation(id,candidate_id,task_id,request_key,target_root_id,target_slot,plan_json,attempt_id,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}',?,'PLANNED',?,?)").run(id, task.candidateId, task.taskId, requestKey, targetId, task.candidateId, randomUUID(), stamp, stamp);
      db.connection.prepare("UPDATE ingestion_preview SET operation_id=? WHERE id=?").run(id, previewId); return { operationId: id };
    }),
    receipt: (key) => { const row = db.connection.prepare("SELECT id FROM ingestion_operation WHERE request_key=?").get(key) as { id: string } | undefined; return row ? { operationId: row.id } : null; },
  };
  const create = () => { const worker = new AutomaticIngestion(db, hooks, () => clock); cleanup.push(() => worker.close()); return worker; };
  return { db, hooks, candidateId, sourceId, candidate, tasks, create, state(value: AutomaticAvailability) { availability = value; }, advance(ms: number) { clock += ms; }, input: { candidateId, sourceId, context: "frozen-source-version" } };
}
describe("持久自动整理意图", () => {
  it("重复发现合并意图；重启沿原请求键识别、预览和确认，已提交不再执行", async () => {
    const f = await fixture(), first = f.create(); first.enqueue(f.input); first.enqueue(f.input); await first.tick();
    const keys = f.db.connection.prepare("SELECT recognition_key,preview_key,confirmation_key FROM ingestion_automatic").get();
    await first.close(); const second = f.create(); await second.tick(); expect(second.status(f.candidateId)?.state).toBe("SUBMITTED");
    await second.close(); const third = f.create(); await third.tick(); third.enqueue(f.input);
    expect(f.db.connection.prepare("SELECT recognition_key,preview_key,confirmation_key FROM ingestion_automatic").get()).toEqual(keys);
    expect(f.hooks.recognize).toHaveBeenCalledTimes(1); expect(f.hooks.preview).toHaveBeenCalledTimes(1); expect(f.hooks.confirm).toHaveBeenCalledTimes(1);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
  });
  it.each(["WAITING", "MANUAL"] as const)("预览读取中转为 %s 时不确认；暂停恢复复用预览请求，失效保持人工", async (state) => {
    const f = await fixture(), worker = f.create(); worker.enqueue(f.input); await worker.tick();
    let release!: () => void, entered!: () => void; const wait = new Promise<void>((done) => { release = done; }), ready = new Promise<void>((done) => { entered = done; }), preview = f.hooks.preview;
    f.hooks.preview = vi.fn(async (...args) => { entered(); await wait; return preview(...args); });
    const flight = worker.tick(); await ready; f.state({ state, reason: "来源已暂停或版本变化" }); release(); await flight;
    expect(f.hooks.confirm).not.toHaveBeenCalled(); expect(worker.status(f.candidateId)).toMatchObject({ state: state === "WAITING" ? "PREVIEWING" : "NEEDS_REVIEW", reason: "来源已暂停或版本变化" });
    f.state({ state: "READY" }); await worker.tick();
    expect(f.hooks.confirm).toHaveBeenCalledTimes(state === "WAITING" ? 1 : 0); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_preview").get()).toEqual({ n: 1 });
  });
  it.each(["PREVIEWING", "CONFIRMING"])("%s 等待后被人工编辑，不继续旧自动选择或确认", async (state) => {
    const f = await fixture(), worker = f.create(); worker.enqueue(f.input); await worker.tick();
    const row = f.db.connection.prepare("SELECT task_id,preview_key FROM ingestion_automatic").get() as { task_id: string; preview_key: string }, selection = { tmdbId: 7, mediaType: "MOVIE" as const, season: null, episode: null, episodeEnd: null }, preview = await f.hooks.preview(row.task_id, row.preview_key, selection);
    f.db.connection.prepare("UPDATE ingestion_automatic SET state=?,selection_json=?,preview_id=?").run(state, JSON.stringify(selection), preview.id); f.tasks.get(row.task_id)!.revision = 1;
    await worker.tick(); expect(worker.status(f.candidateId)).toMatchObject({ state: "NEEDS_REVIEW", reason: expect.stringContaining("人工编辑") }); expect(f.hooks.preview).toHaveBeenCalledTimes(1); expect(f.hooks.confirm).not.toHaveBeenCalled();
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
  });
  it("确认事务提交后丢失返回仍读原操作收据，配置撤销后保留已提交计划", async () => {
    const f = await fixture(), worker = f.create(), confirm = f.hooks.confirm;
    f.hooks.confirm = vi.fn(async (...args) => { await confirm(...args); f.state({ state: "MANUAL", reason: "配置已变化" }); throw new Error("原始敏感异常不应持久化"); });
    worker.enqueue(f.input); await worker.tick(); await worker.tick();
    expect(worker.status(f.candidateId)).toMatchObject({ state: "SUBMITTED", reason: null, operationId: expect.any(String) });
    await worker.close(); const restored = f.create(); await restored.tick(); expect(f.hooks.confirm).toHaveBeenCalledTimes(1); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
  });
  it("确认等待期间撤销授权，事务前再次核对，不产生文件计划", async () => {
    const f = await fixture(), worker = f.create(); worker.enqueue(f.input); await worker.tick();
    f.hooks.confirm = vi.fn(async (_id, _key, check) => { f.state({ state: "MANUAL", reason: "自动授权已关闭" }); check(); return { operationId: randomUUID() }; });
    await worker.tick(); expect(worker.status(f.candidateId)).toMatchObject({ state: "NEEDS_REVIEW", reason: "自动授权已关闭" }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
  });
  it("未知预览错误只保存修复动作，失败不自行重试确认", async () => {
    const f = await fixture(), worker = f.create(); f.hooks.preview = vi.fn(async () => { throw new Error("private-cookie-fixture"); });
    worker.enqueue(f.input); await worker.tick(); await worker.tick(); await worker.tick();
    expect(worker.status(f.candidateId)).toMatchObject({ state: "NEEDS_REVIEW", reason: expect.stringContaining("待处理") }); expect(JSON.stringify(worker.status(f.candidateId))).not.toContain("private-cookie-fixture"); expect(f.hooks.preview).toHaveBeenCalledTimes(1); expect(f.hooks.confirm).not.toHaveBeenCalled();
  });
  it("等待来源不占满后续候选调度，未知完成规则保存人工原因而不识别", async () => {
    const f = await fixture(), worker = f.create();
    for (let index = 0; index < 11; index++) { const candidateId = index ? randomUUID() : f.candidateId; if (index) f.candidate(candidateId); worker.enqueue({ ...f.input, candidateId }); }
    f.state({ state: "WAITING", reason: "原磁盘未恢复" }); f.advance(10000); await worker.tick(); f.state({ state: "READY" }); f.advance(10000); await worker.tick();
    expect(f.hooks.recognize).toHaveBeenCalledTimes(10);
    const other = randomUUID(); f.candidate(other); f.state({ state: "MANUAL", reason: "客户端行为未经验证" }); worker.enqueue({ ...f.input, candidateId: other });
    expect(worker.status(other)).toMatchObject({ state: "NEEDS_REVIEW", reason: "客户端行为未经验证" });
  });
  it("关闭等待真实预览结束，迟到结果不确认，重启保留同一意图", async () => {
    const f = await fixture(), worker = f.create(); worker.enqueue(f.input); await worker.tick();
    let release!: () => void, entered!: () => void; const gate = new Promise<void>((done) => { release = done; }), ready = new Promise<void>((done) => { entered = done; }), preview = f.hooks.preview;
    f.hooks.preview = vi.fn(async (...args) => { entered(); await gate; return preview(...args); }); const flight = worker.tick(); await ready; const close = worker.close(); release(); await Promise.all([flight, close]);
    expect(f.hooks.confirm).not.toHaveBeenCalled(); expect(worker.status(f.candidateId)?.state).toBe("PREVIEWING");
    const restored = f.create(); await restored.tick(); expect(restored.status(f.candidateId)?.state).toBe("SUBMITTED"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_preview").get()).toEqual({ n: 1 });
  });
});
describe("自动识别选择", () => {
  it("沿用 80% 阈值，但作品歧义、父目录、人工字段和编辑版本均转人工", () => {
    const task = recognized(); expect(selectAutomaticWork(task)).toEqual({ selection: { tmdbId: 7, mediaType: "MOVIE", season: null, episode: null, episodeEnd: null } });
    for (const value of [{ ...task, revision: 1 }, { ...task, matchesStale: true }, { ...task, matches: [{ ...task.matches[0]!, confidence: 0.79 }] }, { ...task, matches: [{ ...task.matches[0]!, evidence: "parent" as const }] }, { ...task, matches: [{ ...task.matches[0]!, evidence: "manual" as const }] }, { ...task, matches: [...task.matches, { ...task.matches[0]!, tmdbId: 8, confidence: 0.8 }] }]) expect(selectAutomaticWork(value)).toHaveProperty("reason");
  });
  it("剧集只采用已通过的真实坐标；缺失或失败证据不能以高分替代", () => {
    const task = recognized(), tv = { ...task, matches: [{ ...task.matches[0]!, mediaType: "TV_SHOW" as const }] };
    expect(selectAutomaticWork(tv)).toHaveProperty("reason"); expect(selectAutomaticWork({ ...tv, matches: [{ ...tv.matches[0]!, episodeCheck: { state: "NEEDS_REVIEW", reason: "合并集缺集" } }] })).toEqual({ reason: "合并集缺集" });
    expect(selectAutomaticWork({ ...tv, matches: [{ ...tv.matches[0]!, episodeCheck: { state: "VALID", season: 0, episode: 26, episodeEnd: 28, seasonChanged: false } }] })).toEqual({ selection: { tmdbId: 7, mediaType: "TV_SHOW", season: 0, episode: 26, episodeEnd: 28 } });
  });
});
