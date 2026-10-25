import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, readFile, mkdir, writeFile, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
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
import { IngestionPipeline } from "../../../../../packages/media-core/src/ingestion/pipeline";
import { MediaConnections } from "../../../../../packages/media-core/src/application/media-connections";
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
    await new IngestionOutbox(f.db, f.roots).deliver(); expect(f.db.connection.prepare("SELECT state,delivery_attempts FROM ingestion_outbox").get()).toEqual({ state: "PENDING", delivery_attempts: 0 });
    f.db.connection.exec("CREATE TABLE test_ingestion_candidate(id TEXT PRIMARY KEY,item_id TEXT,version_key TEXT,UNIQUE(item_id,version_key)); CREATE TRIGGER test_ack_fault BEFORE UPDATE OF state ON ingestion_outbox WHEN NEW.state='ACKNOWLEDGED' BEGIN SELECT RAISE(ABORT,'模拟确认前崩溃'); END;");
    let calls = 0;
    const outbox = new IngestionOutbox(f.db, f.roots, { async accept(item) { calls++; f.db.connection.prepare("INSERT OR IGNORE INTO test_ingestion_candidate VALUES(?,?,?)").run(randomUUID(), item.itemId, item.versionKey); return { candidateId: (f.db.connection.prepare("SELECT id FROM test_ingestion_candidate WHERE item_id=? AND version_key=?").get(item.itemId, item.versionKey) as { id: string }).id }; } }); cleanup.push(() => outbox.close());
    await outbox.deliver(); expect(f.db.connection.prepare("SELECT state FROM ingestion_outbox").get()).toEqual({ state: "PENDING" });
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
