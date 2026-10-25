import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApplication } from "@yeatz/app-framework/application";
import { createMediaApplication } from "./application";
import { CoreDatabase, SCHEMA_VERSION } from "../infrastructure/database";
import { DatabaseToken } from "../application/core-service";
import { RestrictedHostClient } from "@media-marshal/contracts/internal/rpc";
const directories: string[] = [];
const releaseGates: (() => void)[] = [];
const running: ReturnType<typeof createMediaApplication>[] = [];
const message = (action: string, payload: unknown = {}) => ({
  kind: "request",
  protocolVersion: 1,
  requestId: randomUUID(),
  action,
  payload,
});
async function create() {
  const directory = await mkdtemp(join(tmpdir(), "marshal-app-"));
  directories.push(directory);
  const runtime = createMediaApplication(join(directory, "app.sqlite3"));
  running.push(runtime);
  await runtime.app.start();
  return { runtime, directory };
}
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  vi.restoreAllMocks();
  await Promise.allSettled(running.splice(0).map((app) => app.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("框架组装与核心消息", () => {
  it.each(["TIMEOUT", "INTERRUPTED"] as const)("%s 收据结束请求等待，已落库草稿保留且同请求键不重复执行", async (reason) => {
    const { runtime } = await create(), db = runtime.app.container.get(DatabaseToken).connection;
    let release!: () => void, entered!: () => void; const gate = new Promise<void>((done) => { release = done; }), started = new Promise<void>((done) => { entered = done; }); releaseGates.push(release);
    const original = runtime.app.commands.executeWithOptions.bind(runtime.app.commands);
    const execute = vi.spyOn(runtime.app.commands, "executeWithOptions").mockImplementationOnce(async (...args) => { const result = await original(...args); entered(); await gate; return result; });
    const request = message("source-rules.configure", { id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: randomUUID(), configuration: { type: "local", name: "取消等待保留原草稿", client: "custom", sourcePath: "/fixture/input", organization: { targetPath: "/fixture/target" } } });
    const response = expect(runtime.dispatch(request)).rejects.toMatchObject({ code: reason }); await started;
    runtime.cancelRequest({ kind: "core.request.cancel", protocolVersion: 1, requestId: request.requestId, reason }); await response;
    expect(db.prepare("SELECT version,draft_revision FROM source_rule").get()).toEqual({ version: 0, draft_revision: 1 });
    await expect(runtime.dispatch(request)).rejects.toMatchObject({ code: "CONFLICT" }); expect(execute).toHaveBeenCalledTimes(1);
    release(); await expect.poll(async () => { try { return await runtime.dispatch(request); } catch { return null; } }).toMatchObject({ version: 0, draftRevision: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM source_rule_command").get()).toEqual({ n: 1 }); expect(db.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
    expect(() => runtime.cancelRequest({ kind: "core.request.cancel", protocolVersion: 1, requestId: request.requestId, reason, action: "shell.exec" })).toThrow();
  });
  it("Core 自己执行十五秒期限，停止等待后退出仍等原执行完成再关闭 SQLite", async () => {
    const { runtime } = await create(), db = runtime.app.container.get(DatabaseToken).connection;
    let release!: () => void, entered!: () => void; const gate = new Promise<void>((done) => { release = done; }), started = new Promise<void>((done) => { entered = done; }); releaseGates.push(release);
    const original = runtime.app.commands.executeWithOptions.bind(runtime.app.commands);
    vi.spyOn(runtime.app.commands, "executeWithOptions").mockImplementationOnce(async (...args) => { const result = await original(...args); entered(); await gate; expect(db.open).toBe(true); return result; });
    vi.useFakeTimers();
    try {
      const response = expect(runtime.dispatch(message("settings.save", { language: "en", embyUrl: "", tmdbProxy: "" }))).rejects.toMatchObject({ code: "TIMEOUT" }); await started;
      await vi.advanceTimersByTimeAsync(15000); await response; expect(JSON.parse((db.prepare("SELECT value FROM app_setting WHERE key='desktop.preferences'").get() as { value: string }).value)).toMatchObject({ language: "en" });
      let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false); expect(db.open).toBe(true);
      release(); await stopping; expect(db.open).toBe(false);
    } finally { release(); vi.useRealTimers(); }
  });
  it("唤醒观察重置只在私有通道开放，待确认候选重新观察而已处理记录保持", async () => {
    const { runtime } = await create(), db = runtime.app.container.get(DatabaseToken).connection;
    const source = randomUUID(), stamp = new Date().toISOString();
    db.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'唤醒测试','custom','/fixture/source','/fixture/target','MOVIE','COPY',?)").run(source, stamp);
    for (const state of ["READY", "UNAVAILABLE", "PROCESSED"])
      db.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,snapshot_json,state,created_at,updated_at) VALUES(?,?,'[\"sample.mp4\"]',?,'{}',?,?,?)").run(randomUUID(), source, randomUUID(), state, stamp, stamp);
    await runtime.dispatchPrivate({ kind: "core.private.request", requestId: randomUUID(), action: "media.observations.reset", payload: {} });
    expect(db.prepare("SELECT state FROM ingestion_candidate ORDER BY state").all()).toEqual([{ state: "OBSERVING" }, { state: "OBSERVING" }, { state: "PROCESSED" }]);
    await expect(runtime.dispatch(message("media.observations.reset"))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(db.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
  });
  it("启动部分失败先取消受跟踪的宿主等待，框架回滚不被 drain 阻塞", async () => {
    let online = true, sent = 0;
    const context = { coreGeneration: randomUUID(), hostGeneration: randomUUID(), bindingGeneration: randomUUID(), attemptId: randomUUID() };
    const client = new RestrictedHostClient(() => { sent++; }, () => online, 60000);
    let database!: CoreDatabase;
    const runtime = createMediaApplication(":memory:", [{
      id: "startup-wait-fixture", dependencies: ["media.commands"],
      async start(ctx) {
        database = ctx.get(DatabaseToken);
        void ctx.effects.run(() => client.request("transfer.status", { attemptId: context.attemptId }, context, randomUUID()), "启动等待夹具").catch(() => {});
        await expect.poll(() => sent).toBe(1);
        throw new Error("注入部分启动失败");
      },
    }], { cancelHostRequests: () => { online = false; client.invalidate(); } });
    running.push(runtime); await expect(runtime.app.start()).rejects.toThrow("注入部分启动失败");
    expect(online).toBe(false); expect(database.connection.open).toBe(false); expect(sent).toBe(1);
    await runtime.stop();
  });
  it("数据库尚在取得时停止，迟到资源立即归属清理且不启动后续服务", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marshal-start-stop-")); directories.push(directory);
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
    const open = CoreDatabase.open.bind(CoreDatabase), opening = vi.spyOn(CoreDatabase, "open").mockImplementationOnce(async (...args) => { await waiting; return open(...args); });
    const runtime = createMediaApplication(join(directory, "core.sqlite3")); running.push(runtime);
    const started = expect(runtime.app.start()).rejects.toMatchObject({ code: "INTERRUPTED" });
    await expect.poll(() => opening.mock.calls.length).toBe(1);
    const stopped = runtime.stop(); expect(runtime.stop()).toBe(stopped); release(); await started; await stopped;
    expect(runtime.app.state).toBe("stopped");
    const recovered = await CoreDatabase.open(join(directory, "core.sqlite3"), undefined, { exclusiveOwner: true });
    expect(recovered.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 }); recovered.close();
  });
  it("停止先取消真实宿主 RPC 等待，再排空命令与关闭数据库，不等待请求超时", async () => {
    let online = true, sent = 0;
    const coreGeneration = randomUUID(), hostGeneration = randomUUID();
    const client = new RestrictedHostClient(() => { sent++; }, () => online, 60000);
    const runtime = createMediaApplication(":memory:", [], {
      host: { context: (bindingGeneration, attemptId) => ({ coreGeneration, hostGeneration, bindingGeneration, attemptId }), request: (...args) => client.request(...args) },
      cancelHostRequests: () => { online = false; client.invalidate(); },
    }); running.push(runtime); await runtime.app.start();
    const privateMessage = (action: string, payload: unknown) => ({ kind: "core.private.request", requestId: randomUUID(), action, payload });
    const prepared = await runtime.dispatchPrivate(privateMessage("cloud.authorization.begin", { name: "停止测试", requestKey: randomUUID(), implementationId: "test.lifecycle" })) as { job: { id: string; accountId: string } };
    await runtime.dispatchPrivate(privateMessage("cloud.authorization.finish", { jobId: prepared.job.id, failure: null, capabilities: { authorizationMethods: ["cookie"], accountIdentity: "unavailable", objectIdentity: "path", reliableRevision: false, hashAlgorithms: [], rangeRead: "unknown", sourceKinds: ["webdav"] }, identityKey: null }));
    const db = runtime.app.container.get(DatabaseToken), root = db.connection.prepare("SELECT id FROM remote_entry WHERE parent_ref IS NULL").get() as { id: string };
    const response = expect(runtime.dispatch(message("cloud.remote.list", { accountId: prepared.job.accountId, parentRef: root.id }))).rejects.toMatchObject({ code: "INTERRUPTED" });
    await expect.poll(() => sent).toBe(1);
    const stopping = runtime.stop(); expect(runtime.stop()).toBe(stopping);
    await expect(runtime.dispatch(message("settings.get"))).rejects.toMatchObject({ code: "INTERRUPTED" });
    await response; await stopping; expect(sent).toBe(1); expect(db.connection.open).toBe(false);
  });
  it.each(["取消等待", "资源清理"])("%s失败仍释放其他资源，数据库在使用者之后关闭且失败可观察", async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "marshal-stop-failure-")); directories.push(directory);
    let database!: CoreDatabase, cleanupSawOpen = false;
    const runtime = createMediaApplication(join(directory, "core.sqlite3"), [{
      id: "cleanup-fixture", dependencies: ["media.commands"],
      start(ctx) { database = ctx.get(DatabaseToken); ctx.disposables.add(() => { cleanupSawOpen = database.connection.open; if (failure === "资源清理") throw new Error("清理失败夹具"); }); },
    }], { cancelHostRequests: () => { if (failure === "取消等待") throw new Error("取消失败夹具"); } });
    running.push(runtime); await runtime.app.start(); await expect(runtime.stop()).rejects.toBeInstanceOf(AggregateError);
    expect(cleanupSawOpen).toBe(true); expect(database.connection.open).toBe(false);
    const recovered = await CoreDatabase.open(join(directory, "core.sqlite3"), undefined, { exclusiveOwner: true }); recovered.close();
  });
  it.skipIf(!existsSync(resolve(`apps/desktop/resources/parser/${process.platform}-${process.arch}/manifest.json`)))("Core 启动并持有冻结解析器，资源异常时保留云端查询且不伪报解析就绪", async () => {
    const root = resolve(`apps/desktop/resources/parser/${process.platform}-${process.arch}`), manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    const healthy = createMediaApplication(":memory:", [], { parser: { root: join(root, "runtime"), manifest } }); running.push(healthy); await healthy.app.start();
    expect(await healthy.dispatch(message("runtime.get"))).toMatchObject({ parser: "ready" }); await healthy.stop();
    const broken = createMediaApplication(":memory:", [], { parser: { root: join(root, "missing-owned-runtime"), manifest } }); running.push(broken); await broken.app.start();
    expect(await broken.dispatch(message("runtime.get"))).toMatchObject({ parser: "unavailable" });
    expect(await broken.dispatch(message("cloud.accounts.list"))).toEqual([]);
  });
  it("两套 Application 的命令和 SQLite 数据独立", async () => {
    const first = await create(),
      second = await create();
    await first.runtime.dispatch(
      message("settings.save", { language: "en", embyUrl: "", tmdbProxy: "" }),
    );
    expect(
      await second.runtime.dispatch(message("settings.get")),
    ).toMatchObject({ language: "zh-CN" });
    expect(first.runtime.app.container).not.toBe(second.runtime.app.container);
    await first.runtime.stop();
    await expect(
      first.runtime.dispatch(message("runtime.get")),
    ).rejects.toMatchObject({ code: "INTERRUPTED" });
    expect(await second.runtime.dispatch(message("runtime.get"))).toMatchObject(
      { schemaVersion: SCHEMA_VERSION },
    );
  });
  it("通过真实目录保存 COPY 来源，重叠与符号链接绕过被阻止", async () => {
    const { runtime, directory } = await create();
    const source = join(directory, "source"),
      target = join(directory, "target");
    await mkdir(source);
    await mkdir(target);
    const draft = {
      name: "夸克电影",
      kind: "quark",
      sourcePath: source,
      targetPath: target,
      mediaType: "AUTO",
      operation: "COPY",
      automatic: false,
    };
    const saved = await runtime.dispatch(message("sources.save", draft));
    expect(saved).toMatchObject({
      ...draft,
      sourcePath: await realpath(source),
      targetPath: await realpath(target),
      version: 1,
    });
    expect(await runtime.dispatch(message("sources.list"))).toHaveLength(1);
    const link = join(directory, "alias");
    await symlink(source, link, process.platform==='win32'?'junction':'dir');
    await expect(
      runtime.dispatch(message("sources.save", { ...draft, sourcePath: link })),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(
      runtime.dispatch(
        message("sources.save", {
          ...draft,
          sourcePath: target,
          targetPath: target,
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });
  it("未知命令立即失败且设置不能用 URL 携带凭据", async () => {
    const { runtime } = await create();
    await expect(runtime.dispatch(message("shell.exec"))).rejects.toMatchObject(
      { code: "INVALID_REQUEST" },
    );
    await expect(
      runtime.dispatch(
        message("settings.save", {
          language: "zh-CN",
          embyUrl: "http://user:secret@localhost:8096",
          tmdbProxy: "",
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("下游启动失败清理已打开数据库，可用新实例重试", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marshal-fail-"));
    directories.push(directory);
    const path = join(directory, "app.sqlite3");
    const failed = createMediaApplication(path, [
      {
        id: "failed",
        dependencies: ["media.commands"],
        start() {
          throw new Error("注入启动失败");
        },
      },
    ]);
    await expect(failed.app.start()).rejects.toThrow("注入启动失败");
    expect(failed.app.state).toBe("failed");
    await expect(failed.app.start()).rejects.toThrow();
    const retried = createMediaApplication(path);
    running.push(retried);
    await retried.app.start();
    expect(await retried.dispatch(message("runtime.get"))).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
    });
  });
  it("缺少依赖与循环依赖不能启动", async () => {
    const missing = createApplication({
      modules: [{ id: "a", dependencies: ["missing"] }],
    });
    await expect(missing.start()).rejects.toThrow("缺少模块依赖");
    const circular = createApplication({
      modules: [
        { id: "a", dependencies: ["b"] },
        { id: "b", dependencies: ["a"] },
      ],
    });
    await expect(circular.start()).rejects.toThrow("模块循环依赖");
  });
});
