import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, lstat, statfs, writeFile, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { CoreInput, SourceRule } from "@media-marshal/contracts";
import { CoreDatabase } from "../infrastructure/database";
import { CloudRoots } from "../cloud/roots";
import { CloudDownloads } from "../cloud/downloads";
import { CloudSubscriptions } from "../cloud/subscriptions";
import { RemoteCatalog } from "../cloud/catalog";
import { unavailableHost } from "../cloud/host-gateway";
import { MediaConnections } from "../application/media-connections";
import { IngestionPipeline } from "../ingestion/pipeline";
import { SourceRules } from "./rules";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function grant(path: string): Promise<ManagedRootGrant> {
  const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true });
  return { id: randomUUID(), path, volume: { volumeId: randomUUID(), rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "real-test-volume", caseSensitive: process.platform !== "win32", unicodeEquivalent: true, pathMaxBytes: 4096 } };
}
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-source-rules-"))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "中文 来源"), targetPath = join(directory, "中文 媒体库"); await mkdir(sourcePath); await mkdir(targetPath); await writeFile(join(sourcePath, "保留.mp4"), "preserve-original");
  const db = await CoreDatabase.open(join(directory, "core.sqlite3")); cleanup.push(() => db.close());
  const roots = new CloudRoots(db); cleanup.push(() => roots.close());
  const catalog = new RemoteCatalog(db, unavailableHost), downloads = new CloudDownloads(db, unavailableHost, catalog, roots); cleanup.push(() => downloads.close());
  const subscriptions = new CloudSubscriptions(db, downloads, catalog, roots); cleanup.push(() => subscriptions.close());
  const connections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" })); cleanup.push(() => connections.close());
  const pipeline = new IngestionPipeline(db, () => undefined, connections); cleanup.push(() => pipeline.close());
  let clock = Date.now(); const rules = new SourceRules(db, downloads, subscriptions, pipeline, () => clock); cleanup.push(() => rules.close());
  const grants = { source: await grant(sourcePath), target: await grant(targetPath) };
  const draft: CoreInput<"source-rules.configure"> = { id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, requestKey: randomUUID(), configuration: { type: "local", name: "本地夸克来源", client: "quark", sourcePath, organization: { targetPath } } };
  const preview = (row: SourceRule) => rules.preview({ id: row.id, expectedVersion: row.version, expectedDraftRevision: row.draftRevision, requestKey: randomUUID() });
  return { directory, sourcePath, targetPath, db, rules, grants, draft, pipeline, preview, advance(ms: number) { clock += ms; } };
}
describe("统一来源配置与真实 SQLite 事务", () => {
  it("删除与恢复草稿保留原记录，旧请求不能跨生命周期改变来源", async () => {
    const f = await fixture(), draft = f.rules.configure(f.draft), preview = f.preview(draft), remove = { id: draft.id, expectedVersion: 0, expectedDraftRevision: 1, expectedLifecycleRevision: 0, requestKey: randomUUID() };
    const deleted = f.rules.lifecycle(remove, "remove"); expect(deleted).toMatchObject({ deletedAt: expect.any(String), lifecycleRevision: 1, paused: true, version: 0 }); expect(f.rules.list()).toEqual([]); expect(f.rules.list(true)).toHaveLength(1); expect(f.rules.lifecycle(remove, "remove")).toEqual(deleted);
    expect(f.rules.getPreview(preview.id)?.state).toBe("EXPIRED"); expect(() => f.rules.configure({ ...f.draft, expectedDraftRevision: 1, requestKey: randomUUID() })).toThrow();
    expect(() => f.rules.lifecycle({ ...remove, requestKey: randomUUID(), expectedLifecycleRevision: 0 }, "restore")).toThrow();
    const restored = f.rules.lifecycle({ ...remove, expectedLifecycleRevision: 1, requestKey: randomUUID() }, "restore"); expect(restored).toMatchObject({ deletedAt: null, lifecycleRevision: 2, paused: true, draftRevision: 1 });
    expect(f.rules.lifecycle(remove, "remove")).toMatchObject({ deletedAt: null, lifecycleRevision: 2 }); expect(() => f.rules.lifecycle({ ...remove, requestKey: randomUUID() }, "remove")).toThrow();
    const edited = f.rules.configure({ ...f.draft, expectedDraftRevision: 1, expectedLifecycleRevision: 2, requestKey: randomUUID(), configuration: { ...f.draft.configuration, name: "恢复后继续编辑" } }); expect(edited.draftRevision).toBe(2); expect(f.db.connection.prepare("SELECT count(*) AS n FROM source_rule_lifecycle_command").get()).toEqual({ n: 2 });
    expect(await readFile(join(f.sourcePath, "保留.mp4"), "utf8")).toBe("preserve-original");
  });
  it("删除已配置来源不动文件，恢复保持暂停，新控制携带当前生命周期后才补扫", async () => {
    const f = await fixture(), draft = f.rules.configure(f.draft), p = f.preview(draft), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() }, f.grants); await f.pipeline.scan(source.id);
    const original = f.pipeline.list({}).items[0]!, command = { id: source.id, expectedVersion: 1, expectedDraftRevision: 1, expectedLifecycleRevision: 0, requestKey: randomUUID() };
    f.rules.lifecycle(command, "remove"); expect(f.rules.list()).toEqual([]); await expect(f.pipeline.scan(source.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await writeFile(join(f.sourcePath, "删除期间新增.mp4"), "新输入保留"); expect(f.pipeline.list({}).items).toHaveLength(1);
    const restored = f.rules.lifecycle({ ...command, expectedLifecycleRevision: 1, requestKey: randomUUID() }, "restore"); expect(restored).toMatchObject({ paused: true, version: 1, localSourceId: source.id, lifecycleRevision: 2 });
    expect(() => f.rules.control({ id: source.id, expectedVersion: 1, operation: "resume", requestKey: randomUUID() })).toThrow();
    f.rules.control({ id: source.id, expectedVersion: 1, expectedLifecycleRevision: 2, operation: "resume", requestKey: randomUUID() }); await f.pipeline.scan(source.id);
    expect(f.pipeline.list({}).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: original.id }), expect.objectContaining({ relativePath: "删除期间新增.mp4", state: "OBSERVING" })])); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
  });
  it("删除事务失败保留原来源、预览和暂停状态，重试同一请求可完成", async () => {
    const f = await fixture(), row = f.rules.configure(f.draft), p = f.preview(row), command = { id: row.id, expectedVersion: 0, expectedDraftRevision: 1, expectedLifecycleRevision: 0, requestKey: randomUUID() };
    f.db.connection.exec("CREATE TRIGGER remove_fault BEFORE INSERT ON source_rule_lifecycle_command BEGIN SELECT RAISE(ABORT,'受控删除记账故障'); END");
    expect(() => f.rules.lifecycle(command, "remove")).toThrow("受控删除记账故障"); expect(f.rules.get(row.id)).toMatchObject({ deletedAt: null, lifecycleRevision: 0 }); expect(f.rules.getPreview(p.id)?.state).toBe("READY");
    f.db.connection.exec("DROP TRIGGER remove_fault"); expect(f.rules.lifecycle(command, "remove").lifecycleRevision).toBe(1);
  });
  it("已删除来源不再占用输入范围，恢复前检查新接管来源，历史媒体目标仍被保护", async () => {
    const f = await fixture(), first = f.rules.configure(f.draft), p = f.preview(first), applied = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() }, f.grants);
    f.rules.lifecycle({ id: first.id, expectedVersion: 1, expectedDraftRevision: 1, expectedLifecycleRevision: 0, requestKey: randomUUID() }, "remove");
    const second = f.rules.configure({ ...f.draft, id: randomUUID(), requestKey: randomUUID() }), np = f.preview(second); await f.rules.apply({ previewId: np.id, requestKey: randomUUID() }, f.grants);
    expect(() => f.rules.lifecycle({ id: applied.id, expectedVersion: 1, expectedDraftRevision: 1, expectedLifecycleRevision: 1, requestKey: randomUUID() }, "restore")).toThrow("重叠"); expect(f.rules.get(applied.id)?.deletedAt).not.toBeNull(); expect(f.rules.get(second.id)?.paused).toBe(false);
    f.rules.lifecycle({ id: second.id, expectedVersion: 1, expectedDraftRevision: 1, expectedLifecycleRevision: 0, requestKey: randomUUID() }, "remove");
    const target = join(f.directory, "独立目标"); await mkdir(target); const unsafe = f.rules.configure({ ...f.draft, id: randomUUID(), requestKey: randomUUID(), configuration: { ...f.draft.configuration, type: "local", sourcePath: f.targetPath, organization: { targetPath: target } } }), up = f.preview(unsafe);
    await expect(f.rules.apply({ previewId: up.id, requestKey: randomUUID() }, { source: await grant(f.targetPath), target: await grant(target) })).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });
  it.each(["相同目录", "目标在来源内", "来源在目标内"])("真实目录授权拒绝%s，不创建执行配置或管理标记", async (relation) => {
    const f = await fixture(); let sourcePath = f.sourcePath, targetPath = f.targetPath, source = f.grants.source, target = f.grants.target;
    if (relation === "相同目录") { targetPath = sourcePath; target = await grant(targetPath); }
    if (relation === "目标在来源内") { targetPath = join(sourcePath, "内层媒体库"); await mkdir(targetPath); target = await grant(targetPath); }
    if (relation === "来源在目标内") { sourcePath = join(targetPath, "内层输入"); await mkdir(sourcePath); source = await grant(sourcePath); }
    const row = f.rules.configure({ ...f.draft, configuration: { ...f.draft.configuration, type: "local", sourcePath, organization: { targetPath } } }), preview = f.preview(row);
    await expect(f.rules.apply({ previewId: preview.id, requestKey: randomUUID() }, { source, target })).rejects.toMatchObject({ code: "UNSAFE_PATH", message: expect.stringContaining("不能相互包含") });
    expect(f.rules.get(row.id)).toMatchObject({ version: 0, paused: true, configuration: null });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_source").get()).toEqual({ n: 0 });
    expect((await readdir(targetPath)).includes(".media-marshal")).toBe(false);
    expect(await readFile(join(f.sourcePath, "保留.mp4"), "utf8")).toBe("preserve-original");
  });
  it.each(["相同输入", "子输入", "祖先输入", "目标在原输入内", "输入在原目标内"])("跨规则%s阻断并定位可信来源，原配置和媒体保持", async (relation) => {
    const f = await fixture(), first = f.rules.configure(f.draft), initial = f.preview(first); await f.rules.apply({ previewId: initial.id, requestKey: randomUUID() }, f.grants);
    let sourcePath = join(f.directory, "另一输入"), targetPath = join(f.directory, "另一媒体库");
    if (relation === "相同输入") sourcePath = f.sourcePath;
    if (relation === "子输入") sourcePath = join(f.sourcePath, "内层输入");
    if (relation === "祖先输入") { sourcePath = f.directory; targetPath = await realpath(await mkdtemp(join(tmpdir(), "marshal-independent-target-"))); const independent = targetPath; cleanup.push(() => rm(independent, { recursive: true, force: true })); }
    if (relation === "目标在原输入内") targetPath = join(f.sourcePath, "冲突目标");
    if (relation === "输入在原目标内") sourcePath = join(f.targetPath, "冲突输入");
    await mkdir(sourcePath, { recursive: true }); await mkdir(targetPath, { recursive: true });
    const row = f.rules.configure({ ...f.draft, id: randomUUID(), requestKey: randomUUID(), configuration: { ...f.draft.configuration, type: "local", name: "冲突来源", sourcePath, organization: { targetPath } } }), preview = f.preview(row);
    await expect(f.rules.apply({ previewId: preview.id, requestKey: randomUUID() }, { source: await grant(sourcePath), target: await grant(targetPath) })).rejects.toMatchObject({ code: "UNSAFE_PATH", message: expect.stringContaining("本地夸克来源"), directoryIssue: { conflict: { kind: "source", id: first.id } } });
    expect(f.rules.get(first.id)).toMatchObject({ version: 1, localSourceId: first.id }); expect(f.rules.get(row.id)).toMatchObject({ version: 0 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_source").get()).toEqual({ n: 1 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
    expect(await readFile(join(f.sourcePath, "保留.mp4"), "utf8")).toBe("preserve-original");
  });
  it("独立输入可复用同一个已授权媒体目标，不误判为重复接管来源", async () => {
    const f = await fixture(), first = f.rules.configure(f.draft), initial = f.preview(first); await f.rules.apply({ previewId: initial.id, requestKey: randomUUID() }, f.grants);
    const sourcePath = join(f.directory, "另一独立输入"); await mkdir(sourcePath);
    const second = f.rules.configure({ ...f.draft, id: randomUUID(), requestKey: randomUUID(), configuration: { ...f.draft.configuration, type: "local", sourcePath } }), preview = f.preview(second);
    await f.rules.apply({ previewId: preview.id, requestKey: randomUUID() }, { source: await grant(sourcePath), target: f.grants.target });
    expect(f.rules.list().filter((row) => row.version === 1)).toHaveLength(2); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_target_root").get()).toEqual({ n: 1 });
  });
  it("来源根符号链接不能冒充原生真实路径授权，不接管链接指向的文件", async () => {
    const f = await fixture(), alias = join(f.directory, "来源软链接"); await symlink(f.sourcePath, alias);
    const row = f.rules.configure({ ...f.draft, configuration: { ...f.draft.configuration, type: "local", sourcePath: alias } }), preview = f.preview(row);
    await expect(f.rules.apply({ previewId: preview.id, requestKey: randomUUID() }, { source: { ...f.grants.source, path: alias }, target: f.grants.target })).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
    expect(f.rules.get(row.id)).toMatchObject({ version: 0 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_source").get()).toEqual({ n: 0 });
    expect(await readFile(join(f.sourcePath, "保留.mp4"), "utf8")).toBe("preserve-original");
  });
  it("忽略规则存入来源版本，草稿编辑不改变扫描，确认后显式空列表才开放样片目录", async () => {
    const f = await fixture(); await mkdir(join(f.sourcePath, "Sample")); await writeFile(join(f.sourcePath, "Sample", "普通视频.mp4"), "保留样本");
    const original = f.rules.configure(f.draft), preview = f.preview(original); await f.rules.apply({ previewId: preview.id, requestKey: randomUUID() }, f.grants);
    await f.pipeline.scan(original.id); expect(f.pipeline.list({ sourceId: original.id }).items.some((row) => row.relativePath.startsWith("Sample/"))).toBe(false);
    const changed = f.rules.configure({ ...f.draft, expectedVersion: 1, expectedDraftRevision: 1, requestKey: randomUUID(), configuration: { ...f.draft.configuration, type: "local", ignoredFilePatterns: [] } });
    expect(f.rules.get(original.id)).toMatchObject({ draft: { ignoredFilePatterns: [] }, configuration: { name: "本地夸克来源" } });
    await f.pipeline.scan(original.id); expect(f.pipeline.list({ sourceId: original.id }).items.some((row) => row.relativePath.startsWith("Sample/"))).toBe(false);
    const next = f.preview(changed); await f.rules.apply({ previewId: next.id, requestKey: randomUUID() }, f.grants); await f.pipeline.scan(original.id);
    expect(f.rules.get(original.id)).toMatchObject({ version: 2, configuration: { ignoredFilePatterns: [] } });
    expect(f.pipeline.list({ sourceId: original.id }).items.find((row) => row.relativePath === "Sample/普通视频.mp4")).toMatchObject({ state: "OBSERVING", requiresConfirmation: true });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
    expect(await readFile(join(f.sourcePath, "Sample", "普通视频.mp4"), "utf8")).toBe("保留样本");
  });
  it.each(["baidu", "alipan"] as const)("新建不提供 %s 标签，旧标签的来源身份、草稿与暂停状态保持", async (client) => {
    const f = await fixture(), legacy = { ...f.draft.configuration, type: "local" as const, client };
    expect(() => f.rules.configure({ ...f.draft, configuration: legacy })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
    expect(f.rules.list()).toEqual([]);
    const original = f.rules.configure(f.draft);
    f.db.connection.prepare("UPDATE source_rule SET draft_json=? WHERE id=?").run(JSON.stringify(legacy), original.id);
    const restored = f.rules.configure({ ...f.draft, requestKey: randomUUID(), expectedDraftRevision: original.draftRevision, configuration: { ...legacy, name: "保留历史标签" } });
    expect(restored).toMatchObject({ id: original.id, paused: true, version: 0, draft: { type: "local", client, sourcePath: f.sourcePath } });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM cloud_account").get()).toEqual({ n: 0 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get()).toEqual({ n: 0 });
  });
  it("重复保存只保留一个草稿，不创建执行规则、订阅或媒体任务", async () => {
    const f = await fixture(), first = f.rules.configure(f.draft); expect(f.rules.configure(f.draft)).toEqual(first);
    expect(first).toMatchObject({ version: 0, draftRevision: 1, paused: true, configuration: null, localSourceId: null, subscriptionId: null });
    expect(f.rules.list()).toHaveLength(1);
    for (const table of ["desktop_source", "cloud_subscription", "download_job", "media_task"]) expect(f.db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(await readFile(join(f.sourcePath, "保留.mp4"), "utf8")).toBe("preserve-original");
    expect(() => f.rules.configure({ ...f.draft, requestKey: randomUUID() })).toThrow();
    expect(() => f.rules.configure({ ...f.draft, configuration: { ...f.draft.configuration, name: "其他内容" } })).toThrow();
  });
  it("旧入口定位已迁移身份，未归属历史可分页核对，新规则通过执行关联定位", async () => {
    const f = await fixture(), draft = f.rules.configure(f.draft), p = f.preview(draft);
    const source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() }, f.grants);
    expect(f.rules.resolveLegacy({ kind: "local-source", id: source.localSourceId! })).toEqual({ kind: "local-source", id: source.localSourceId, sourceId: source.id, status: "MAPPED", reason: "NONE" });
    const orphan = randomUUID(), historical = randomUUID();
    f.db.connection.prepare("INSERT INTO source_rule_legacy_reference VALUES('managed-binding',?,NULL,'REVIEW_REQUIRED','AMBIGUOUS_OWNERSHIP')").run(orphan);
    f.db.connection.prepare("INSERT INTO source_rule_legacy_reference VALUES('download-job',?,NULL,'HISTORICAL','NO_SOURCE')").run(historical);
    expect(f.rules.resolveLegacy({ kind: "managed-binding", id: orphan })).toMatchObject({ sourceId: null, status: "REVIEW_REQUIRED" });
    expect(f.rules.legacy({ status: "REVIEW_REQUIRED", page: 1, pageSize: 1 })).toMatchObject({ total: 1, items: [{ id: orphan }] });
    expect(f.rules.legacy({ page: 2, pageSize: 1 }).items).toHaveLength(1);
    expect(f.rules.resolveLegacy({ kind: "subscription", id: randomUUID() })).toBeNull();
  });
  it("授权后原子建立稳定关联，重复确认不增加版本；已启用配置不受新草稿影响", async () => {
    const f = await fixture(), draft = f.rules.configure(f.draft), preview = f.preview(draft), command = { previewId: preview.id, requestKey: randomUUID() };
    await expect(f.rules.apply(command)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const first = await f.rules.apply(command, f.grants); expect(await f.rules.apply(command, f.grants)).toEqual(first);
    expect(first).toMatchObject({ version: 1, localSourceId: first.id, paused: false, configuration: { type: "local", client: "quark" } });
    const second = f.rules.configure({ ...f.draft, expectedVersion: 1, expectedDraftRevision: 1, requestKey: randomUUID(), configuration: { ...f.draft.configuration, name: "草稿改名" } });
    expect(second).toMatchObject({ version: 1, draftRevision: 2, draft: { name: "草稿改名" }, configuration: { name: "本地夸克来源" } });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM source_rule_version").get()).toEqual({ n: 1 });
    expect(() => f.db.connection.prepare("UPDATE source_rule_version SET configuration_json='{}'").run()).toThrow(/不可修改/);
    expect(f.db.connection.prepare("SELECT name,version FROM desktop_source").get()).toEqual({ name: "本地夸克来源", version: 1 });
    const p = f.preview(second); await f.rules.apply({ previewId: p.id, requestKey: randomUUID() }, f.grants);
    expect(f.rules.get(first.id)).toMatchObject({ version: 2, configuration: { name: "草稿改名" } });
    expect(f.db.connection.prepare("SELECT source_version FROM ingestion_source").get()).toEqual({ source_version: 2 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
  });
  it("配置提交故障回滚所有执行关联，原预览可安全重试", async () => {
    const f = await fixture(), row = f.rules.configure(f.draft), p = f.preview(row), command = { previewId: p.id, requestKey: randomUUID() };
    f.db.connection.exec("CREATE TRIGGER source_config_fault BEFORE INSERT ON source_rule_version BEGIN SELECT RAISE(ABORT,'配置事务故障'); END");
    await expect(f.rules.apply(command, f.grants)).rejects.toThrow(/配置事务故障/);
    expect(f.rules.get(row.id)).toMatchObject({ version: 0, paused: true, localSourceId: null });
    for (const table of ["desktop_source", "ingestion_source", "source_rule_version"]) expect(f.db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(f.db.connection.prepare("SELECT id,available FROM media_target_root").get()).toEqual({ id: f.grants.target.id, available: 0 });
    expect(f.pipeline.targetGrant(f.targetPath)?.id).toBe(f.grants.target.id);
    expect(f.rules.getPreview(p.id)?.state).toBe("READY");
    f.db.connection.exec("DROP TRIGGER source_config_fault"); expect(await f.rules.apply(command, { ...f.grants, target: f.pipeline.targetGrant(f.targetPath)! })).toMatchObject({ version: 1 });
    expect(await readFile(join(f.sourcePath, "保留.mp4"), "utf8")).toBe("preserve-original");
  });
  it("异步授权期间保存新草稿会使旧预览失效，不提交部分配置", async () => {
    const f = await fixture(), row = f.rules.configure(f.draft), p = f.preview(row), original = f.pipeline.prepareRuleSource.bind(f.pipeline);
    vi.spyOn(f.pipeline, "prepareRuleSource").mockImplementationOnce(async (input) => {
      const prepared = await original(input);
      f.rules.configure({ ...f.draft, expectedDraftRevision: 1, requestKey: randomUUID(), configuration: { ...f.draft.configuration, name: "并发新草稿" } });
      return prepared;
    });
    await expect(f.rules.apply({ previewId: p.id, requestKey: randomUUID() }, f.grants)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.rules.get(row.id)).toMatchObject({ version: 0, draftRevision: 2 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM desktop_source").get()).toEqual({ n: 0 });
    expect(f.rules.getPreview(p.id)?.state).toBe("EXPIRED");
  });
  it("过期、授权目录变化及旧版本均不能启用来源，停写后拒绝新保存", async () => {
    const f = await fixture(), row = f.rules.configure(f.draft), p = f.preview(row);
    await expect(f.rules.apply({ previewId: p.id, requestKey: randomUUID() }, { ...f.grants, source: { ...f.grants.source, path: f.directory } })).rejects.toMatchObject({ code: "CONFLICT" });
    f.advance(15 * 60 * 1000); expect(f.rules.getPreview(p.id)?.state).toBe("EXPIRED");
    await expect(f.rules.apply({ previewId: p.id, requestKey: randomUUID() }, f.grants)).rejects.toMatchObject({ code: "CONFLICT" });
    f.rules.quiesce(); expect(() => f.rules.configure({ ...f.draft, expectedDraftRevision: 1, requestKey: randomUUID() })).toThrow();
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM desktop_source").get()).toEqual({ n: 0 });
  });
  it("活动 COPY 计划保留原快照，配置修改等安全点后才能提交", async () => {
    const f = await fixture(), draft = f.rules.configure(f.draft), p = f.preview(draft);
    const applied = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() }, f.grants);
    const candidateId = randomUUID(), taskId = randomUUID(), operationId = randomUUID(), stamp = new Date().toISOString(), originalPlan = JSON.stringify({ sourceId: applied.id, sourceVersion: 1, target: f.grants.target });
    f.db.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'PROCESSING',?,?)").run(taskId, applied.id, join(f.sourcePath, "保留.mp4"), stamp, stamp);
    f.db.connection.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,snapshot_json,state,task_id,created_at,updated_at) VALUES(?,?,'[\"保留.mp4\"]','fixture-version','{}','QUEUED',?,?,?)").run(candidateId, applied.id, taskId, stamp, stamp);
    f.db.connection.prepare("INSERT INTO ingestion_operation(id,candidate_id,task_id,request_key,target_root_id,target_slot,plan_json,attempt_id,phase,created_at,updated_at) VALUES(?,?,?,?,?,'fixture-slot',?,?,'COPYING',?,?)").run(operationId, candidateId, taskId, randomUUID(), f.grants.target.id, originalPlan, randomUUID(), stamp, stamp);
    const next = f.rules.configure({ ...f.draft, expectedVersion: 1, expectedDraftRevision: 1, requestKey: randomUUID(), configuration: { ...f.draft.configuration, name: "等待生效" } }), np = f.preview(next), command = { previewId: np.id, requestKey: randomUUID() };
    await expect(f.rules.apply(command, f.grants)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.rules.get(applied.id)?.version).toBe(1); expect(f.db.connection.prepare("SELECT plan_json,phase FROM ingestion_operation").get()).toEqual({ plan_json: originalPlan, phase: "COPYING" });
    f.db.connection.prepare("UPDATE ingestion_operation SET phase='RECORDED' WHERE id=?").run(operationId);
    expect(await f.rules.apply(command, f.grants)).toMatchObject({ version: 2 });
    expect(f.db.connection.prepare("SELECT plan_json FROM ingestion_operation").get()).toEqual({ plan_json: originalPlan });
  });
  it("来源暂停和全局整理暂停分别持久化，恢复来源不解除全局暂停", async () => {
    const f = await fixture(), draft = f.rules.configure(f.draft), p = f.preview(draft), source = await f.rules.apply({ previewId: p.id, requestKey: randomUUID() }, f.grants);
    const command = { id: source.id, expectedVersion: 1, operation: "pause" as const, requestKey: randomUUID() };
    expect(f.rules.control(command).paused).toBe(true); expect(f.rules.control(command).paused).toBe(true);
    expect(f.db.connection.prepare("SELECT paused FROM desktop_source").get()).toEqual({ paused: 1 });
    const pause = { paused: true, requestKey: randomUUID() };
    expect(f.pipeline.setPaused(pause)).toEqual({ paused: true }); expect(f.pipeline.setPaused(pause)).toEqual({ paused: true });
    expect(f.rules.control({ ...command, operation: "resume", requestKey: randomUUID() }).paused).toBe(false);
    expect(f.pipeline.pauseStatus()).toEqual({ paused: true });
    await expect(f.pipeline.scan(source.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(() => f.rules.control({ ...command, operation: "resume" })).toThrow();
    expect(f.pipeline.setPaused({ paused: false, requestKey: randomUUID() })).toEqual({ paused: false });
    await expect(f.pipeline.scan(source.id)).resolves.toMatchObject({ discovered: 1 });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
  });
  it("恢复本地来源立即请求受管补扫，暂停期间新增文件仍从观察开始", async () => {
    const f = await fixture(), draft = f.rules.configure(f.draft), preview = f.preview(draft), source = await f.rules.apply({ previewId: preview.id, requestKey: randomUUID() }, f.grants);
    f.rules.control({ id: source.id, expectedVersion: 1, operation: "pause", requestKey: randomUUID() }); await writeFile(join(f.sourcePath, "暂停期间新增.mp4"), "新文件保留");
    const scans = vi.spyOn(f.pipeline, "scan"); f.rules.control({ id: source.id, expectedVersion: 1, operation: "resume", requestKey: randomUUID() });
    expect(scans).toHaveBeenCalledWith(source.id); await Promise.all(scans.mock.results.map((result) => result.value));
    expect(f.pipeline.list({ sourceId: source.id }).items.find((row) => row.relativePath === "暂停期间新增.mp4")).toMatchObject({ state: "OBSERVING", requiresConfirmation: true }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 0 });
  });
});
