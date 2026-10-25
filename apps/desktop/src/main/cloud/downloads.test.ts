import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, readFile, mkdir, writeFile, readdir, rename, lstat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import type { watch } from "node:fs";
import type { AddressInfo } from "node:net";
import { CloudError, type DriveCapabilities } from "@media-marshal/contracts";
import type { CoreHostGateway } from "@media-marshal/contracts/internal/rpc";
import type { ExecutionHandle, HostEvent, PrivateTransferPlan, TransferEngine, TransferEvent } from "@media-marshal/contracts/internal";
import { CoreDatabase } from "../../../../../packages/media-core/src/infrastructure/database";
import { CloudAccounts } from "../../../../../packages/media-core/src/cloud/accounts";
import { RemoteCatalog } from "../../../../../packages/media-core/src/cloud/catalog";
import { CloudRoots } from "../../../../../packages/media-core/src/cloud/roots";
import { CloudDownloads } from "../../../../../packages/media-core/src/cloud/downloads";
import { IngestionOutbox } from "../../../../../packages/media-core/src/cloud/outbox";
import { CloudSubscriptions } from "../../../../../packages/media-core/src/cloud/subscriptions";
import { SourceRules } from "../../../../../packages/media-core/src/sources/rules";
import { IngestionPipeline } from "../../../../../packages/media-core/src/ingestion/pipeline";
import { MediaConnections } from "../../../../../packages/media-core/src/application/media-connections";
import { normalizeParse } from "../../../../../packages/media-core/src/domain/media";
import { SourceRoot } from "../../../../../packages/media-core/src/files/source-root";
import { DownloadCommits } from "../../../../../packages/media-core/src/cloud/commits";
import { probeManagedVolume } from "./volume-probe";
import { TestWebDavProvider } from "../../sidecar-host/testing/webdav-provider";
import { testWebDav } from "../../sidecar-host/testing/webdav";
import { SourceCredentialBroker } from "../../sidecar-host/source-credentials";
import { createSidecarApplication } from "../../sidecar-host/application";
import { SidecarBinaryResolver, lockedDefinitions, sidecarTarget } from "../../sidecar-host/binary-resolver";
import { guardianManifestSchema } from "../../sidecar-host/protocol";
import { ManagedGuardian } from "../../sidecar-host/guardian";
import { RcloneCliEngine } from "../../sidecar-host/rclone/engine";

class FileEngine implements TransferEngine {
  readonly implementationId = "test.files"; readonly supportedSourceKinds = ["webdav"] as const;
  starts = 0; stops = 0; holding = false; exitCode = 0; omit = false; maximumWriters = 0; afterWrite?: () => void; corrupt = false; private writers = 0;
  private records = new Map<string, { input: PrivateTransferPlan; stopped: boolean; release: () => void; wait: Promise<void> }>();
  constructor(readonly files: Map<string, Buffer>) {}
  release() { this.holding = false; for (const record of this.records.values()) record.release(); }
  async start(input: PrivateTransferPlan) {
    this.starts++; this.maximumWriters = Math.max(this.maximumWriters, ++this.writers);
    let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
    this.records.set(input.plan.attemptId, { input, stopped: false, release, wait });
    return { executionId: input.executionId!, attemptId: input.plan.attemptId, hostGeneration: input.context.hostGeneration };
  }
  async stop(handle: ExecutionHandle) { this.stops++; const record = this.records.get(handle.attemptId)!; record.stopped = true; await new Promise((resolve) => setTimeout(resolve, 50)); record.release(); return { stopped: true as const }; }
  async *events(handle: ExecutionHandle): AsyncIterable<TransferEvent> {
    const record = this.records.get(handle.attemptId)!;
    try {
      if (this.holding) await record.wait;
      if (!record.stopped && !this.omit) for (const item of record.input.plan.items) {
        const path = join(record.input.stagingDirectory, ...item.targetSegments); await mkdir(dirname(path), { recursive: true });
        const data = this.files.get(item.source.locator.kind === "path" ? item.source.locator.segments.join("/") : "")!;
        await writeFile(path, this.corrupt ? Buffer.alloc(data.length, 0) : data); this.afterWrite?.();
      }
      yield { type: "exited", exitCode: this.exitCode, stopped: record.stopped };
    } finally { this.writers--; }
  }
}
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });
async function fixture(input = new Map([["电影.txt", Buffer.from("完整测试文件")]]), native = false, now = Date.now) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "marshal-downloads-"))); cleanup.push(() => rm(path, { recursive: true, force: true }));
  const db = await CoreDatabase.open(join(path, "desktop.sqlite3")); cleanup.push(() => db.close());
  const roots = new CloudRoots(db); cleanup.push(() => roots.close());
  const rootPath = join(path, "download"); await mkdir(rootPath); const grant = await roots.authorize(await probeManagedVolume(rootPath));
  const broker = new SourceCredentialBroker(), server = await testWebDav(input), provider = new TestWebDavProvider(input, broker, server); cleanup.push(() => server.close());
  const accounts = new CloudAccounts(db), prepared = accounts.dispatch("cloud.authorization.begin", { name: "测试网盘", requestKey: randomUUID(), implementationId: provider.implementationId }), binding = prepared.candidate.binding;
  const coreGeneration = randomUUID(), hostGeneration = randomUUID(), fileEngine = new FileEngine(input);
  let engine: TransferEngine = fileEngine;
  if (native) {
    const target = sidecarTarget(process.platform, process.arch), resource = resolve("apps/desktop/resources/sidecars", target), manifest = guardianManifestSchema.parse(JSON.parse(await readFile(join(resource, "guardian.json"), "utf8")));
    const binaries = await new SidecarBinaryResolver(resource, target, lockedDefinitions(target, manifest.binary)).resolve(), guardian = new ManagedGuardian(path, binaries); await guardian.launch(); cleanup.push(() => guardian.shutdown());
    const actual = new RcloneCliEngine(guardian, broker, join(path, "configuration")); cleanup.push(() => actual.dispose()); engine = actual;
  }
  const listeners = new Set<(event: HostEvent) => void>();
  const sidecar = createSidecarApplication({ coreGeneration, hostGeneration, bindings: [binding], providers: [provider], engines: [engine], resolver: { resolve: async () => ({ openlist: "/unused", rclone: "/unused", guardian: "/unused" }) }, staging: (plan) => roots.files.get(plan.targetGrantId).prepareStage(plan.attemptId), publish: ({ context, handle, sequence, event }) => { const value: HostEvent = { kind: "host.event", protocolVersion: 1, context, executionId: handle.executionId, sequence, event }; for (const listener of listeners) listener(value); } });
  await sidecar.app.start(); cleanup.push(() => sidecar.stop());
  const host: CoreHostGateway = { context: (bindingGeneration, attemptId) => ({ coreGeneration, hostGeneration, bindingGeneration, attemptId }), async request(action, payload, context, idempotencyKey) {
    const response = await sidecar.dispatch({ kind: "host.request", protocolVersion: 1, requestId: randomUUID(), action, payload, context, idempotencyKey });
    if (!response.ok) throw new CloudError(response.error.code, response.error.retryAfterSeconds); return response.result as never;
  }, observe: (_handle, _context, listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  accounts.dispatch("cloud.authorization.finish", { jobId: prepared.job.id, failure: null, capabilities: await provider.capabilities(binding) as DriveCapabilities, identityKey: "a".repeat(64) });
  const catalog = new RemoteCatalog(db, host), account = catalog.accounts()[0]!, downloads = new CloudDownloads(db, host, catalog, roots, now); cleanup.push(() => downloads.close());
  const entries = (await catalog.list({ accountId: account.id, parentRef: account.rootRef! })).items;
  const subscriptions = new CloudSubscriptions(db, downloads, catalog, roots); cleanup.push(() => subscriptions.close());
  const preview = async (ref = entries[0]!.ref, options: { forceRedownload?: boolean; layout?: "selection" | "drive"; filters?: { extensions?: string[]; names?: string[] } } = {}) => {
    const requestKey = randomUUID(), initial = downloads.previews.start({ accountId: account.id, remoteRef: ref, targetGrantId: grant.id, requestKey, ...options });
    expect(initial.state).toBe("BUILDING"); await expect.poll(() => downloads.previews.get(requestKey)?.state).toBe("READY"); return downloads.previews.get(requestKey)!;
  };
  const confirm = async (ref?: string) => { const p = await preview(ref); return downloads.confirm({ previewId: p.id, requestKey: randomUUID() }); };
  const state = (jobId: string) => downloads.list({}).items.find((item) => item.id === jobId)!;
  return { accounts, path, db, roots, grant, rootPath, provider, fileEngine, sidecar, host, downloads, catalog, account, entries, preview, confirm, state, input, server, listeners, subscriptions };
}
describe.skipIf(process.platform !== "darwin")("统一来源与下载版本关联", () => {
  async function setup(input = new Map([["目录/电影.mp4", Buffer.from("真实测试文件")]])) {
    const f = await fixture(input);
    const connections = new MediaConnections(f.db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" })); cleanup.push(() => connections.close());
    const pipeline = new IngestionPipeline(f.db, () => undefined, connections); cleanup.push(() => pipeline.close());
    const rules = new SourceRules(f.db, f.downloads, f.subscriptions, pipeline); cleanup.push(() => rules.close());
    const configure = (periodic = false, row?: import("@media-marshal/contracts").SourceRule) => rules.configure({ id: row?.id ?? randomUUID(), expectedVersion: row?.version ?? 0, expectedDraftRevision: row?.draftRevision ?? 0, requestKey: randomUUID(), configuration: { type: "cloud", name: row ? "更新来源" : "只下载来源", accountId: f.account.id, remoteRef: f.account.rootRef!, downloadRootId: f.grant.id, periodic: { enabled: periodic, intervalSeconds: 900 }, organization: null } });
    const preview = async (row: import("@media-marshal/contracts").SourceRule) => {
      const p = rules.preview({ id: row.id, expectedVersion: row.version, expectedDraftRevision: row.draftRevision, requestKey: randomUUID() });
      await expect.poll(() => rules.getPreview(p.id)?.state).toBe("READY"); return rules.getPreview(p.id)!;
    };
    return { ...f, rules, configure, preview, pipeline, connections };
  }
  async function organized(f: Awaited<ReturnType<typeof setup>>, name: string, remoteRef: string, target: Awaited<ReturnType<typeof probeManagedVolume>> | null, extensions: string[] = []) {
    const draft = f.rules.configure({ id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: randomUUID(), configuration: { type: "cloud", name, accountId: f.account.id, remoteRef, downloadRootId: f.grant.id, filters: { extensions }, organization: target ? { targetPath: target.path, mediaType: "MOVIE" } : null } });
    const p = await f.preview(draft), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() }, target ? { source: f.grant, target } : undefined);
    return { p, source, job: await f.downloads.confirm({ previewId: p.download!.id, requestKey: randomUUID() }) };
  }
  it("删除废弃未提交执行和旧预览，恢复保持暂停且不会重放原意图", async () => {
    const f = await setup(), p = await f.preview(f.configure()), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() }, undefined);
    const execution = await f.rules.executions.start({ id: source.id, expectedVersion: 1, requestKey: randomUUID() });
    const run = f.rules.runs.enqueue({ id: source.id, expectedVersion: 1, requestKey: randomUUID() }), remove = { id: source.id, expectedVersion: 1, expectedDraftRevision: 1, expectedLifecycleRevision: 0, requestKey: randomUUID() };
    f.rules.lifecycle(remove, "remove"); expect(f.rules.runs.list({ sourceId: source.id }).items[0]).toMatchObject({ id: run.id, state: "ABANDONED" }); expect(f.rules.executions.get(execution.id)?.state).toBe("EXPIRED");
    f.rules.lifecycle({ ...remove, expectedLifecycleRevision: 1, requestKey: randomUUID() }, "restore"); expect(f.rules.get(source.id)).toMatchObject({ paused: true, lifecycleRevision: 2 });
    f.rules.control({ id: source.id, expectedVersion: 1, expectedLifecycleRevision: 2, operation: "resume", requestKey: randomUUID() });
    await expect(f.downloads.confirm({ previewId: p.download!.id, requestKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    await f.rules.runs.tick(); expect(f.downloads.list({}).total).toBe(0); expect(f.fileEngine.starts).toBe(0);
  });
  it("预算等待期间删除并恢复来源，旧确认仍被生命周期栅栏拒绝", async () => {
    const f = await setup(), p = await f.preview(f.configure()), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() });
    let entered!: () => void, release!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; }); cleanup.push(() => release());
    const budget = f.roots.budget.bind(f.roots), spy = vi.spyOn(f.roots, "budget").mockImplementationOnce(async (...args) => { const result = await budget(...args); entered(); await gate; return result; });
    const confirmation = f.downloads.confirm({ previewId: p.download!.id, requestKey: randomUUID() }); const rejected = expect(confirmation).rejects.toMatchObject({ code: "CONFLICT" }); await ready;
    const command = { id: source.id, expectedVersion: 1, expectedDraftRevision: 1, expectedLifecycleRevision: 0, requestKey: randomUUID() };
    f.rules.lifecycle(command, "remove"); f.rules.lifecycle({ ...command, expectedLifecycleRevision: 1, requestKey: randomUUID() }, "restore"); f.rules.control({ id: source.id, expectedVersion: 1, expectedLifecycleRevision: 2, operation: "resume", requestKey: randomUUID() }); release(); await rejected; spy.mockRestore();
    expect(f.downloads.list({}).total).toBe(0); expect(f.fileEngine.starts).toBe(0);
  });
  it("只保存和预览不创建下载，确认配置后的一次下载保存来源快照且不启用周期扫描", async () => {
    const f = await setup(), draft = f.configure(), p = await f.preview(draft);
    await expect(f.downloads.confirm({ previewId: p.download!.id, requestKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get()).toEqual({ n: 0 });
    const source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() }); expect(source).toMatchObject({ version: 1, subscriptionId: null, ingestionSourceId: null });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM cloud_subscription").get()).toEqual({ n: 0 });
    const command = { previewId: p.download!.id, requestKey: randomUUID() }, job = await f.downloads.confirm(command);
    expect(await f.downloads.confirm(command)).toEqual(job);
    expect(f.db.connection.prepare("SELECT * FROM download_source_demand").all()).toEqual([{ job_id: job.jobId, source_id: source.id, source_version: 1, review_required: 0 }]);
    expect(() => f.db.connection.prepare("UPDATE download_source_demand SET source_version=2").run()).toThrow(/不可修改/);
    const version = f.db.connection.prepare("SELECT configuration_json FROM source_rule_version WHERE source_id=? AND version=1").get(source.id);
    const nextDraft = f.configure(false, source), nextPreview = await f.preview(nextDraft);
    const next = await f.rules.apply({ previewId: nextPreview.id, requestKey: randomUUID() }); expect(next.version).toBe(2);
    expect(f.state(job.jobId).state).toBe("CANCELLED");
    expect(f.db.connection.prepare("SELECT configuration_json FROM source_rule_version WHERE source_id=? AND version=1").get(source.id)).toEqual(version);
    expect(f.db.connection.prepare("SELECT source_version FROM download_source_demand WHERE job_id=?").get(job.jobId)).toEqual({ source_version: 1 });
    await expect(f.downloads.confirm({ previewId: p.download!.id, requestKey: randomUUID() })).resolves.toEqual(job);
    expect(f.fileEngine.starts).toBe(0);
  });
  it("确认并执行一次在同一事务保存配置和意图，故障与重复确认不留下半次启用", async () => {
    const f = await setup(), draft = f.configure(), p = await f.preview(draft), command = { previewId: p.id, requestKey: randomUUID(), runOnce: true };
    f.db.connection.exec("CREATE TRIGGER atomic_run_fault BEFORE INSERT ON source_rule_run BEGIN SELECT RAISE(ABORT,'执行意图提交中断'); END");
    await expect(f.rules.apply(command)).rejects.toThrow(/执行意图提交中断/);
    expect(f.rules.get(draft.id)).toMatchObject({ version: 0, paused: true }); expect(f.rules.getPreview(p.id)?.state).toBe("READY");
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM source_rule_version").get()).toEqual({ n: 0 });
    f.db.connection.exec("DROP TRIGGER atomic_run_fault");
    const source = await f.rules.apply(command); expect(await f.rules.apply(command)).toEqual(source);
    expect(source).toMatchObject({ version: 1, subscriptionId: null, lastRun: { state: "QUEUED", sourceVersion: 1 } });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM source_rule_run").get()).toEqual({ n: 1 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get()).toEqual({ n: 0 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM cloud_subscription").get()).toEqual({ n: 0 });
  });
  it("强制重下先预览确认到独立目录，保留原成果且不改变周期来源策略", async () => {
    const f = await setup(), p = await f.preview(f.configure(true)), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() });
    f.subscriptions.start(); f.downloads.start();
    await expect.poll(() => f.downloads.list({}).items[0]?.state, { timeout: 10000 }).toBe("COMPLETED");
    const configuration = JSON.stringify(f.rules.get(source.id)?.configuration), originalPath = join(f.rootPath, "completed", "目录", "电影.mp4"), before = await readFile(originalPath);
    const command = { id: source.id, expectedVersion: 1, requestKey: randomUUID(), forceRedownload: true }, preview = f.rules.executions.start(command);
    expect(f.rules.executions.start(command).id).toBe(preview.id);
    await expect.poll(() => f.rules.executions.get(preview.id)?.state).toBe("READY");
    const ready = f.rules.executions.get(preview.id)!; expect(ready.download.forceRedownload).toBe(true); expect(ready.download.destinationPrefix).toBe(`completed/redownload-${ready.download.id}`);
    await expect(f.downloads.confirm({ previewId: ready.download.id, requestKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get()).toEqual({ n: 1 });
    const confirm = { previewId: preview.id, requestKey: randomUUID() }, run = f.rules.executions.confirm(confirm);
    expect(f.rules.executions.confirm(confirm).id).toBe(run.id); expect(run.forceRedownload).toBe(true);
    await f.rules.runs.tick(); const submitted = f.rules.runs.get(run.id)!;
    await expect.poll(() => f.state(submitted.jobId!).state, { timeout: 10000 }).toBe("COMPLETED");
    expect(await readFile(originalPath)).toEqual(before); expect(await readFile(join(f.rootPath, ready.download.destinationPrefix, "目录", "电影.mp4"))).toEqual(before);
    expect(JSON.stringify(f.rules.get(source.id)?.configuration)).toBe(configuration); expect(f.rules.get(source.id)?.version).toBe(1);
    expect(f.db.connection.prepare("SELECT enabled FROM cloud_subscription WHERE id=?").get(source.subscriptionId)).toEqual({ enabled: 1 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM source_rule_run").get()).toEqual({ n: 1 });
  });
  it("执行预览在暂停或版本变化后失效，确认事务失败可安全重试", async () => {
    const f = await setup(), draft = f.configure();
    expect(() => f.rules.executions.start({ id: draft.id, expectedVersion: 0, requestKey: randomUUID() })).toThrow();
    const p = await f.preview(draft), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() });
    const preview = f.rules.executions.start({ id: source.id, expectedVersion: 1, requestKey: randomUUID(), forceRedownload: true });
    await expect.poll(() => f.rules.executions.get(preview.id)?.state).toBe("READY");
    f.rules.control({ id: source.id, expectedVersion: 1, operation: "pause", requestKey: randomUUID() });
    f.rules.control({ id: source.id, expectedVersion: 1, operation: "resume", requestKey: randomUUID() });
    expect(f.rules.executions.get(preview.id)?.state).toBe("EXPIRED"); expect(() => f.rules.executions.confirm({ previewId: preview.id, requestKey: randomUUID() })).toThrow();
    const next = f.rules.executions.start({ id: source.id, expectedVersion: 1, requestKey: randomUUID(), forceRedownload: true }); await expect.poll(() => f.rules.executions.get(next.id)?.state).toBe("READY");
    const confirm = { previewId: next.id, requestKey: randomUUID() };
    f.db.connection.exec("CREATE TRIGGER execution_confirmation_fault BEFORE INSERT ON source_rule_execution_confirmation BEGIN SELECT RAISE(ABORT,'确认事务中断'); END");
    expect(() => f.rules.executions.confirm(confirm)).toThrow(/确认事务中断/);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM source_rule_run").get()).toEqual({ n: 0 }); expect(f.rules.executions.get(next.id)?.state).toBe("READY");
    f.db.connection.exec("DROP TRIGGER execution_confirmation_fault"); const run = f.rules.executions.confirm(confirm); expect(f.rules.executions.confirm(confirm).id).toBe(run.id);
    const old = f.rules.executions.start({ id: source.id, expectedVersion: 1, requestKey: randomUUID() }); await expect.poll(() => f.rules.executions.get(old.id)?.state).toBe("READY");
    const changed = f.configure(false, source), changedPreview = await f.preview(changed); await f.rules.apply({ previewId: changedPreview.id, requestKey: randomUUID() });
    expect(f.rules.executions.get(old.id)?.state).toBe("EXPIRED"); expect(() => f.rules.executions.confirm({ previewId: old.id, requestKey: confirm.requestKey })).toThrow();
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get()).toEqual({ n: 0 }); expect(f.fileEngine.starts).toBe(0);
  });
  it("来源与订阅原子启用，配置事务失败保留原扫描、范围与版本", async () => {
    const f = await setup(), row = f.configure(true), p = await f.preview(row);
    const first = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() }); expect(first.subscriptionId).toBeTruthy();
    const old = f.db.connection.prepare("SELECT * FROM cloud_subscription").get(), scans = f.db.connection.prepare("SELECT id,state FROM cloud_scan").all();
    const next = f.configure(true, first), np = await f.preview(next), command = { previewId: np.id, requestKey: randomUUID() };
    f.db.connection.exec("CREATE TRIGGER source_atomic_failure BEFORE INSERT ON source_rule_version WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'来源版本提交失败'); END");
    await expect(f.rules.apply(command)).rejects.toThrow(/来源版本提交失败/);
    expect(f.db.connection.prepare("SELECT * FROM cloud_subscription").get()).toEqual(old); expect(f.db.connection.prepare("SELECT id,state FROM cloud_scan").all()).toEqual(scans);
    expect(f.rules.get(first.id)).toMatchObject({ version: 1, draftRevision: 2, configuration: { name: "只下载来源" } });
    expect(f.rules.getPreview(np.id)?.state).toBe("READY");
    f.db.connection.exec("DROP TRIGGER source_atomic_failure"); await f.rules.apply(command);
    expect(f.rules.get(first.id)).toMatchObject({ version: 2, subscriptionId: first.subscriptionId });
    expect(() => f.subscriptions.configure({ subscriptionId: first.subscriptionId!, configurationVersion: 2, previewId: np.download!.id, intervalSeconds: 900, requestKey: randomUUID() })).toThrow();
  });
  it("周期调度生成的需求沿用来源版本，凭据不进入配置快照", async () => {
    const f = await setup(), draft = f.configure(true), p = await f.preview(draft), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() });
    f.subscriptions.start();
    await expect.poll(() => (f.db.connection.prepare("SELECT count(*) AS n FROM download_source_demand").get() as { n: number }).n).toBe(1);
    expect(f.db.connection.prepare("SELECT source_id,source_version FROM download_source_demand").get()).toEqual({ source_id: source.id, source_version: 1 });
    expect(JSON.stringify(f.db.connection.prepare("SELECT * FROM source_rule_version").all())).not.toMatch(/credential|cookie|password|WebDAV/i);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM desktop_source").get()).toEqual({ n: 0 });
    expect(f.fileEngine.starts).toBe(0);
    const job = f.db.connection.prepare("SELECT id FROM download_job").get() as { id: string };
    f.downloads.control({ jobId: job.id, operation: "cancel", requestKey: randomUUID() });
    expect(f.rules.get(source.id)).toMatchObject({ paused: false, configuration: { periodic: { enabled: true } } });
    expect(f.db.connection.prepare("SELECT enabled FROM cloud_subscription WHERE id=?").get(source.subscriptionId)).toEqual({ enabled: 1 });
  });
  it("迁入的未确认订阅重新预览后复用原身份，不生成第二个订阅或历史作业", async () => {
    const f = await setup();
    const original = await f.preview(f.configure());
    // 独立旧入口曾留下未确认的订阅，迁移将其保留为同 ID 草稿。
    const oldId = randomUUID(), stamp = new Date().toISOString();
    f.db.connection.prepare("INSERT INTO cloud_subscription(id,account_id,remote_root_ref,target_root_id,filters_json,interval_seconds,enabled,configuration_version,created_at,updated_at) VALUES(?,?,?,?,'{\"extensions\":[],\"names\":[]}',900,0,3,?,?)").run(oldId, f.account.id, f.account.rootRef, f.grant.id, stamp, stamp);
    f.db.connection.prepare("INSERT INTO cloud_subscription_runtime(subscription_id,state) VALUES(?,'PAUSED')").run(oldId);
    const row = f.rules.configure({ id: oldId, expectedVersion: 0, expectedDraftRevision: 0, requestKey: randomUUID(), configuration: original.configuration });
    f.db.connection.prepare("INSERT INTO source_rule_legacy_reference VALUES('subscription',?,?,'REVIEW_REQUIRED','UNCONFIRMED')").run(oldId, oldId);
    const p = await f.preview(row), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() });
    expect(source).toMatchObject({ id: oldId, version: 1, subscriptionId: oldId, configuration: { periodic: { enabled: false } } });
    expect(f.db.connection.prepare("SELECT id,enabled,configuration_version FROM cloud_subscription").all()).toEqual([{ id: oldId, enabled: 0, configuration_version: 4 }]);
    expect(f.rules.resolveLegacy({ kind: "subscription", id: oldId })).toMatchObject({ sourceId: oldId, status: "MAPPED", reason: "NONE" });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get()).toEqual({ n: 0 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM cloud_scan").get()).toEqual({ n: 0 });
  });
  it("执行一次持久合并重复意图，未确认或暂停不执行，单项取消不更改来源策略", async () => {
    const f = await setup(), draft = f.configure();
    expect(() => f.rules.runs.enqueue({ id: draft.id, expectedVersion: 0, requestKey: randomUUID() })).toThrow();
    const p = await f.preview(draft), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() });
    const command = { id: source.id, expectedVersion: 1, requestKey: randomUUID() }, run = f.rules.runs.enqueue(command);
    expect(f.rules.runs.enqueue(command).id).toBe(run.id); expect(f.rules.runs.enqueue({ ...command, requestKey: randomUUID() }).id).toBe(run.id);
    f.rules.control({ ...command, requestKey: randomUUID(), operation: "pause" }); await f.rules.runs.tick();
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get()).toEqual({ n: 0 });
    expect(() => f.rules.runs.enqueue({ ...command, requestKey: randomUUID() })).toThrow();
    f.rules.control({ ...command, requestKey: randomUUID(), operation: "resume" });
    await expect.poll(async () => { await f.rules.runs.tick(); return f.rules.runs.list({ sourceId: source.id }).items[0]?.state; }).toBe("SUBMITTED");
    const result = f.rules.runs.enqueue(command); expect(result.jobId).toBeTruthy();
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get()).toEqual({ n: 1 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM cloud_subscription").get()).toEqual({ n: 0 });
    expect(f.db.connection.prepare("SELECT source_id,source_version FROM download_source_demand").get()).toEqual({ source_id: source.id, source_version: 1 });
    f.downloads.control({ jobId: result.jobId!, operation: "cancel", requestKey: randomUUID() });
    expect(f.rules.get(source.id)).toMatchObject({ paused: false, configuration: { periodic: { enabled: false } } });
    expect(f.fileEngine.starts).toBe(0);
  });
  it("确认下载后尚未更新执行收据的重启复用原作业，旧请求不再确认", async () => {
    const f = await setup(), p = await f.preview(f.configure()), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() });
    const command = { id: source.id, expectedVersion: 1, requestKey: randomUUID() }, run = f.rules.runs.enqueue(command);
    await f.rules.runs.tick();
    const row = f.db.connection.prepare("SELECT preview_id,preview_key FROM source_rule_run WHERE id=?").get(run.id) as { preview_id: string; preview_key: string };
    await expect.poll(() => f.downloads.previews.get(row.preview_key)?.state).toBe("READY");
    const job = await f.downloads.confirm({ previewId: row.preview_id, requestKey: run.id }, { sourceId: source.id, sourceVersion: 1, runId: run.id });
    await f.rules.close();
    const resumed = new SourceRules(f.db, f.downloads, f.subscriptions, f.pipeline); cleanup.push(() => resumed.close());
    await resumed.runs.tick();
    expect(resumed.runs.enqueue(command)).toMatchObject({ id: run.id, state: "SUBMITTED", jobId: job.jobId });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get()).toEqual({ n: 1 });
  });
  it("执行枚举中断后重建预览，配置变更废弃旧意图且不下载旧范围", async () => {
    const f = await setup(), p = await f.preview(f.configure()), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() });
    const command = { id: source.id, expectedVersion: 1, requestKey: randomUUID() }, run = f.rules.runs.enqueue(command);
    await f.rules.runs.tick();
    const first = f.db.connection.prepare("SELECT preview_id,preview_key FROM source_rule_run WHERE id=?").get(run.id) as { preview_id: string; preview_key: string };
    await expect.poll(() => f.downloads.previews.get(first.preview_key)?.state).toBe("READY");
    f.downloads.previews.cancel(first.preview_id); await f.rules.close();
    const resumed = new SourceRules(f.db, f.downloads, f.subscriptions, f.pipeline); cleanup.push(() => resumed.close());
    await resumed.runs.tick();
    const next = f.db.connection.prepare("SELECT preview_id FROM source_rule_run WHERE id=?").get(run.id) as { preview_id: string };
    expect(next.preview_id).not.toBe(first.preview_id);
    const draft = resumed.configure({ id: source.id, expectedVersion: 1, expectedDraftRevision: source.draftRevision, requestKey: randomUUID(), configuration: { ...source.configuration!, name: "新版本" } });
    const preview = resumed.preview({ id: source.id, expectedVersion: 1, expectedDraftRevision: draft.draftRevision, requestKey: randomUUID() });
    await expect.poll(() => resumed.getPreview(preview.id)?.state).toBe("READY"); await resumed.apply({ previewId: preview.id, requestKey: randomUUID() });
    await resumed.runs.tick(); expect(resumed.runs.enqueue(command)).toMatchObject({ id: run.id, state: "ABANDONED", jobId: null });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get()).toEqual({ n: 0 });
  });
  it("暂停一个来源保留其他来源的共享写入，恢复来源不解除全局下载暂停", async () => {
    const f = await setup(), firstPreview = await f.preview(f.configure()), first = await f.rules.apply({ previewId: firstPreview.id, requestKey: randomUUID() });
    const secondPreview = await f.preview(f.configure()), second = await f.rules.apply({ previewId: secondPreview.id, requestKey: randomUUID() });
    const a = await f.downloads.confirm({ previewId: firstPreview.download!.id, requestKey: randomUUID() }), b = await f.downloads.confirm({ previewId: secondPreview.download!.id, requestKey: randomUUID() });
    f.fileEngine.holding = true; f.downloads.start(); await expect.poll(() => f.fileEngine.starts).toBe(1);
    const pause = { id: first.id, expectedVersion: 1, requestKey: randomUUID(), operation: "pause" as const }; f.rules.control(pause);
    expect(f.state(a.jobId).state).toBe("PAUSED"); expect(f.fileEngine.stops).toBe(0); expect(f.state(b.jobId).state).toBe("RUNNING");
    await expect(f.downloads.confirm({ previewId: firstPreview.download!.id, requestKey: randomUUID() })).resolves.toEqual(a);
    f.downloads.setPaused({ paused: true, requestKey: randomUUID() }); await expect.poll(() => f.downloads.pauseStatus().pausing).toBe(false);
    f.rules.control({ ...pause, operation: "resume", requestKey: randomUUID() });
    expect(f.downloads.pauseStatus().paused).toBe(true); expect(f.state(a.jobId).state).toBe("PAUSED");
    // 用户单独暂停第二个任务后，全局恢复只能恢复第一个任务。
    f.downloads.control({ jobId: b.jobId, operation: "pause", requestKey: randomUUID() });
    f.downloads.setPaused({ paused: false, requestKey: randomUUID() });
    expect(f.state(b.jobId).state).toBe("PAUSED"); await expect.poll(() => f.fileEngine.starts).toBe(2);
    expect(f.rules.get(second.id)?.paused).toBe(false); f.fileEngine.release(); await expect.poll(() => f.state(a.jobId).state).toBe("COMPLETED");
  });
  it("全局先暂停、来源后暂停时，全局恢复保持来源停止且来源恢复可继续原需求", async () => {
    const f = await setup(), p = await f.preview(f.configure()), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() });
    const job = await f.downloads.confirm({ previewId: p.download!.id, requestKey: randomUUID() });
    f.downloads.setPaused({ paused: true, requestKey: randomUUID() });
    f.rules.control({ id: source.id, expectedVersion: 1, operation: "pause", requestKey: randomUUID() });
    f.downloads.setPaused({ paused: false, requestKey: randomUUID() });
    expect(f.state(job.jobId).state).toBe("PAUSED");
    expect(() => f.downloads.control({ jobId: job.jobId, operation: "resume", requestKey: randomUUID() })).toThrow();
    f.rules.control({ id: source.id, expectedVersion: 1, operation: "resume", requestKey: randomUUID() });
    expect(f.state(job.jobId).state).toBe("QUEUED"); expect(f.rules.get(source.id)?.configuration).toEqual(source.configuration);
  });
  it("来源暂停跨调度器重建保留，退出期间漏过周期合并且立即扫描不重复", async () => {
    const f = await setup(), p = await f.preview(f.configure(true)), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() });
    f.rules.control({ id: source.id, expectedVersion: 1, operation: "pause", requestKey: randomUUID() });
    expect(() => f.subscriptions.control({ subscriptionId: source.subscriptionId!, operation: "resume", requestKey: randomUUID() })).toThrow();
    await f.rules.close(); await f.subscriptions.close();
    const subscriptions = new CloudSubscriptions(f.db, f.downloads, f.catalog, f.roots); cleanup.push(() => subscriptions.close());
    const rules = new SourceRules(f.db, f.downloads, subscriptions, f.pipeline); cleanup.push(() => rules.close());
    rules.start(); subscriptions.start(); await new Promise((done) => setTimeout(done, 600));
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM cloud_scan WHERE state='SCANNING'").get()).toEqual({ n: 0 });
    expect(rules.get(source.id)?.paused).toBe(true);
    rules.control({ id: source.id, expectedVersion: 1, operation: "resume", requestKey: randomUUID() });
    await expect.poll(() => (f.db.connection.prepare("SELECT count(*) AS n FROM cloud_scan WHERE state='SCANNING'").get() as { n: number }).n, { timeout: 5000 }).toBe(1);
    const scan = { id: source.id, expectedVersion: 1, operation: "scan" as const, requestKey: randomUUID() };
    rules.control(scan); rules.control(scan); rules.control({ ...scan, requestKey: randomUUID() });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM cloud_scan WHERE state='SCANNING'").get()).toEqual({ n: 1 });
    // 枚举和确认需要跨多个 500ms 调度周期，等待完整记账，避免全量并发检查中的瞬时状态。
    await expect.poll(() => ({ jobs: (f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get() as { n: number }).n, complete: (f.db.connection.prepare("SELECT count(*) AS n FROM cloud_scan WHERE state='COMPLETE'").get() as { n: number }).n }), { timeout: 5000 }).toEqual({ jobs: 1, complete: 1 });
  });
  it("共享目录的手动扫描摘要仅包含本来源有效需求，其他来源的权限问题不会误归属", async () => {
    const f = await setup(new Map([["甲/电影.mp4", Buffer.from("甲内容")], ["乙/电影.mp4", Buffer.from("乙内容")]])), targetPath = join(f.path, "共享扫描目标"); await mkdir(targetPath); const target = await probeManagedVolume(targetPath);
    const first = await organized(f, "甲来源", f.entries.find((entry) => entry.name === "甲")!.ref, target), second = await organized(f, "乙来源", f.entries.find((entry) => entry.name === "乙")!.ref, target);
    f.downloads.start(); await expect.poll(() => [first, second].map((row) => f.state(row.job.jobId).state), { timeout: 10000 }).toEqual(["COMPLETED", "COMPLETED"]);
    const row = f.db.connection.prepare("SELECT i.target_segments_json FROM download_item i JOIN download_job_item ji ON ji.item_id=i.id WHERE ji.job_id=?").get(second.job.jobId) as { target_segments_json: string }, denied = join(f.rootPath, "completed", ...JSON.parse(row.target_segments_json)); await chmod(denied, 0o000);
    try {
      const a = f.rules.scans.enqueue({ sourceId: first.source.id, requestKey: randomUUID() }); await f.rules.scans.idle(); expect(f.rules.scans.get({ id: a.id })).toMatchObject({ job: { state: "COMPLETED", discovered: 1, failed: 0 }, issues: [] });
      const b = f.rules.scans.enqueue({ sourceId: second.source.id, requestKey: randomUUID() }); await f.rules.scans.idle(); expect(f.rules.scans.get({ id: b.id })).toMatchObject({ job: { state: "PARTIAL_FAILED", discovered: 0, failed: 1 }, issues: [{ relativePath: expect.stringContaining("乙") }] });
      expect(f.pipeline.list({}).items.filter((item) => item.relativePath.includes("甲"))).toHaveLength(1); expect(f.pipeline.list({}).total).toBeLessThanOrEqual(2); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
    } finally { await chmod(denied, 0o600); }
  });
  it("共享根按需求区分只下载与整理，相同策略和 outbox 重投及补扫复用唯一候选", async () => {
    const f = await setup(new Map([["整理/电影.mp4", Buffer.from("整理内容")], ["仅下载/电影.mp4", Buffer.from("仅下载内容")]]));
    const targetPath = join(f.path, "目标"); await mkdir(targetPath); const target = await probeManagedVolume(targetPath);
    const selected = f.entries.find((entry) => entry.name === "整理")!, downloadOnly = f.entries.find((entry) => entry.name === "仅下载")!;
    const first = await organized(f, "整理来源一", selected.ref, target), second = await organized(f, "只下载来源", downloadOnly.ref, null), shared = await organized(f, "整理来源二", selected.ref, target);
    f.downloads.start(); await expect.poll(() => [first, second, shared].map((row) => f.state(row.job.jobId).state), { timeout: 10000 }).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(f.fileEngine.starts).toBe(2);
    const outbox = new IngestionOutbox(f.db, f.roots, f.pipeline); cleanup.push(() => outbox.close());
    f.db.connection.exec("CREATE TRIGGER organization_ack_fault BEFORE UPDATE OF state ON ingestion_outbox WHEN NEW.state='ACKNOWLEDGED' BEGIN SELECT RAISE(ABORT,'确认中断'); END");
    await outbox.deliver(); expect(f.pipeline.list({}).total).toBe(1);
    f.db.connection.exec("DROP TRIGGER organization_ack_fault; UPDATE ingestion_outbox SET next_attempt_at=NULL"); await outbox.deliver();
    await writeFile(join(f.rootPath, "completed", "未登记.mp4"), "外部文件");
    await f.pipeline.scan(first.source.ingestionSourceId!); await outbox.deliver();
    expect(f.pipeline.list({}).total).toBe(1); expect(f.rules.list().map((row) => row.type)).toEqual(["cloud", "cloud", "cloud"]);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_source WHERE mode='local'").get()).toEqual({ n: 0 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_candidate_policy").get()).toEqual({ n: 1 });
    expect(() => f.db.connection.prepare("UPDATE ingestion_candidate_policy SET policy_key=?").run("0".repeat(64))).toThrow(/不可修改/);
    expect(f.state(second.job.jobId).ingestion).toMatchObject({ organization: "NOT_ENABLED", pending: 0, candidates: 0 });
    expect(f.db.connection.prepare("SELECT delivery_attempts,state FROM ingestion_outbox WHERE item_id IN (SELECT item_id FROM download_job_item WHERE job_id=?)").get(second.job.jobId)).toEqual({ delivery_attempts: 0, state: "PENDING" });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
  });
  it("整理冲突预览指出来源，同根不相交范围使用不同目标且缺一个目标仍能恢复来源", async () => {
    const f = await setup(new Map([["甲/电影.mp4", Buffer.from("甲内容")], ["乙/电影.mp4", Buffer.from("乙内容")]]));
    const x = join(f.path, "目标甲"), y = join(f.path, "目标乙"); await mkdir(x); await mkdir(y);
    const gx = await probeManagedVolume(x), gy = await probeManagedVolume(y), first = await organized(f, "甲来源", f.entries.find((entry) => entry.name === "甲")!.ref, gx);
    const conflicting = f.rules.configure({ id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: randomUUID(), configuration: { type: "cloud", name: "重叠来源", accountId: f.account.id, remoteRef: f.account.rootRef!, downloadRootId: f.grant.id, organization: { targetPath: y, mediaType: "MOVIE" } } });
    const p = f.rules.preview({ id: conflicting.id, expectedVersion: 0, expectedDraftRevision: 1, requestKey: randomUUID() });
    expect(p).toMatchObject({ state: "FAILED", organizationConflicts: [{ sourceId: first.source.id, name: "甲来源" }] });
    await expect(f.rules.apply({ previewId: p.id, requestKey: randomUUID() }, { source: f.grant, target: gy })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readdir(y)).toEqual([]);
    const second = await organized(f, "乙来源", f.entries.find((entry) => entry.name === "乙")!.ref, gy);
    expect(first.source.ingestionSourceId).toBe(second.source.ingestionSourceId);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_source").get()).toEqual({ n: 1 });
    expect(f.db.connection.prepare("SELECT version FROM desktop_source").get()).toEqual({ version: 1 });
    const bootstrap = f.pipeline.bootstrap()[0]!; await f.pipeline.close();
    const restored = new IngestionPipeline(f.db, () => undefined, f.connections); cleanup.push(() => restored.close());
    await rename(x, x + ".offline"); await expect(restored.authorizeTarget(gx)).rejects.toThrow(); await restored.authorizeTarget(gy);
    await restored.authorizeManagedSource({ sourceId: bootstrap.sourceId, sourceVersion: bootstrap.sourceVersion, source: bootstrap.source });
    expect(restored.libraries()).toEqual(expect.arrayContaining([{ targetId: gy.id, path: y, available: true, mediaType: "MOVIE" }, { targetId: gx.id, path: x, available: false, mediaType: "MOVIE" }]));
  });
  it.each(["其他策略", "本策略", "相同目标的其他来源", "删除其他策略", "删除共享需求"])("共享根字幕复制中控制%s，只影响所属需求并重新计算恢复观察", async (scope) => {
    const subtitle = Buffer.from("乙字幕".repeat(10)), f = await setup(new Map([["目录/甲.mkv", Buffer.from("甲视频")], ["目录/甲.zh.srt", Buffer.from("甲字幕")], ["目录/乙.mp4", Buffer.from("乙视频")], ["目录/乙.zh.ass", subtitle]]));
    const x = join(f.path, "媒体甲"), y = join(f.path, "媒体乙"); await mkdir(x); await mkdir(y); const gx = await probeManagedVolume(x), gy = scope === "相同目标的其他来源" ? gx : await probeManagedVolume(y);
    const first = await organized(f, "策略甲", f.account.rootRef!, gx, ["mkv", "srt"]), second = await organized(f, "策略乙", f.account.rootRef!, gy, ["mp4", "ass"]);
    if (scope === "删除共享需求") await organized(f, "共享乙策略", f.account.rootRef!, gy, ["mp4", "ass"]);
    f.downloads.start(); await expect.poll(() => [first, second].map((row) => f.state(row.job.jobId).state), { timeout: 10000 }).toEqual(["COMPLETED", "COMPLETED"]);
    // 先等待下载执行收尾，稳定观察从已静止的文件开始，避免依赖后台调度速度。
    await f.downloads.close();
    const bootstrap = f.pipeline.bootstrap()[0]!; await f.pipeline.close();
    const server = createServer((request, response) => { response.setHeader("Content-Type", "application/json"); const movie = { id: 1, title: "测试电影", original_title: "Test Movie", release_date: "2026-01-01" }; response.end(JSON.stringify(request.url!.startsWith("/search/") ? { results: [movie] } : movie)); });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); cleanup.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
    const connections = new MediaConnections(f.db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" }), { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }); cleanup.push(() => connections.close()); connections.install({ tmdb: "fixture", emby: null });
    let wall = Date.now(), monotonic = 0; const parser = { ready: true, parse: async (name: string) => normalizeParse({ title: "测试电影", year: 2026, type: "movie" }, name) };
    // 此用例验证策略归属与取消，两个稳定观察时钟均逐次推进；真实监听和墙上时钟不能与模拟单调时钟混用。
    const controlledWatch = (() => Object.assign(new EventEmitter(), { close() {} })) as unknown as typeof watch;
    const pipeline = new IngestionPipeline(f.db, () => parser, connections, () => wall, () => monotonic, controlledWatch); cleanup.push(() => pipeline.close());
    const rules = new SourceRules(f.db, f.downloads, f.subscriptions, pipeline); cleanup.push(() => rules.close());
    await pipeline.authorizeTarget(gx); await pipeline.authorizeTarget(gy); await pipeline.authorizeManagedSource({ sourceId: bootstrap.sourceId, sourceVersion: bootstrap.sourceVersion, source: bootstrap.source });
    await pipeline.scan(bootstrap.sourceId); for (let i = 0; i < 12; i++) { wall += 10000; monotonic += 10000; await pipeline.scan(bootstrap.sourceId); }
    const candidate = pipeline.list({}).items.find((row) => row.relativePath.endsWith("乙.mp4"))!, task = await pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await pipeline.tick();
    if (scope === "相同目标的其他来源") rules.control({ id: first.source.id, expectedVersion: 1, operation: "pause", requestKey: randomUUID() });
    const preview = await pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" } }); expect(preview.accessories).toHaveLength(1);
    let release!: () => void, entered!: () => void, held = false, active!: AbortSignal; const gate = new Promise<void>((done) => { release = done; }), ready = new Promise<void>((done) => { entered = done; }), digest = SourceRoot.prototype.digest; cleanup.push(() => release());
    const spy = vi.spyOn(SourceRoot.prototype, "digest").mockImplementation(function (this: SourceRoot, handle, size, signal, consume) { return digest.call(this, handle, size, signal, consume && (async (bytes) => { await consume(bytes); if (!held && bytes.equals(subtitle)) { held = true; active = signal; entered(); await gate; } })); });
    await pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await ready; const inode = (await lstat(preview.targetPath)).ino, source = scope === "本策略" || scope === "删除共享需求" ? second.source : first.source;
    if (scope.startsWith("删除")) rules.lifecycle({ id: source.id, expectedVersion: 1, expectedDraftRevision: 1, expectedLifecycleRevision: 0, requestKey: randomUUID() }, "remove");
    else rules.control({ id: source.id, expectedVersion: 1, operation: "pause", requestKey: randomUUID() }); expect(active.aborted).toBe(scope === "本策略"); release(); await pipeline.tick(); spy.mockRestore();
    expect(pipeline.task(task.taskId).state).toBe("DONE"); expect((await lstat(preview.targetPath)).ino).toBe(inode);
    if (scope === "本策略") {
      expect(pipeline.task(task.taskId).accessories![0]).toMatchObject({ state: "COPYING", failure: null });
      const scans = vi.spyOn(pipeline, "scan"); rules.control({ id: source.id, expectedVersion: 1, operation: "resume", requestKey: randomUUID() }); expect(scans).toHaveBeenCalledWith(bootstrap.sourceId); await pipeline.tick(); expect(pipeline.task(task.taskId).accessories![0]!.state).toBe("COPYING");
      for (let i = 0; i < 12; i++) { wall += 10000; monotonic += 10000; await pipeline.scan(bootstrap.sourceId); } await pipeline.tick();
    }
    expect(pipeline.task(task.taskId).accessories![0]!.state).toBe("RECORDED"); expect(await readFile(preview.accessories![0]!.targetPath)).toEqual(subtitle); expect((await lstat(preview.targetPath)).ino).toBe(inode); expect(await readFile(join(f.rootPath, "completed", "目录", "乙.zh.ass"))).toEqual(subtitle);
  });
  it("过滤分离的共享根按各自快照 COPY，活动计划阻止移除策略，下载完成和 Emby 交付分别记账", async () => {
    const f = await setup(new Map([["目录/甲.mkv", Buffer.from("甲视频")], ["目录/乙.mp4", Buffer.from("乙视频")]]));
    const x = join(f.path, "电影甲"), y = join(f.path, "电影乙"); await mkdir(x); await mkdir(y);
    const gx = await probeManagedVolume(x), gy = await probeManagedVolume(y), first = await organized(f, "mkv 来源", f.account.rootRef!, gx, ["mkv"]);
    const second = await organized(f, "mp4 来源", f.account.rootRef!, gy, ["mp4"]);
    f.downloads.start(); await expect.poll(() => [first, second].map((row) => f.state(row.job.jobId).state), { timeout: 10000 }).toEqual(["COMPLETED", "COMPLETED"]);
    const bootstrap = f.pipeline.bootstrap()[0]!; await f.pipeline.close();
    const server = createServer((request, response) => { response.setHeader("Content-Type", "application/json"); const movie = { id: 1, title: "测试电影", original_title: "Test Movie", release_date: "2026-01-01" }; response.end(JSON.stringify(request.url!.startsWith("/search/") ? { results: [movie] } : movie)); });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); cleanup.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
    const connections = new MediaConnections(f.db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" }), { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }); cleanup.push(() => connections.close()); connections.install({ tmdb: "fixture", emby: null });
    let monotonic = 0; const parser = { ready: true, parse: async (name: string) => normalizeParse({ title: "测试电影", year: 2026, type: "movie" }, name) };
    const pipeline = new IngestionPipeline(f.db, () => parser, connections, Date.now, () => monotonic); cleanup.push(() => pipeline.close());
    await pipeline.authorizeTarget(gx); await pipeline.authorizeTarget(gy); await pipeline.authorizeManagedSource({ sourceId: bootstrap.sourceId, sourceVersion: bootstrap.sourceVersion, source: bootstrap.source });
    await pipeline.authorizeLibrary({ mediaType: "MOVIE", target: gy });
    await pipeline.scan(bootstrap.sourceId); for (let i = 0; i < 12; i++) { monotonic += 10000; await pipeline.scan(bootstrap.sourceId); }
    const candidate = pipeline.list({}).items.find((row) => row.relativePath.endsWith("甲.mkv"))!; expect(candidate.state).toBe("READY");
    const task = await pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await pipeline.tick();
    const preview = await pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false });
    expect(preview.targetPath.startsWith(x + "/")).toBe(true);
    const target = pipeline.targets.get(gx.id), commit = target.commit.bind(target); let entered = false, release!: () => void;
    const wait = new Promise<void>((done) => { release = done; }); cleanup.push(() => release());
    const spy = vi.spyOn(target, "commit").mockImplementationOnce(async (...args) => { entered = true; await wait; return commit(...args); });
    await pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await expect.poll(() => entered).toBe(true);
    const draft = f.rules.configure({ id: first.source.id, expectedVersion: 1, expectedDraftRevision: 1, requestKey: randomUUID(), configuration: { ...first.source.configuration!, organization: null } });
    const p = await f.preview(draft); await expect(f.rules.apply({ previewId: p.id, requestKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.rules.get(first.source.id)?.version).toBe(1); release(); await pipeline.tick(); spy.mockRestore();
    expect(await readFile(preview.targetPath)).toEqual(Buffer.from("甲视频")); expect(await readFile(join(f.rootPath, "completed", "目录", "甲.mkv"))).toEqual(Buffer.from("甲视频"));
    expect(f.db.connection.prepare("SELECT status,delivery_status FROM media_task WHERE id=?").get(task.taskId)).toEqual({ status: "DONE", delivery_status: "REFRESH_PENDING" });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM emby_delivery WHERE state='REFRESH_PENDING'").get()).toEqual({ n: 1 });
    const other = pipeline.list({}).items.find((row) => row.relativePath.endsWith("乙.mp4"))!, otherTask = await pipeline.recognize({ candidateId: other.id, requestKey: randomUUID() }); await pipeline.tick();
    const otherPreview = await pipeline.preview({ taskId: otherTask.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false });
    const interrupted = vi.spyOn(pipeline.targets.get(gy.id), "commit").mockRejectedValueOnce(new Error("模拟提交前退出"));
    const otherOperation = await pipeline.confirm({ previewId: otherPreview.id, requestKey: randomUUID() }); await pipeline.tick(); interrupted.mockRestore();
    expect(f.db.connection.prepare("SELECT evidence_json FROM ingestion_operation WHERE id=?").get(otherOperation.operationId)).toMatchObject({ evidence_json: expect.any(String) });
    await pipeline.authorizeLibrary({ mediaType: "MOVIE", target: gx }); await pipeline.close();
    // 模拟 v11 已验证的人工确认操作：升级时尚无候选策略表记录，仍持有原 COPY 计划和证据。
    f.db.connection.prepare("DELETE FROM ingestion_candidate_policy WHERE candidate_id=?").run(other.id);
    f.db.connection.prepare("UPDATE ingestion_operation SET phase='VERIFIED' WHERE id=?").run(otherOperation.operationId);
    const recovered = new IngestionPipeline(f.db, () => parser, connections, Date.now, () => monotonic); cleanup.push(() => recovered.close());
    await recovered.authorizeTarget(gx); await recovered.authorizeTarget(gy); await recovered.authorizeManagedSource({ sourceId: bootstrap.sourceId, sourceVersion: bootstrap.sourceVersion, source: bootstrap.source });
    const digest = vi.spyOn(SourceRoot.prototype, "digest"); cleanup.push(() => digest.mockRestore());
    await recovered.tick(); expect(digest).not.toHaveBeenCalled();
    expect(await readFile(otherPreview.targetPath)).toEqual(Buffer.from("乙视频"));
    expect(f.db.connection.prepare("SELECT phase FROM ingestion_operation WHERE id=?").get(otherOperation.operationId)).toEqual({ phase: "RECORDED" });
  });
});
describe.skipIf(process.platform !== "darwin")("下载成果独立投递", () => {
  it("生产接收端与 completed 补扫共享 item/version 唯一键，确认故障可重投且不消费外部文件", async () => {
    const f = await fixture(new Map([["movie.mp4", Buffer.from("fixture-video")]])), job = await f.confirm(); f.downloads.start(); await expect.poll(() => f.state(job.jobId).state).toBe("COMPLETED");
    let monotonic = 0;
    const connections = new MediaConnections(f.db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" })); cleanup.push(() => connections.close());
    const pipeline = new IngestionPipeline(f.db, () => undefined, connections, Date.now, () => monotonic); cleanup.push(() => pipeline.close());
    const target = join(f.path, "library"); await mkdir(target); const targetGrant = await probeManagedVolume(target);
    const sourceId = await pipeline.configureManaged({ downloadRootId: f.grant.id, name: "受管测试", mediaType: "AUTO", source: f.grant, target: targetGrant });
    const outbox = new IngestionOutbox(f.db, f.roots, pipeline); cleanup.push(() => outbox.close());
    f.db.connection.exec("CREATE TRIGGER test_real_ack_fault BEFORE UPDATE OF state ON ingestion_outbox WHEN NEW.state='ACKNOWLEDGED' BEGIN SELECT RAISE(ABORT,'模拟确认丢失'); END;");
    await outbox.deliver(); expect(pipeline.list({}).total).toBe(1); expect(pipeline.list({}).items[0]!.state).toBe("OBSERVING");
    f.db.connection.exec("DROP TRIGGER test_real_ack_fault; UPDATE ingestion_outbox SET next_attempt_at=NULL;"); await outbox.deliver();
    await writeFile(join(f.rootPath, "completed", "external.mp4"), "foreign");
    await writeFile(join(f.rootPath, ".media-marshal", "staging", "unpublished.mp4"), "not-completed");
    await pipeline.scan(sourceId); for (let i = 0; i < 12; i++) { monotonic += 10000; await pipeline.scan(sourceId); }
    expect(pipeline.list({}).total).toBe(1); expect(pipeline.list({}).items[0]!.state).toBe("READY");
    expect(f.db.connection.prepare("SELECT state,candidate_id FROM ingestion_outbox").get()).toEqual({ state: "ACKNOWLEDGED", candidate_id: pipeline.list({}).items[0]!.id });
    await f.roots.authorize(f.grant); expect(f.state(job.jobId).state).toBe("COMPLETED"); expect(f.fileEngine.starts).toBe(1);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
  });
  it("未接入接收端不消费事件，确认落库失败后重复投递只保留一个候选", async () => {
    const f = await fixture(), job = await f.confirm(); f.downloads.start(); await expect.poll(() => f.state(job.jobId).state).toBe("COMPLETED");
    // 先等待下载阶段收尾，再单独注入投递确认故障，避免与后台下载调度混在一起。
    await f.downloads.close();
    await new IngestionOutbox(f.db, f.roots).deliver(); expect(f.db.connection.prepare("SELECT state,delivery_attempts FROM ingestion_outbox").get()).toEqual({ state: "PENDING", delivery_attempts: 0 });
    f.db.connection.exec("CREATE TABLE test_ingestion_candidate(id TEXT PRIMARY KEY,item_id TEXT,version_key TEXT,UNIQUE(item_id,version_key)); CREATE TRIGGER test_ack_fault BEFORE UPDATE OF state ON ingestion_outbox WHEN NEW.state='ACKNOWLEDGED' BEGIN SELECT RAISE(ABORT,'模拟确认前崩溃'); END;");
    let calls = 0;
    const outbox = new IngestionOutbox(f.db, f.roots, { async accept(item) { calls++; f.db.connection.prepare("INSERT OR IGNORE INTO test_ingestion_candidate VALUES(?,?,?)").run(randomUUID(), item.itemId, item.versionKey); return { candidateId: (f.db.connection.prepare("SELECT id FROM test_ingestion_candidate WHERE item_id=? AND version_key=?").get(item.itemId, item.versionKey) as { id: string }).id }; } }); cleanup.push(() => outbox.close());
    await outbox.deliver(); expect(calls).toBe(1); expect(f.db.connection.prepare("SELECT state,delivery_attempts,failure_code FROM ingestion_outbox").get()).toEqual({ state: "PENDING", delivery_attempts: 1, failure_code: "INTERNAL_ERROR" });
    f.db.connection.exec("DROP TRIGGER test_ack_fault; UPDATE ingestion_outbox SET next_attempt_at=NULL;"); await outbox.deliver(); await outbox.deliver();
    expect(calls).toBe(2); expect(f.db.connection.prepare("SELECT count(*) AS n FROM test_ingestion_candidate").get()).toEqual({ n: 1 }); expect(f.db.connection.prepare("SELECT state FROM ingestion_outbox").get()).toEqual({ state: "ACKNOWLEDGED" });
    expect(f.state(job.jobId).state).toBe("COMPLETED"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
  });
  it("接收端不可用只重试投递，不能重传文件或将下载成果标为媒体 DONE", async () => {
    const f = await fixture(), job = await f.confirm(); f.downloads.start(); await expect.poll(() => f.state(job.jobId).state).toBe("COMPLETED");
    let calls = 0; const outbox = new IngestionOutbox(f.db, f.roots, { async accept() { calls++; throw new CloudError("COMPONENT_UNAVAILABLE"); } }); cleanup.push(() => outbox.close());
    for (let i = 0; i < 4; i++) { f.db.connection.prepare("UPDATE ingestion_outbox SET next_attempt_at=NULL").run(); await outbox.deliver(); }
    expect(calls).toBe(3); expect(f.fileEngine.starts).toBe(1); expect(f.state(job.jobId).state).toBe("COMPLETED"); expect(f.db.connection.prepare("SELECT state FROM ingestion_outbox").get()).toEqual({ state: "PENDING" });
  });
});
describe.skipIf(process.platform !== "darwin")("订阅扫描与配置快照", () => {
  it("恢复的历史完成项先核对本地证据，改动文件不补下载或保留虚假完成状态", async () => {
    const f = await fixture(), job = await f.confirm(); f.downloads.start(); await expect.poll(() => f.state(job.jobId).state).toBe("COMPLETED");
    f.downloads.reconcileRestored(); expect(f.state(job.jobId).state).toBe("RECONCILING"); await expect.poll(() => f.state(job.jobId).state).toBe("COMPLETED");
    await writeFile(join(f.rootPath, "completed/电影.txt"), "恢复前已修改"); f.downloads.reconcileRestored();
    await expect.poll(() => f.state(job.jobId).failure?.code).toBe("CONFLICT"); expect(f.state(job.jobId).state).toBe("RECONCILING"); expect(f.fileEngine.starts).toBe(1); expect(await readFile(join(f.rootPath, "completed/电影.txt"), "utf8")).toBe("恢复前已修改");
  });
  it("组件维护暂停领取，重建调度器后继续原作业而不产生第二个写入者", async () => {
    const f = await fixture(), job = await f.confirm(); f.downloads.quiesce(); f.downloads.start();
    await new Promise((done) => setTimeout(done, 550)); expect(f.fileEngine.starts).toBe(0); expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_attempt").get()).toEqual({ n: 0 });
    await f.downloads.close(); const restored = new CloudDownloads(f.db, f.host, f.catalog, f.roots); cleanup.push(() => restored.close()); restored.start();
    await expect.poll(() => restored.list({}).items.find((item) => item.id === job.jobId)?.state).toBe("COMPLETED"); expect(f.fileEngine.maximumWriters).toBe(1);
  });
  it("全部云端暂停独立持久化，恢复不误恢复用户单独暂停的任务", async () => {
    const f = await fixture(new Map([["one.txt", Buffer.from("one")], ["two.txt", Buffer.from("two")]])), first = await f.confirm(), manual = await f.confirm(f.entries[1]!.ref);
    f.downloads.control({ jobId: manual.jobId, operation: "pause", requestKey: randomUUID() });
    f.fileEngine.holding = true; f.downloads.start(); await expect.poll(() => f.fileEngine.starts).toBe(1);
    const command = { paused: true, requestKey: randomUUID() }; f.downloads.setPaused(command);
    await expect.poll(() => f.downloads.pauseStatus().pausing).toBe(false);
    expect(f.downloads.pauseStatus().paused).toBe(true); expect(f.state(first.jobId).state).toBe("PAUSED");
    const created = await f.confirm(); expect(f.state(created.jobId).state).toBe("PAUSED");
    expect(f.downloads.setPaused(command).paused).toBe(true);
    f.fileEngine.release(); f.downloads.setPaused({ paused: false, requestKey: randomUUID() });
    await expect.poll(() => f.state(first.jobId).state).toBe("COMPLETED");
    expect(f.state(manual.jobId).state).toBe("PAUSED"); expect(f.state(created.jobId).state).toBe("COMPLETED"); expect(f.fileEngine.maximumWriters).toBe(1);
  });
  it("下载期间原根被替换时停止写入，恢复只认原目录身份", async () => {
    const f = await fixture(), job = await f.confirm(); f.fileEngine.holding = true; f.downloads.start(); await expect.poll(() => f.fileEngine.starts).toBe(1);
    await rename(f.rootPath, f.rootPath + "-offline"); await mkdir(f.rootPath);
    await expect.poll(() => f.state(job.jobId).state).toBe("BLOCKED_LOCAL"); expect(f.fileEngine.stops).toBe(1); expect(await readdir(f.rootPath)).toEqual([]);
    await f.downloads.wake(); expect(f.state(job.jobId).state).toBe("BLOCKED_LOCAL"); expect(f.fileEngine.starts).toBe(1);
    await rm(f.rootPath, { recursive: true }); await rename(f.rootPath + "-offline", f.rootPath); f.fileEngine.release();
    await f.roots.authorize(await probeManagedVolume(f.rootPath, f.grant.id)); await f.downloads.wake();
    await expect.poll(() => f.state(job.jobId).state).toBe("COMPLETED"); expect(f.fileEngine.maximumWriters).toBe(1);
  });
  it("同代际重新授权的真实静止证明解除丢失回执占位，不依赖伪造新 Host 代际", async () => {
    const f = await fixture(), job = await f.confirm(), request = f.host.request.bind(f.host); f.fileEngine.holding = true;
    f.host.request = async (action, payload, context, key) => { const result = await request(action, payload, context, key); if (action === "transfer.start") throw new CloudError("TIMEOUT"); return result; };
    f.downloads.start(); await expect.poll(() => f.state(job.jobId).state).toBe("RECONCILING");
    await f.sidecar.quiesceAccount(f.account.id); f.downloads.accountWritersStopped(f.account.id); f.host.request = request; f.fileEngine.release();
    await expect.poll(() => f.state(job.jobId).state).toBe("COMPLETED"); expect(f.fileEngine.maximumWriters).toBe(1);
  });
  it("扫描网络错误最多尝试三次，反复唤醒不清空失败预算", async () => {
    const f = await fixture(new Map([["目录/one.mp4", Buffer.from("one")]]));
    const sub = f.subscriptions.configure({ previewId: (await f.preview(undefined, { layout: "drive" })).id, requestKey: randomUUID() });
    f.subscriptions.start(); await expect.poll(() => f.subscriptions.list({}).items[0]?.state).toBe("IDLE");
    let calls = 0; f.provider.fault = () => { calls++; throw new CloudError("NETWORK_UNAVAILABLE"); };
    f.subscriptions.control({ subscriptionId: sub.id, operation: "scan", requestKey: randomUUID() });
    await expect.poll(() => f.subscriptions.list({}).items[0]?.state, { timeout: 12000 }).toBe("FAILED"); const exhausted = calls;
    for (let i = 0; i < 3; i++) await f.subscriptions.wake(randomUUID());
    expect(f.subscriptions.list({}).items[0]?.state).toBe("FAILED"); expect(calls).toBe(exhausted);
    expect(f.db.connection.prepare("SELECT retry_count FROM cloud_subscription_runtime WHERE subscription_id=?").get(sub.id)).toEqual({ retry_count: 3 });
  });

  it("确认前不产生下载；重复确认和扫描触发合并为同一作业", async () => {
    const f = await fixture(new Map([["目录/one.mp4", Buffer.from("one")], ["目录/skip.mp4", Buffer.from("skip")]]));
    f.downloads.start(); f.subscriptions.start();
    const preview = await f.preview(undefined, { layout: "drive", filters: { names: ["one.mp4"] } });
    expect(f.fileEngine.starts).toBe(0); expect(f.subscriptions.list({}).total).toBe(0);
    const command = { previewId: preview.id, intervalSeconds: 60, requestKey: randomUUID() }, sub = f.subscriptions.configure(command);
    expect(f.subscriptions.configure(command).id).toBe(sub.id);
    expect(() => f.subscriptions.configure({ ...command, intervalSeconds: 120 })).toThrow();
    for (let i = 0; i < 3; i++) f.subscriptions.control({ subscriptionId: sub.id, operation: "scan", requestKey: randomUUID() });
    await expect.poll(() => f.subscriptions.list({}).items[0]?.state).toBe("IDLE");
    await expect.poll(() => f.downloads.list({}).items[0]?.state, { timeout: 5000 }).toBe("COMPLETED");
    expect(f.fileEngine.starts).toBe(1); expect(f.downloads.list({}).total).toBe(1);
    expect(await readFile(join(f.rootPath, "completed/目录/one.mp4"), "utf8")).toBe("one");
    f.subscriptions.control({ subscriptionId: sub.id, operation: "scan", requestKey: randomUUID() });
    await expect.poll(() => f.subscriptions.list({}).items[0]?.lastResult?.reused, { timeout: 5000 }).toBe(1);
    expect(f.downloads.list({}).total).toBe(1);
  });
  it("重叠父子订阅使用相同目标槽位，取消一个订阅不停止共享传输", async () => {
    const f = await fixture(new Map([["目录/子目录/one.mp4", Buffer.from("one")]])); f.fileEngine.holding = true;
    const parent = f.entries[0]!, child = (await f.catalog.list({ accountId: f.account.id, parentRef: parent.ref })).items[0]!;
    const first = f.subscriptions.configure({ previewId: (await f.preview(parent.ref, { layout: "drive" })).id, requestKey: randomUUID() });
    const second = f.subscriptions.configure({ previewId: (await f.preview(child.ref, { layout: "drive" })).id, requestKey: randomUUID() });
    f.downloads.start(); f.subscriptions.start();
    await expect.poll(() => f.downloads.list({}).total).toBe(2); await expect.poll(() => f.fileEngine.starts).toBe(1);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_item").get()).toEqual({ n: 1 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_claim").get()).toEqual({ n: 1 });
    f.subscriptions.control({ subscriptionId: first.id, operation: "cancel", requestKey: randomUUID() });
    await expect.poll(() => f.downloads.list({}).items.filter((job) => job.state === "CANCELLED").length).toBe(1);
    expect(f.fileEngine.stops).toBe(0); f.fileEngine.release();
    await expect.poll(() => f.downloads.list({}).items.filter((job) => job.state === "COMPLETED").length).toBe(1);
    expect(f.subscriptions.list({}).items.find((sub) => sub.id === second.id)?.enabled).toBe(true); expect(f.fileEngine.maximumWriters).toBe(1);
  });
  it("分页失败保留不完整状态和已有成果，不确认局部范围或删除本地文件", async () => {
    const f = await fixture(new Map(Array.from({ length: 101 }, (_, i) => [`目录/${i}.txt`, Buffer.from("x")])));
    const preview = await f.preview(undefined, { layout: "drive" }), sub = f.subscriptions.configure({ previewId: preview.id, requestKey: randomUUID() });
    f.subscriptions.start(); await expect.poll(() => f.subscriptions.list({}).items[0]?.lastResult?.complete).toBe(true);
    const before = f.downloads.list({}).total, list = f.provider.list.bind(f.provider);
    f.provider.list = async (input) => { if (input.cursor) throw new CloudError("NETWORK_UNAVAILABLE"); return list(input); };
    f.subscriptions.control({ subscriptionId: sub.id, operation: "scan", requestKey: randomUUID() });
    await expect.poll(() => f.subscriptions.list({}).items[0]?.state, { timeout: 5000 }).toBe("RETRY_WAIT");
    expect(f.subscriptions.list({}).items[0]?.lastResult?.complete).toBe(false); expect(f.downloads.list({}).total).toBe(before); expect(f.fileEngine.starts).toBe(0);
    expect(f.db.connection.prepare("SELECT state FROM cloud_scan ORDER BY started_at DESC LIMIT 1").get()).toEqual({ state: "INCOMPLETE" });
  });
  it("配置更新需新范围确认并淘汰旧版本需求，暂停恢复沿用当前配置", async () => {
    const f = await fixture(new Map([["目录/one.mp4", Buffer.from("one")], ["目录/two.mp4", Buffer.from("two")]])); f.fileEngine.holding = true;
    const initial = await f.preview(undefined, { layout: "drive", filters: { names: ["one.mp4"] } });
    const sub = f.subscriptions.configure({ previewId: initial.id, requestKey: randomUUID() }); f.downloads.start(); f.subscriptions.start();
    await expect.poll(() => f.fileEngine.starts).toBe(1);
    f.subscriptions.control({ subscriptionId: sub.id, operation: "pause", requestKey: randomUUID() });
    await expect.poll(() => f.downloads.list({}).items[0]?.state, { timeout: 5000 }).toBe("PAUSED");
    f.subscriptions.control({ subscriptionId: sub.id, operation: "resume", requestKey: randomUUID() });
    await expect.poll(() => f.fileEngine.starts).toBe(2);
    const next = await f.preview(undefined, { layout: "drive", filters: { names: ["two.mp4"] } });
    expect(() => f.subscriptions.configure({ subscriptionId: sub.id, configurationVersion: 2, previewId: next.id, requestKey: randomUUID() })).toThrow();
    expect(f.subscriptions.configure({ subscriptionId: sub.id, configurationVersion: 1, previewId: next.id, requestKey: randomUUID() }).configurationVersion).toBe(2);
    f.fileEngine.release(); await expect.poll(() => f.downloads.list({}).items.filter((job) => job.state === "COMPLETED").length).toBe(1);
    expect(f.fileEngine.maximumWriters).toBe(1); expect(await readFile(join(f.rootPath, "completed/目录/two.mp4"), "utf8")).toBe("two");
  });
  it("重启将错过的周期合并补扫一次，已完成文件不产生第二个作业", async () => {
    const f = await fixture(new Map([["目录/one.mp4", Buffer.from("one")]]));
    f.subscriptions.configure({ previewId: (await f.preview(undefined, { layout: "drive" })).id, intervalSeconds: 60, requestKey: randomUUID() }); f.downloads.start(); f.subscriptions.start();
    await expect.poll(() => f.downloads.list({}).items[0]?.state, { timeout: 5000 }).toBe("COMPLETED"); await f.subscriptions.close();
    const before = (f.db.connection.prepare("SELECT count(*) AS n FROM cloud_scan").get() as { n: number }).n;
    f.db.connection.prepare("UPDATE cloud_subscription SET next_scan_at='2000-01-01T00:00:00.000Z'").run();
    const restored = new CloudSubscriptions(f.db, f.downloads, f.catalog, f.roots); cleanup.push(() => restored.close()); restored.start();
    await expect.poll(() => restored.list({}).items[0]?.lastResult?.reused, { timeout: 5000 }).toBe(1);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM cloud_scan").get()).toEqual({ n: before + 1 }); expect(f.downloads.list({}).total).toBe(1); expect(f.fileEngine.starts).toBe(1);
  });
  it("本地成果被删除时进入待处理，不能依据历史完成记录跳过", async () => {
    const f = await fixture(), job = await f.confirm(); f.downloads.start(); await expect.poll(() => f.state(job.jobId).state).toBe("COMPLETED");
    await rm(join(f.rootPath, "completed/电影.txt")); expect(await f.preview()).toMatchObject({ reuseFiles: 0, conflicts: 1 }); expect(f.state(job.jobId).state).toBe("RECONCILING"); expect(f.fileEngine.starts).toBe(1);
  });
});
describe.skipIf(process.platform !== "darwin")("Core 下载调度、文件校验与提交", () => {
  it("未确认范围不下载，确认立即返回稳定 ID，非零退出的完整文件仍逐项校验提交", async () => {
    const f = await fixture(), p = await f.preview(); f.fileEngine.exitCode = 5;
    f.downloads.start(); expect(f.fileEngine.starts).toBe(0); const request = { previewId: p.id, requestKey: randomUUID() }, first = await f.downloads.confirm(request);
    expect(await f.downloads.confirm(request)).toEqual(first);
    await expect.poll(() => f.state(first.jobId).state).toBe("COMPLETED");
    expect(await readFile(join(f.rootPath, "completed", "电影.txt"))).toEqual(f.input.get("电影.txt"));
    expect(f.db.connection.prepare("SELECT state FROM ingestion_outbox").get()).toEqual({ state: "PENDING" });
    // 完成记录先提交，暂存回收异步收尾；等待回收结果，避免将这段合法窗口误判为残留。
    await expect.poll(() => readdir(join(f.rootPath, ".media-marshal", "staging"))).toEqual([]); expect(f.fileEngine.starts).toBe(1);
  });
  it("暂停中立即恢复被拒绝，停止后重建 attempt，已完成文件不被删除", async () => {
    const f = await fixture(), job = await f.confirm(); f.fileEngine.holding = true; f.downloads.start();
    await expect.poll(() => f.fileEngine.starts).toBe(1);
    f.downloads.control({ jobId: job.jobId, operation: "pause", requestKey: randomUUID() });
    expect(() => f.downloads.control({ jobId: job.jobId, operation: "resume", requestKey: randomUUID() })).toThrow();
    await expect.poll(() => f.state(job.jobId).state).toBe("PAUSED"); expect(f.fileEngine.starts).toBe(1);
    f.fileEngine.release(); f.downloads.control({ jobId: job.jobId, operation: "resume", requestKey: randomUUID() });
    await expect.poll(() => f.state(job.jobId).state).toBe("COMPLETED"); expect(f.fileEngine.maximumWriters).toBe(1); expect(f.fileEngine.starts).toBe(2);
    f.downloads.control({ jobId: job.jobId, operation: "cancel", requestKey: randomUUID() }); expect(f.state(job.jobId).state).toBe("COMPLETED");
    expect(await readFile(join(f.rootPath, "completed", "电影.txt"))).toEqual(f.input.get("电影.txt"));
  });
  it("重叠作业共享下载项，取消一个需求不停止另一个需求的写入者", async () => {
    const f = await fixture(), first = await f.confirm(), second = await f.confirm(); f.fileEngine.holding = true; f.downloads.start();
    await expect.poll(() => f.fileEngine.starts).toBe(1);
    f.downloads.control({ jobId: first.jobId, operation: "cancel", requestKey: randomUUID() });
    await expect.poll(() => f.state(first.jobId).state).toBe("CANCELLED"); expect(f.fileEngine.stops).toBe(0);
    f.fileEngine.release(); await expect.poll(() => f.state(second.jobId).state).toBe("COMPLETED"); expect(f.fileEngine.starts).toBe(1);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_item").get()).toEqual({ n: 1 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_outbox").get()).toEqual({ n: 1 });
  });
  it("认证失败停止新领取，网络失败有限重试，远端变化不能进入完成目录", async () => {
    const f = await fixture(), job = await f.confirm(); f.provider.fault = () => { throw new CloudError("AUTH_REQUIRED"); }; f.downloads.start();
    await expect.poll(() => f.state(job.jobId).state).toBe("AUTH_REQUIRED"); expect(f.fileEngine.starts).toBe(0);
    f.provider.fault = undefined; f.db.connection.prepare("UPDATE cloud_account SET status='READY'").run();
    f.downloads.control({ jobId: job.jobId, operation: "retry", requestKey: randomUUID() });
    f.input.set("电影.txt", Buffer.from("同名远端内容已改变")); await expect.poll(() => f.state(job.jobId).state).toBe("FAILED");
    expect(f.state(job.jobId).failure?.code).toBe("REMOTE_CHANGED"); expect(await readdir(join(f.rootPath, "completed"))).toEqual([]);
  });
  it("传输缺文件按固定策略最多三次，不会重复累计成功字节", async () => {
    const f = await fixture(), job = await f.confirm(); f.fileEngine.omit = true; f.fileEngine.exitCode = 5; f.downloads.start();
    await expect.poll(() => f.state(job.jobId).state, { timeout: 10000 }).toBe("FAILED"); expect(f.fileEngine.starts).toBe(3); expect(f.state(job.jobId).progress.bytes).toBe(0);
  }, 15000);
  it("传输期间远端版本变化或同长度错误内容均不提交", async () => {
    for (const mode of ["remote", "content"] as const) {
      const f = await fixture(), job = await f.confirm();
      if (mode === "remote") f.fileEngine.afterWrite = () => { f.input.set("电影.txt", Buffer.from("原路径已被远端替换")); }; else f.fileEngine.corrupt = true;
      f.downloads.start(); await expect.poll(() => f.state(job.jobId).state).toBe("FAILED");
      expect(f.state(job.jobId).failure?.code).toBe("REMOTE_CHANGED"); expect(await readdir(join(f.rootPath, "completed"))).toEqual([]);
      expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_outbox").get()).toEqual({ n: 0 });
    }
  });
  it("限流形成账号退避，暂停后的旧序号和错误代际进度不能回滚状态", async () => {
    const f = await fixture(), job = await f.confirm(); let limited = false;
    f.provider.fault = () => { if (!limited) { limited = true; throw new CloudError("RATE_LIMITED", 1); } }; f.fileEngine.holding = true; f.downloads.start();
    await expect.poll(() => f.state(job.jobId).state).toBe("RETRY_WAIT"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM cloud_account_backoff").get()).toEqual({ n: 1 });
    await expect.poll(() => f.fileEngine.starts, { timeout: 5000 }).toBe(1);
    const row = f.db.connection.prepare("SELECT * FROM download_attempt").get() as { id: string; core_generation: string; host_generation: string; binding_generation: string; execution_id: string };
    const context = { attemptId: row.id, coreGeneration: row.core_generation, hostGeneration: row.host_generation, bindingGeneration: row.binding_generation }, send = (sequence: number, bytes: number, coreGeneration = context.coreGeneration) => { for (const listener of f.listeners) listener({ kind: "host.event", protocolVersion: 1, sequence, context: { ...context, coreGeneration }, executionId: row.execution_id, event: { type: "progress", bytes, totalBytes: null, bytesPerSecond: 1 } }); };
    send(10, 5); send(9, 2); send(11, 99, randomUUID()); expect(f.state(job.jobId).progress.bytes).toBe(5);
    f.downloads.control({ jobId: job.jobId, operation: "pause", requestKey: randomUUID() }); send(12, 99);
    await expect.poll(() => f.state(job.jobId).state).toBe("PAUSED"); expect(f.state(job.jobId).progress.bytes).toBe(0); expect(f.fileEngine.starts).toBe(1);
  });
  it("持续限流冻结同账号其他作业，每项最多三次且耗尽后不自动恢复", async () => {
    let clock = Date.now(), calls = 0;
    const f = await fixture(new Map([["one.mp4", Buffer.from("one")], ["two.mp4", Buffer.from("two")]]), false, () => clock);
    const jobs = [await f.confirm(f.entries[0]!.ref), await f.confirm(f.entries[1]!.ref)];
    f.provider.fault = () => { calls++; throw new CloudError("RATE_LIMITED", 30); }; f.downloads.start();
    await expect.poll(() => calls).toBe(1);
    await new Promise((done) => setTimeout(done, 550)); expect(calls).toBe(1);
    expect(f.fileEngine.starts).toBe(0); expect(f.db.connection.prepare("SELECT count(*) AS n FROM cloud_account_backoff").get()).toEqual({ n: 1 });
    for (let expected = 2; expected <= 6; expected++) {
      clock += 60001;
      await expect.poll(() => calls).toBe(expected);
    }
    await expect.poll(() => jobs.map((job) => f.state(job.jobId).state)).toEqual(["FAILED", "FAILED"]);
    expect(f.db.connection.prepare("SELECT attempt_count FROM download_item_runtime ORDER BY item_id").all()).toEqual([{ attempt_count: 3 }, { attempt_count: 3 }]);
    clock += 3600000; await f.downloads.wake(); await new Promise((done) => setTimeout(done, 550));
    expect(calls).toBe(6); expect(f.fileEngine.starts).toBe(0);
    expect(jobs.map((job) => f.state(job.jobId).failure?.code)).toEqual(["RATE_LIMITED", "RATE_LIMITED"]);
  });
  it("提交后记账前中断凭原文件身份补记，外部同内容文件不能被认领", async () => {
    const f = await fixture(), job = await f.confirm();
    const interrupted = new DownloadCommits(f.db, f.roots, f.catalog, async (point) => { if (point === "linked") throw new Error("模拟提交后中断"); });
    Object.defineProperty(f.downloads, "commits", { value: interrupted }); f.downloads.start();
    await expect.poll(() => f.db.connection.prepare("SELECT state FROM download_commit_intent").get()).toEqual({ state: "RECONCILING" });
    const item = f.db.connection.prepare("SELECT id FROM download_item").get() as { id: string }, recovery = new DownloadCommits(f.db, f.roots, f.catalog);
    await recovery.finish(item.id); await expect.poll(() => f.state(job.jobId).state).toBe("COMPLETED");
    expect(f.fileEngine.starts).toBe(1); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_outbox").get()).toEqual({ n: 1 });
  });
  it("启动回执丢失时不重放写入，只有确认旧写入者停止后才创建替代 attempt", async () => {
    const f = await fixture(), job = await f.confirm(), request = f.host.request.bind(f.host); f.fileEngine.holding = true;
    f.host.request = async (action, payload, context, key) => { const result = await request(action, payload, context, key); if (action === "transfer.start") throw new CloudError("TIMEOUT"); return result; };
    f.downloads.start(); await expect.poll(() => f.state(job.jobId).state).toBe("RECONCILING");
    expect(f.db.connection.prepare("SELECT state FROM download_attempt").get()).toEqual({ state: "UNCERTAIN" }); await expect.poll(() => f.fileEngine.starts).toBe(1);
    f.downloads.control({ jobId: job.jobId, operation: "pause", requestKey: randomUUID() });
    expect(() => f.downloads.control({ jobId: job.jobId, operation: "resume", requestKey: randomUUID() })).toThrow();
    await f.sidecar.quiesceAccount(f.account.id); f.downloads.writersReaped(randomUUID()); f.host.request = request; f.fileEngine.release();
    await expect.poll(() => f.state(job.jobId).state).toBe("PAUSED"); f.downloads.control({ jobId: job.jobId, operation: "resume", requestKey: randomUUID() });
    await expect.poll(() => f.state(job.jobId).state).toBe("COMPLETED"); expect(f.fileEngine.maximumWriters).toBe(1); expect(f.fileEngine.starts).toBe(2);
  });
  it("取消后的同范围可重新预览确认，复用条目而非永久停留在 CANCELLED", async () => {
    const f = await fixture(), first = await f.confirm(); f.fileEngine.holding = true; f.downloads.start(); await expect.poll(() => f.fileEngine.starts).toBe(1);
    f.downloads.control({ jobId: first.jobId, operation: "cancel", requestKey: randomUUID() }); await expect.poll(() => f.state(first.jobId).state).toBe("CANCELLED");
    f.fileEngine.release(); const second = await f.confirm(); await expect.poll(() => f.state(second.jobId).state).toBe("COMPLETED");
    expect(f.state(first.jobId).state).toBe("CANCELLED"); expect(f.fileEngine.starts).toBe(2); expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_item").get()).toEqual({ n: 1 });
  });
  it("增量复用先核对本地指纹，同尺寸可靠版本变化形成冲突；强制重下写入独立位置", async () => {
    const f = await fixture(), initial = Buffer.from(f.input.get("电影.txt")!), first = await f.confirm(); f.downloads.start(); await expect.poll(() => f.state(first.jobId).state).toBe("COMPLETED");
    const reusable = await f.preview(); expect(reusable).toMatchObject({ reuseFiles: 1, conflicts: 0 }); const reused = await f.downloads.confirm({ previewId: reusable.id, requestKey: randomUUID() }); expect(f.state(reused.jobId).state).toBe("COMPLETED"); expect(f.fileEngine.starts).toBe(1);
    const changed = Buffer.alloc(initial.length, 67); f.input.set("电影.txt", changed);
    const conflict = await f.preview(); expect(conflict).toMatchObject({ reuseFiles: 0, conflicts: 1 }); const blocked = await f.downloads.confirm({ previewId: conflict.id, requestKey: randomUUID() }); expect(f.state(blocked.jobId).state).toBe("FAILED"); expect(f.fileEngine.starts).toBe(1);
    const forced = await f.preview(undefined, { forceRedownload: true }); expect(forced.forceRedownload).toBe(true); expect(forced.destinationPrefix).toContain(forced.id);
    const fresh = await f.downloads.confirm({ previewId: forced.id, requestKey: randomUUID() }); await expect.poll(() => f.state(fresh.jobId).state).toBe("COMPLETED");
    expect(await readFile(join(f.rootPath, "completed", "电影.txt"))).toEqual(initial); expect(await readFile(join(f.rootPath, forced.destinationPrefix, "电影.txt"))).toEqual(changed);
  });
  it("弱证据明确不能发现同尺寸远端替换，本地缺失/修改则必须进入待处理", async () => {
    const f = await fixture(), stat = f.provider.stat.bind(f.provider); f.provider.stat = async (input) => ({ ...await stat(input), version: null });
    const job = await f.confirm(); f.downloads.start(); await expect.poll(() => f.state(job.jobId).state).toBe("COMPLETED");
    f.input.set("电影.txt", Buffer.alloc(f.input.get("电影.txt")!.length, 68));
    const weak = await f.preview(); expect(weak).toMatchObject({ weakComparison: true, reuseFiles: 1 });
    await writeFile(join(f.rootPath, "completed", "电影.txt"), "本地已修改"); const modified = await f.preview(); expect(modified).toMatchObject({ reuseFiles: 0, conflicts: 1 }); expect(f.state(job.jobId).state).toBe("RECONCILING"); expect(f.fileEngine.starts).toBe(1);
  });
  it("源端删除不删除成果，过滤只影响新需求且不传递为引擎表达式", async () => {
    const f = await fixture(new Map([["目录/one.mp4", Buffer.from("one")], ["目录/two.mkv", Buffer.from("two")], ["目录/readme.txt", Buffer.from("text")]])), rootRef = f.entries[0]!.ref;
    const first = await f.confirm(rootRef); f.downloads.start(); await expect.poll(() => f.state(first.jobId).state, { timeout: 5000 }).toBe("COMPLETED");
    f.input.delete("目录/one.mp4"); const next = await f.preview(rootRef, { filters: { extensions: ["MKV"] } }); expect(next).toMatchObject({ files: 1, reuseFiles: 1, conflicts: 0 });
    expect(await readFile(join(f.rootPath, "completed", "目录/one.mp4"), "utf8")).toBe("one"); expect(f.fileEngine.starts).toBe(3);
  });
});
describe.runIf(process.platform === "darwin" && process.env.MARSHAL_NATIVE_TESTS === "1")("替换 OpenList 的完整业务契约", () => {
  it("独立 WebDAV Provider 与真实 Rclone 经过同一预览、SQL 调度、校验和完成流程", async () => {
    const f = await fixture(new Map([["目录/中文 空格.txt", Buffer.from("无 OpenList 的完整文件")], ["目录/--选项.txt", Buffer.from("精确文件名")]]), true), job = await f.confirm(f.entries[0]!.ref); f.downloads.start();
    await expect.poll(() => f.state(job.jobId).state, { timeout: 30000 }).toBe("COMPLETED");
    for (const [name, data] of f.input) expect(await readFile(join(f.rootPath, "completed", name))).toEqual(data);
    expect(f.state(job.jobId).progress.completedItems).toBe(2); expect(f.server.gets).toHaveLength(2);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_outbox").get()).toEqual({ n: 2 });
  }, 60000);
});
