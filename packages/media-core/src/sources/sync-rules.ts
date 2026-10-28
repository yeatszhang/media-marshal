import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DesktopError, CloudError, cloudFailure, type CloudFailure, sourceConfigurationSchema, syncSourceRuleSchema, syncSourceConfigurationSchema, syncSourceSnapshotSchema, type CoreInput, type CoreOutput, type SyncSourceRule, type SyncSourceSnapshot } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { CloudDownloads } from "../cloud/downloads.js";
import type { ConfigurationDirectories } from "./configuration-directories.js";
import { LocalSync } from "./local-sync.js";
import { SyncReceipts } from "./sync-receipts.js";
import { assertDirectoryGraph } from "./directory-graph.js";
import { legacyConfigurationFingerprint, projectLegacyCloudSync } from "../infrastructure/independent-sync-migration.js";

interface Row { id: string; version: number; draft_revision: number; lifecycle_revision: number; draft_json: string; paused: number; deleted_at: string | null; review_json: string; created_at: string; updated_at: string }
interface Preview { id: string; source_id: string; request_key: string; version: number; draft_revision: number; lifecycle_revision: number; snapshot_json: string; download_preview_id: string | null; local_preview_id: string | null; mode: "configuration" | "execution"; force: number; rebind_default: number; default_dependency: number; state: string; expires_at: number }
interface Job { id: string; source_id: string; source_version: number; snapshot_json: string; request_key: string; preview_id: string | null; download_job_id: string | null; state: CoreOutput<"sync.jobs">["items"][number]["state"]; failure: string | null; created_at: string; updated_at: string }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message = "来源配置、目录或预览版本已变化，请刷新后重新预览") => new DesktopError("CONFLICT", message);

/** 新同步配置是唯一写入口；旧来源仅保留原版本、文件操作及历史追溯。 */
export class SyncRules {
  private closed = false; private timer?: ReturnType<typeof setInterval>; private flight?: Promise<void>; private queue: Promise<unknown> = Promise.resolve();
  private previews = new Map<string, { signature: string; promise: Promise<CoreOutput<"sync.preview">> }>();
  constructor(private readonly database: CoreDatabase, readonly directories: ConfigurationDirectories, private readonly downloads: CloudDownloads, readonly local: LocalSync, private readonly now = Date.now, private readonly legacyChanged?: () => void) {}
  private writable() { if (this.closed) throw new DesktopError("INTERRUPTED", "同步服务正在停止，请重新进入后查询原任务", true); }
  private row(id: string) { return this.database.connection.prepare("SELECT * FROM sync_source_rule WHERE id=?").get(id) as Row | undefined; }
  get(id: string): SyncSourceRule {
    const row = this.row(id); if (!row) throw conflict("同步来源不存在，请刷新来源列表");
    const active = row.version ? this.database.connection.prepare("SELECT snapshot_json FROM sync_source_version WHERE source_id=? AND version=?").get(id, row.version) as { snapshot_json: string } | undefined : undefined;
    const runtime = this.database.connection.prepare("SELECT claimed,edited,next_scan_at AS nextScanAt,failure FROM sync_runtime WHERE source_id=?").get(id) as { claimed: number; edited: number; nextScanAt: number | null; failure: string | null } | undefined;
    const legacy = !runtime?.claimed ? this.database.connection.prepare("SELECT draft_json,paused,deleted_at FROM source_rule WHERE id=?").get(id) as { draft_json: string; paused: number; deleted_at: string | null } | undefined : undefined;
    const fingerprint = this.database.connection.prepare("SELECT legacy_fingerprint FROM sync_runtime WHERE source_id=?").get(id) as { legacy_fingerprint: string | null } | undefined;
    let draft = JSON.parse(row.draft_json), review: string[] = JSON.parse(row.review_json);
    let failure = runtime?.failure ?? null;
    if (legacy && fingerprint?.legacy_fingerprint !== legacyConfigurationFingerprint(this.database.connection, id)) {
      if (!runtime?.edited) { const configuration = sourceConfigurationSchema.parse(JSON.parse(legacy.draft_json)); if (configuration.type === "cloud") draft = projectLegacyCloudSync(configuration); }
      failure = runtime?.edited ? "旧来源在独立草稿保存后变化；当前独立草稿仍保留，请核对旧配置后明确重新保存并完整预览接管" : "旧来源已有变化，下方显示当前旧草稿；请重新保存并完整预览后接管";
      review = [...new Set([...review, "LEGACY_SCOPE_REVIEW_REQUIRED"])];
    }
    return syncSourceRuleSchema.parse({ id: row.id, version: row.version, draftRevision: row.draft_revision, lifecycleRevision: row.lifecycle_revision, draft, snapshot: active ? JSON.parse(active.snapshot_json) : null, paused: legacy ? !!legacy.paused : !!row.paused, deletedAt: legacy ? legacy.deleted_at : row.deleted_at, reviewReasons: review, createdAt: row.created_at, updatedAt: row.updated_at, ...(runtime ? { runtime: { claimed: !!runtime.claimed, nextScanAt: runtime.nextScanAt, failure } } : {}) });
  }
  list(includeDeleted = false) { return (this.database.connection.prepare("SELECT id FROM sync_source_rule ORDER BY created_at,id LIMIT 1000").all() as { id: string }[]).map((row) => this.get(row.id)).filter((row) => includeDeleted || !row.deletedAt); }
  private previous<T>(key: string, signature: string): T | null {
    const row = this.database.connection.prepare("SELECT signature,result_json FROM configuration_command WHERE request_key=?").get(key) as { signature: string; result_json: string } | undefined;
    if (!row) return null; if (row.signature !== signature) throw conflict("该请求标识已经用于其他配置操作，请重新读取状态"); return JSON.parse(row.result_json) as T;
  }
  private receipt(key: string, signature: string, result: unknown) { this.database.connection.prepare("INSERT INTO configuration_command VALUES(?,?,?)").run(key, signature, JSON.stringify(result)); }
  private assertVersion(row: Row | undefined, input: { expectedVersion: number; expectedDraftRevision: number; expectedLifecycleRevision: number }, deleted = false) {
    if (!row || !deleted && row.deleted_at || row.version !== input.expectedVersion || row.draft_revision !== input.expectedDraftRevision || row.lifecycle_revision !== input.expectedLifecycleRevision) throw conflict();
  }
  save(input: CoreInput<"sync.save">): SyncSourceRule {
    this.writable(); const signature = hash({ operation: "sync.save", input }), db = this.database.connection;
    return db.transaction(() => {
      const previous = this.previous<SyncSourceRule>(input.requestKey, signature); if (previous) return previous;
      const row = this.row(input.id), configuration = syncSourceConfigurationSchema.parse(input.configuration), stamp = new Date(this.now()).toISOString();
      if (row) { this.assertVersion(row, input, true); if (this.get(row.id).deletedAt) throw conflict("来源已删除，请先恢复后再保存草稿"); if (syncSourceConfigurationSchema.parse(JSON.parse(row.draft_json)).type !== configuration.type) throw conflict("来源类型不能切换，请新建另一类型来源"); }
      else if (input.expectedVersion || input.expectedDraftRevision || input.expectedLifecycleRevision) throw conflict();
      if (!row && (db.prepare("SELECT count(*) AS n FROM sync_source_rule").get() as { n: number }).n >= 1000) throw conflict("同步来源超过一千项，请复用或调整现有来源");
      db.prepare("INSERT INTO sync_source_rule(id,version,draft_revision,lifecycle_revision,draft_json,paused,review_json,created_at,updated_at) VALUES(?,0,1,0,?,1,'[]',?,?) ON CONFLICT(id) DO UPDATE SET draft_revision=draft_revision+1,draft_json=excluded.draft_json,updated_at=excluded.updated_at").run(input.id, JSON.stringify(configuration), stamp, stamp);
      if (row && !this.get(row.id).runtime?.claimed) { const effective = this.get(row.id); db.prepare("UPDATE sync_source_rule SET paused=?,deleted_at=? WHERE id=?").run(Number(effective.paused), effective.deletedAt, row.id); }
      db.prepare("INSERT INTO sync_runtime(source_id,edited,legacy_fingerprint) VALUES(?,1,?) ON CONFLICT(source_id) DO UPDATE SET edited=1,legacy_fingerprint=CASE WHEN claimed=0 THEN excluded.legacy_fingerprint ELSE legacy_fingerprint END").run(input.id, legacyConfigurationFingerprint(db, input.id));
      db.prepare("UPDATE sync_configuration_preview SET state='EXPIRED' WHERE source_id=? AND state='READY'").run(input.id);
      const result = this.get(input.id); this.receipt(input.requestKey, signature, result); return result;
    })();
  }
  private assertLegacy(id: string) {
    const row = this.database.connection.prepare("SELECT claimed,legacy_fingerprint FROM sync_runtime WHERE source_id=?").get(id) as { claimed: number; legacy_fingerprint: string | null } | undefined;
    if (row && !row.claimed && row.legacy_fingerprint !== legacyConfigurationFingerprint(this.database.connection, id)) throw conflict("旧来源在迁移后已有变化，请重新读取当前范围、保存草稿并完整预览后接管");
    if (row && !row.claimed && this.database.connection.prepare("SELECT 1 FROM source_rule WHERE id=? AND deleted_at IS NOT NULL").get(id)) throw conflict("旧来源已删除，请先从旧配置入口恢复并保持暂停，再完整预览确认接管");
  }
  private snapshot(row: Row, mode: Preview["mode"]): SyncSourceSnapshot {
    if (mode === "execution") {
      if (!this.get(row.id).runtime?.claimed) throw conflict("升级后的来源需要先编辑并完整预览确认接管；可在旧配置入口暂停原来源，原任务和历史保留");
      const snapshot = this.get(row.id).snapshot;
      if (!snapshot || row.paused || row.deleted_at || JSON.parse(row.review_json).length) throw conflict("请先预览确认并恢复同步来源；执行不会使用未生效草稿");
      return syncSourceSnapshotSchema.parse({ ...snapshot, targetDirectory: this.directories.resolve({ kind: "default" }).directory, defaultDirectoryVersion: this.directories.defaults().version, configuration: { ...snapshot.configuration, target: { kind: "default" } } });
    }
    const configuration = syncSourceConfigurationSchema.parse(JSON.parse(row.draft_json));
    const target = this.directories.resolve(configuration.target);
    if (this.directories.kind(target.directory.id) !== "managed") throw conflict("同步 target 必须是受管下载根，请先通过原生目录选择授权");
    const input = configuration.type === "local" ? this.directories.binding(configuration.inputDirectoryId) : null;
    const legacy = !this.get(row.id).runtime?.claimed ? this.database.connection.prepare("SELECT version FROM source_rule WHERE id=?").get(row.id) as { version: number } | undefined : undefined;
    return syncSourceSnapshotSchema.parse({ sourceId: row.id, sourceVersion: Math.max(row.version, legacy?.version ?? 0) + 1, configuration, inputDirectory: input, targetDirectory: target.directory, defaultDirectoryVersion: target.defaultDirectoryVersion });
  }
  private async checkSnapshot(snapshot: SyncSourceSnapshot) {
    const target = this.directories.binding(snapshot.targetDirectory.id);
    if (JSON.stringify(target) !== JSON.stringify(snapshot.targetDirectory)) throw conflict("同步目标授权版本已变化，请重新预览");
    await this.directories.reader(target.id).check();
    if (snapshot.inputDirectory) {
      if (JSON.stringify(this.directories.binding(snapshot.inputDirectory.id)) !== JSON.stringify(snapshot.inputDirectory)) throw conflict("同步输入授权版本已变化，请重新预览");
      await this.directories.reader(snapshot.inputDirectory.id).check();
    }
    assertDirectoryGraph(this.database, "sync", snapshot);
  }
  preview(input: CoreInput<"sync.preview">): Promise<CoreOutput<"sync.preview">> {
    this.writable(); const signature = hash(input), existing = this.previews.get(input.requestKey);
    if (existing) { if (existing.signature !== signature) throw conflict("预览请求标识已用于不同范围"); return existing.promise; }
    const promise = this.buildPreview(input).finally(() => { this.previews.delete(input.requestKey); }); this.previews.set(input.requestKey, { signature, promise }); return promise;
  }
  private async buildPreview(input: CoreInput<"sync.preview">) {
    const db = this.database.connection, repeated = db.prepare("SELECT * FROM sync_configuration_preview WHERE request_key=?").get(input.requestKey) as Preview | undefined;
    if (repeated) { if (repeated.source_id !== input.id || repeated.version !== input.expectedVersion || repeated.draft_revision !== input.expectedDraftRevision || repeated.lifecycle_revision !== input.expectedLifecycleRevision || repeated.mode !== (input.mode ?? "configuration") || !!repeated.force !== !!input.force || !!repeated.rebind_default !== !!input.useCurrentDefault) throw conflict("请求标识已经用于其他预览"); return this.getPreview(repeated.id); }
    const row = this.row(input.id); this.assertVersion(row, input); this.assertLegacy(input.id);
    const mode = input.mode ?? "configuration"; if (input.force && mode !== "execution") throw conflict("显式重新同步需要从已生效来源预览执行，不改写配置");
    if (input.useCurrentDefault && (mode !== "configuration" || this.get(input.id).draft.target.kind !== "default")) throw conflict("只有默认 target 的配置预览可以显式重新绑定当前默认目录");
    const snapshot = this.snapshot(row!, mode), defaultDependency = snapshot.configuration.target.kind === "default"; await this.checkSnapshot(snapshot);
    const download = snapshot.configuration.type === "cloud" ? this.downloads.previews.start({ accountId: snapshot.configuration.accountId, remoteRef: snapshot.configuration.remoteRef, targetGrantId: snapshot.targetDirectory.id, requestKey: input.requestKey, layout: "drive", filters: { rules: snapshot.configuration.filters }, forceRedownload: input.force ?? false }) : null;
    const local = snapshot.configuration.type === "local" ? await this.local.create(snapshot, input.requestKey, input.force ?? false) : null;
    this.writable(); this.assertVersion(this.row(input.id), input); this.assertLegacy(input.id);
    if (defaultDependency && this.directories.defaults().version !== snapshot.defaultDirectoryVersion) throw conflict("默认下载目录已变化，请重新预览以核对实际目标");
    const id = randomUUID();
    db.prepare("INSERT INTO sync_configuration_preview(id,source_id,request_key,version,draft_revision,lifecycle_revision,snapshot_json,download_preview_id,local_preview_id,mode,force,rebind_default,default_dependency,state,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'READY',?)").run(id, input.id, input.requestKey, row!.version, row!.draft_revision, row!.lifecycle_revision, JSON.stringify(snapshot), download?.id ?? null, local?.id ?? null, mode, Number(!!input.force), Number(!!input.useCurrentDefault), Number(defaultDependency), this.now() + 15 * 60 * 1000);
    return this.getPreview(id);
  }
  private previewRow(id: string) { const row = this.database.connection.prepare("SELECT * FROM sync_configuration_preview WHERE id=?").get(id) as Preview | undefined; if (!row) throw conflict("同步预览不存在，请重新预览"); return row; }
  getPreview(id: string): CoreOutput<"sync.get-preview"> {
    const row = this.previewRow(id), current = this.row(row.source_id), snapshot = syncSourceSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    const cloudRow = row.download_preview_id ? this.downloads.previews.row(row.download_preview_id) : null, download = cloudRow ? this.downloads.previews.get(cloudRow.request_key) : null;
    const files = row.local_preview_id ? this.local.preview(row.local_preview_id).files : [];
    let failure: string | null = download?.failure?.message ?? null;
    if (snapshot.configuration.periodic.enabled && cloudRow && JSON.parse(cloudRow.snapshot_json).rootType === "file") failure = "文件范围不能启用周期扫描，请改为目录或关闭周期后重新预览";
    const observing = files.filter((file) => file.state === "OBSERVING").length, conflicts = download?.conflicts ?? files.filter((file) => ["CONFLICT", "UNAVAILABLE"].includes(file.state)).length;
    const expired = !current || !!current.deleted_at || current.version !== row.version || current.draft_revision !== row.draft_revision || current.lifecycle_revision !== row.lifecycle_revision || row.expires_at <= this.now() || row.state === "EXPIRED" || !!row.default_dependency && snapshot.defaultDirectoryVersion !== this.directories.defaults().version;
    const complete = download ? download.complete : !!row.local_preview_id;
    const state = row.state === "APPLIED" ? "APPLIED" : expired || download?.state === "EXPIRED" ? "EXPIRED" : download?.state === "BUILDING" ? "BUILDING" : failure || conflicts || !complete || row.mode === "execution" && observing ? "BLOCKED" : "READY";
    const job = this.database.connection.prepare("SELECT id FROM sync_job WHERE preview_id IN (?,?) ORDER BY created_at LIMIT 1").get(row.local_preview_id, row.download_preview_id) as { id: string } | undefined;
    return { id, sourceId: row.source_id, mode: row.mode, state, snapshot, expiresAt: row.expires_at, files: download?.files ?? files.length, bytes: download?.bytes ?? files.reduce((sum, file) => sum + file.size, 0), complete, observing, conflicts, reused: download?.reuseFiles ?? files.filter((file) => file.state === "REUSED").length, removed: download?.localRemovedFiles ?? files.filter((file) => file.state === "REMOVED").length, force: !!row.force, failure, download, jobId: job?.id ?? null };
  }
  previewFiles(input: CoreInput<"sync.preview-files">): CoreOutput<"sync.preview-files"> {
    const row = this.previewRow(input.id), snapshot = JSON.parse(row.snapshot_json) as SyncSourceSnapshot, size = input.pageSize ?? 25, start = ((input.page ?? 1) - 1) * size;
    if (row.local_preview_id) { const files = this.local.preview(row.local_preview_id).files; return { total: files.length, items: files.slice(start, start + size).map((file) => ({ relativePath: file.segments.join("/"), targetPath: join(snapshot.targetDirectory.path, "completed", ...file.targetSegments), size: file.size, state: file.state, reason: file.reason })) }; }
    const cloud = row.download_preview_id ? this.downloads.previews.row(row.download_preview_id) : null, files: { targetSegments: string[]; expectedSize: number; localRemoved?: boolean; receiptId?: string; reuseItemId?: string; issue?: { message: string } }[] = cloud ? JSON.parse(cloud.snapshot_json).items : [];
    return { total: files.length, items: files.slice(start, start + size).map((file) => ({ relativePath: file.targetSegments.join("/"), targetPath: join(snapshot.targetDirectory.path, "completed", ...file.targetSegments), size: file.expectedSize, state: file.issue ? "CONFLICT" : file.localRemoved ? "REMOVED" : file.receiptId || file.reuseItemId ? "REUSED" : "READY", reason: file.issue?.message ?? (file.localRemoved ? "已同步，本地已移除；普通执行不会补回" : null) })) };
  }
  confirm(input: CoreInput<"sync.confirm">): Promise<CoreOutput<"sync.confirm">> {
    const work = this.queue.catch(() => {}).then(() => this.confirmOnce(input)); this.queue = work; return work;
  }
  private async confirmOnce(input: CoreInput<"sync.confirm">): Promise<CoreOutput<"sync.confirm">> {
    this.writable(); const db = this.database.connection, signature = hash({ operation: "sync.confirm", input }), repeated = this.previous<CoreOutput<"sync.confirm">>(input.requestKey, signature); if (repeated) return repeated;
    const preview = this.getPreview(input.previewId), row = this.previewRow(input.previewId), owner = this.row(row.source_id)!;
    if (preview.state !== "READY") throw conflict(preview.failure ?? "同步预览未完成、已过期或存在逐项问题，请重新预览后确认");
    this.assertLegacy(owner.id); await this.checkSnapshot(preview.snapshot);
    const requestedExecution = row.mode === "execution" || !!input.runOnce, effectivePaused = this.get(owner.id).paused;
    if (requestedExecution && owner.version > 0 && effectivePaused) throw conflict("来源已暂停，请先恢复来源；确认配置不会解除已有暂停");
    const execute = requestedExecution || preview.snapshot.configuration.type === "cloud" && preview.snapshot.configuration.periodic.enabled && (!owner.version || !effectivePaused);
    const jobId = execute ? randomUUID() : null;
    const prepared = row.local_preview_id && jobId ? await this.local.confirm(row.local_preview_id, jobId, input.filesComplete === true) : null;
    const result = db.transaction(() => {
      this.writable(); const again = this.previous<CoreOutput<"sync.confirm">>(input.requestKey, signature); if (again) return again;
      if (this.getPreview(row.id).state !== "READY") throw conflict(); this.assertLegacy(owner.id); assertDirectoryGraph(this.database, "sync", preview.snapshot);
      if (row.download_preview_id) new SyncReceipts(this.database, this.now).confirmHistory(row.download_preview_id, input.requestKey, input.historyConsent?.accepted);
      else if (input.historyConsent) throw conflict("本地来源不接受网盘登录历史确认");
      const stamp = new Date(this.now()).toISOString();
      if (row.mode === "configuration") {
        db.prepare("INSERT INTO sync_source_version VALUES(?,?,?)").run(owner.id, preview.snapshot.sourceVersion, row.snapshot_json);
        db.prepare("UPDATE sync_source_rule SET version=?,paused=?,review_json='[]',updated_at=? WHERE id=?").run(preview.snapshot.sourceVersion, Number(owner.version > 0 && effectivePaused), stamp, owner.id);
        db.prepare("INSERT INTO sync_runtime(source_id,claimed,next_scan_at) VALUES(?,1,?) ON CONFLICT(source_id) DO UPDATE SET claimed=1,next_scan_at=excluded.next_scan_at,failure=NULL").run(owner.id, preview.snapshot.configuration.periodic.enabled ? this.now() + preview.snapshot.configuration.periodic.intervalSeconds * 1000 : null);
        this.retireLegacy(owner.id);
      }
      if (jobId) {
        db.prepare("INSERT INTO sync_job(id,source_id,source_version,snapshot_json,request_key,preview_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'PENDING',?,?)").run(jobId, owner.id, preview.snapshot.sourceVersion, row.snapshot_json, input.requestKey, row.local_preview_id ?? row.download_preview_id, stamp, stamp);
        prepared?.();
      }
      db.prepare("UPDATE sync_configuration_preview SET state=CASE WHEN id=? THEN 'APPLIED' ELSE 'EXPIRED' END WHERE source_id=? AND state='READY'").run(row.id, owner.id);
      const saved = { rule: this.get(owner.id), jobId }; this.receipt(input.requestKey, signature, saved); return saved;
    })();
    this.legacyChanged?.(); if (this.timer) void this.tick().catch(() => {}); return result;
  }
  private retireLegacy(id: string) {
    const db = this.database.connection;
    if (!db.prepare("SELECT 1 FROM source_rule WHERE id=?").get(id)) return;
    db.prepare("INSERT INTO legacy_configuration_owner(source_id,sync_claimed) VALUES(?,1) ON CONFLICT(source_id) DO UPDATE SET sync_claimed=1").run(id);
    db.prepare("UPDATE source_rule SET paused=1,review_required=1,lifecycle_revision=lifecycle_revision+1 WHERE id=?").run(id);
    db.prepare("UPDATE source_rule_preview SET state='EXPIRED' WHERE source_id=? AND state='READY'").run(id);
    db.prepare("UPDATE cloud_subscription SET enabled=0,next_scan_at=NULL WHERE id=(SELECT subscription_id FROM source_rule WHERE id=?)").run(id);
    db.prepare("UPDATE cloud_subscription_runtime SET state='PAUSED' WHERE subscription_id=(SELECT subscription_id FROM source_rule WHERE id=?)").run(id);
    db.prepare("UPDATE cloud_scan SET state='ABANDONED' WHERE subscription_id=(SELECT subscription_id FROM source_rule WHERE id=?) AND state='SCANNING'").run(id);
    db.prepare("INSERT OR IGNORE INTO source_rule_pause_job(source_id,job_id) SELECT ?,j.id FROM download_job j JOIN download_source_demand d ON d.job_id=j.id WHERE d.source_id=? AND j.state IN ('QUEUED','RUNNING','VERIFYING','COMMITTING','RETRY_WAIT')").run(id, id);
    db.prepare("UPDATE source_rule_run SET state='ABANDONED',updated_at=? WHERE source_id=? AND state IN ('QUEUED','SCANNING')").run(new Date(this.now()).toISOString(), id);
  }
  async control(input: CoreInput<"sync.control">): Promise<SyncSourceRule> {
    this.writable(); const db = this.database.connection, signature = hash({ operation: "sync.control", input }), previous = this.previous<SyncSourceRule>(input.requestKey, signature); if (previous) return previous;
    const row = this.row(input.id); this.assertVersion(row, input, true); const rule = this.get(input.id);
    if (!rule.runtime?.claimed && input.operation === "pause" && db.prepare("SELECT 1 FROM legacy_configuration_owner WHERE source_id=?").get(rule.id)) {
      if (rule.deletedAt) throw conflict("旧来源已删除，请先核对其恢复状态");
      const result = db.transaction(() => {
        this.writable(); this.assertVersion(this.row(input.id), input, true);
        const before = legacyConfigurationFingerprint(db, rule.id), runtime = db.prepare("SELECT legacy_fingerprint FROM sync_runtime WHERE source_id=?").get(rule.id) as { legacy_fingerprint: string | null };
        db.prepare("INSERT OR IGNORE INTO source_rule_pause_job(source_id,job_id) SELECT ?,j.id FROM download_job j JOIN download_source_demand d ON d.job_id=j.id JOIN source_rule r ON r.id=d.source_id AND r.version=d.source_version WHERE r.id=? AND (j.state IN ('QUEUED','RUNNING','VERIFYING','COMMITTING','RETRY_WAIT') OR EXISTS(SELECT 1 FROM cloud_global_pause_job p WHERE p.job_id=j.id))").run(rule.id, rule.id);
        db.prepare("UPDATE source_rule_execution_preview SET expires_at=0 WHERE source_id=? AND run_id IS NULL").run(rule.id);
        db.prepare("UPDATE source_rule SET paused=1,updated_at=? WHERE id=?").run(new Date(this.now()).toISOString(), rule.id);
        db.prepare("UPDATE sync_source_rule SET paused=1,lifecycle_revision=lifecycle_revision+1 WHERE id=?").run(rule.id);
        if (runtime.legacy_fingerprint === before) db.prepare("UPDATE sync_runtime SET legacy_fingerprint=? WHERE source_id=?").run(legacyConfigurationFingerprint(db, rule.id), rule.id);
        db.prepare("UPDATE sync_configuration_preview SET state='EXPIRED' WHERE source_id=? AND state='READY'").run(rule.id);
        const saved = this.get(rule.id); this.receipt(input.requestKey, signature, saved); return saved;
      })(); this.legacyChanged?.(); return result;
    }
    if (!rule.runtime?.claimed && db.prepare("SELECT 1 FROM legacy_configuration_owner WHERE source_id=?").get(rule.id)) throw conflict("请先完整预览确认接管此来源，或从旧配置入口控制原来源；不会同时修改两套有效配置");
    if (input.operation === "resume") {
      if (!rule.snapshot || rule.deletedAt || rule.reviewReasons.length) throw conflict("请先恢复、预览确认来源配置，再恢复同步");
      await this.checkSnapshot({ ...rule.snapshot, targetDirectory: this.directories.resolve({ kind: "default" }).directory, defaultDirectoryVersion: this.directories.defaults().version, configuration: { ...rule.snapshot.configuration, target: { kind: "default" } } });
    }
    if (input.operation === "remove" && (!rule.paused || this.local.hasActive(rule.id) || db.prepare("SELECT 1 FROM sync_job s JOIN download_job j ON j.id=s.download_job_id WHERE s.source_id=? AND j.state IN ('RUNNING','VERIFYING','COMMITTING','PAUSING','CANCELLING') LIMIT 1").get(rule.id))) throw conflict("请先暂停此来源并等待在途同步到达安全点，再删除；文件和历史会保留");
    const result = db.transaction(() => {
      this.writable(); this.assertVersion(this.row(input.id), input, true); const repeated = this.previous<SyncSourceRule>(input.requestKey, signature); if (repeated) return repeated;
      if (input.operation === "reset") {
        if (!rule.snapshot || rule.deletedAt) throw conflict("此来源没有可恢复的已生效配置，请保留或删除草稿");
        db.prepare("UPDATE sync_source_rule SET draft_json=?,draft_revision=draft_revision+1,updated_at=? WHERE id=?").run(JSON.stringify(rule.snapshot.configuration), new Date(this.now()).toISOString(), rule.id);
      } else {
        if (input.operation === "restore" ? !rule.deletedAt : !!rule.deletedAt) throw conflict(input.operation === "restore" ? "来源尚未删除，请刷新列表" : "来源已删除，请先恢复");
        db.prepare("UPDATE sync_source_rule SET paused=?,deleted_at=?,lifecycle_revision=lifecycle_revision+1,updated_at=? WHERE id=?").run(Number(input.operation !== "resume"), input.operation === "remove" ? new Date(this.now()).toISOString() : null, new Date(this.now()).toISOString(), rule.id);
        if (input.operation === "resume") db.prepare("UPDATE sync_runtime SET next_scan_at=? WHERE source_id=?").run(this.now(), rule.id);
      }
      db.prepare("UPDATE sync_configuration_preview SET state='EXPIRED' WHERE source_id=? AND state='READY'").run(rule.id);
      const saved = this.get(rule.id); this.receipt(input.requestKey, signature, saved); return saved;
    })();
    if (rule.snapshot?.configuration.type === "local") this.local.pauseChanged(rule.snapshot.configuration.inputDirectoryId, rule.id);
    for (const job of db.prepare("SELECT download_job_id FROM sync_job WHERE source_id=? AND download_job_id IS NOT NULL AND state IN ('PENDING','RUNNING')").all(rule.id) as { download_job_id: string }[]) {
      if (result.paused) this.downloads.control({ jobId: job.download_job_id, operation: "pause", requestKey: randomUUID() }, true);
      else if (this.downloads.pauseStatus().paused) db.prepare("INSERT OR IGNORE INTO cloud_global_pause_job(job_id,created_at) VALUES(?,?)").run(job.download_job_id, new Date(this.now()).toISOString());
      else this.downloads.control({ jobId: job.download_job_id, operation: "resume", requestKey: randomUUID() }, true);
    }
    return result;
  }
  private job(id: string) { const row = this.database.connection.prepare("SELECT * FROM sync_job WHERE id=?").get(id) as Job | undefined; if (!row) throw conflict("同步作业不存在，请刷新任务列表"); return row; }
  private jobDto(row: Job): CoreOutput<"sync.jobs">["items"][number] {
    const db = this.database.connection;
    const counts = db.prepare("SELECT count(*) AS files,sum(state='DONE') AS done,sum(state='REUSED') AS reused,sum(state='REMOVED') AS removed,sum(state='NEEDS_ATTENTION') AS failed FROM local_sync_member WHERE job_id=?").get(row.id) as { files: number; done: number | null; reused: number | null; removed: number | null; failed: number | null };
    const cloud = row.download_job_id ? this.downloads.get(row.download_job_id) : null;
    const failed = row.download_job_id ? (db.prepare("SELECT count(*) AS n FROM download_job_item j JOIN download_item i ON i.id=j.item_id WHERE j.job_id=? AND i.failure_code IS NOT NULL AND i.state IN ('FAILED','AUTH_REQUIRED','BLOCKED_LOCAL','RECONCILING')").get(row.download_job_id) as { n: number }).n : counts.failed ?? 0;
    const destination = (JSON.parse(row.snapshot_json) as SyncSourceSnapshot).targetDirectory.id, recognition = db.prepare("SELECT r.id,r.paused FROM recognition_input i JOIN recognition_rule r ON r.id=i.rule_id WHERE i.directory_id=? AND i.mode='managed-completed' AND i.active=1 AND r.deleted_at IS NULL LIMIT 1").get(destination) as { id: string; paused: number } | undefined;
    return { recognition: { state: !recognition ? "NOT_ENABLED" as const : recognition.paused ? "PAUSED" as const : "ENABLED" as const, ruleId: recognition?.id ?? null }, id: row.id, sourceId: row.source_id, sourceVersion: row.source_version, state: row.state, files: cloud?.progress.totalItems ?? counts.files, done: cloud?.progress.completedItems ?? counts.done ?? 0, reused: counts.reused ?? 0, removed: cloud?.localRemovedFiles ?? counts.removed ?? 0, failed, failure: row.failure ?? cloud?.failure?.message ?? null, downloadJobId: row.download_job_id, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  jobs(input: CoreInput<"sync.jobs">): CoreOutput<"sync.jobs"> {
    const db = this.database.connection, size = input.pageSize ?? 25, offset = ((input.page ?? 1) - 1) * size;
    const rows = db.prepare("SELECT * FROM sync_job WHERE ? IS NULL OR source_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?").all(input.sourceId ?? null, input.sourceId ?? null, size, offset) as Job[];
    return { items: rows.map((row) => this.jobDto(row)), total: (db.prepare("SELECT count(*) AS n FROM sync_job WHERE ? IS NULL OR source_id=?").get(input.sourceId ?? null, input.sourceId ?? null) as { n: number }).n };
  }
  getJob(id: string): CoreOutput<"sync.job"> { return this.jobDto(this.job(id)); }
  jobFiles(input: CoreInput<"sync.job-files">): CoreOutput<"sync.job-files"> {
    const row = this.job(input.id), snapshot = JSON.parse(row.snapshot_json) as SyncSourceSnapshot;
    if (row.download_job_id) {
      const cloud = row.preview_id ? this.downloads.previews.row(row.preview_id) : null;
      const files: { targetSegments: string[]; targetPathKey: string; expectedSize: number; receiptId?: string; reuseItemId?: string }[] = cloud ? JSON.parse(cloud.snapshot_json).items : [];
      const size = input.pageSize ?? 25, start = ((input.page ?? 1) - 1) * size;
      const item = this.database.connection.prepare("SELECT i.state,i.failure_code FROM download_job_item j JOIN download_item i ON i.id=j.item_id WHERE j.job_id=? AND i.target_path_key=?");
      return { total: files.length, items: files.slice(start, start + size).map((file) => {
        const value = item.get(row.download_job_id, file.targetPathKey) as { state: string; failure_code: CloudFailure["code"] | null } | undefined;
        const removed = file.receiptId ? !!this.database.connection.prepare("SELECT 1 FROM sync_receipt_local_state WHERE receipt_id=? AND state='REMOVED'").get(file.receiptId) : false;
        const failed = value?.failure_code && ["FAILED", "AUTH_REQUIRED", "BLOCKED_LOCAL", "RECONCILING"].includes(value.state);
        const state = removed ? "REMOVED" : failed ? "NEEDS_ATTENTION" : value?.state === "COMPLETED" ? file.receiptId || file.reuseItemId ? "REUSED" : "DONE" : !value && file.receiptId ? "REUSED" : "PENDING";
        return { relativePath: file.targetSegments.join("/"), targetPath: join(snapshot.targetDirectory.path, "completed", ...file.targetSegments), size: file.expectedSize, state, reason: failed ? cloudFailure(new CloudError(value!.failure_code!)).message : removed ? "已同步，本地已移除；普通执行不会补回" : null };
      }) };
    }
    const size = input.pageSize ?? 25, rows = this.database.connection.prepare("SELECT m.*,o.plan_json FROM local_sync_member m LEFT JOIN local_sync_operation o ON o.id=m.operation_id WHERE m.job_id=? ORDER BY m.ordinal LIMIT ? OFFSET ?").all(row.id, size, ((input.page ?? 1) - 1) * size) as { relative_path: string; state: "PENDING" | "REUSED" | "REMOVED" | "DONE" | "NEEDS_ATTENTION"; failure: string | null; plan_json: string | null; receipt_id: string | null }[];
    return { items: rows.map((file) => { const plan = file.plan_json ? JSON.parse(file.plan_json) : null, receipt = file.receipt_id ? new SyncReceipts(this.database).get(file.receipt_id) : null; return { relativePath: file.relative_path, targetPath: join(snapshot.targetDirectory.path, "completed", ...(plan?.targetSegments ?? JSON.parse(receipt?.target_segments_json ?? "[]"))), size: plan?.snapshot.size ?? receipt?.size ?? 0, state: file.state, reason: file.failure ?? (file.state === "REMOVED" ? "已同步，本地已移除；普通执行不会补回" : null) }; }), total: (this.database.connection.prepare("SELECT count(*) AS n FROM local_sync_member WHERE job_id=?").get(row.id) as { n: number }).n };
  }
  retry(input: CoreInput<"sync.retry">): CoreOutput<"sync.retry"> {
    this.writable(); const row = this.job(input.id), rule = this.get(row.source_id);
    if (rule.paused || rule.deletedAt) throw conflict("请先恢复来源，再重试原同步作业；全局暂停仍独立生效");
    const signature = hash({ operation: "sync.retry", input }), old = this.previous<CoreOutput<"sync.retry">>(input.requestKey, signature); if (old) return old;
    if (row.download_job_id) { this.downloads.control({ jobId: row.download_job_id, operation: "retry", requestKey: input.requestKey }); this.database.connection.prepare("UPDATE sync_job SET state='RUNNING',failure=NULL,updated_at=? WHERE id=?").run(new Date(this.now()).toISOString(), row.id); }
    else if ((JSON.parse(row.snapshot_json) as SyncSourceSnapshot).configuration.type === "local") this.local.retry(row.id);
    else throw conflict("该作业的远端预览未能提交，请从来源重新预览执行，原历史会保留");
    const result = this.jobDto(this.job(row.id)); this.receipt(input.requestKey, signature, result); return result;
  }
  start() { if (!this.closed && !this.timer) this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000); }
  tick(): Promise<void> { if (this.closed) return Promise.resolve(); return this.flight ??= this.run().finally(() => { this.flight = undefined; }); }
  private async run() {
    const db = this.database.connection;
    await this.local.tick();
    const jobs = db.prepare("SELECT j.* FROM sync_job j JOIN sync_source_rule r ON r.id=j.source_id WHERE (j.state IN ('PENDING','RUNNING') OR j.state='NEEDS_ATTENTION' AND j.download_job_id IS NOT NULL) AND r.paused=0 AND r.deleted_at IS NULL AND json_extract(j.snapshot_json,'$.configuration.type')='cloud' ORDER BY j.updated_at,j.id LIMIT 16").all() as Job[];
    for (const row of jobs) {
      if (this.closed) return;
      const snapshot = JSON.parse(row.snapshot_json) as SyncSourceSnapshot; if (snapshot.configuration.type !== "cloud") continue;
      const source = this.row(row.source_id); if (!source || source.paused || source.deleted_at) continue;
      try {
        if (!row.download_job_id) {
          if (this.downloads.pauseStatus().paused) continue;
          const result = await this.downloads.confirm({ previewId: row.preview_id!, requestKey: row.request_key }, { syncSourceId: row.source_id, syncSourceVersion: row.source_version, syncJobId: row.id });
          row.download_job_id = result.jobId;
          db.prepare("UPDATE sync_job SET download_job_id=?,state='RUNNING',failure=NULL,updated_at=? WHERE id=?").run(result.jobId, new Date(this.now()).toISOString(), row.id);
        }
        const download = this.downloads.get(row.download_job_id); if (!download) throw conflict("原下载作业已不存在，请查看历史后重新预览");
        const state = download.state === "COMPLETED" ? "DONE" : ["FAILED", "AUTH_REQUIRED", "BLOCKED_LOCAL"].includes(download.state) ? "NEEDS_ATTENTION" : ["CANCELLED", "CANCELLING"].includes(download.state) ? "CANCELED" : "RUNNING";
        db.prepare("UPDATE sync_job SET state=?,failure=?,updated_at=? WHERE id=?").run(state, download.failure?.message ?? null, new Date(this.now()).toISOString(), row.id);
      } catch (error) {
        const failure = error instanceof DesktopError ? error.message : error instanceof CloudError ? error.message : "同步范围或远端连接无法核对，请重新选择范围并预览；原成果保留";
        db.prepare("UPDATE sync_job SET state='NEEDS_ATTENTION',failure=?,updated_at=? WHERE id=?").run(failure, new Date(this.now()).toISOString(), row.id);
      }
    }
    // 周期只提交已明确授权的网盘范围；未知本地客户端的新文件留待完整性确认。
    const due = db.prepare("SELECT r.* FROM sync_source_rule r JOIN sync_runtime t ON t.source_id=r.id WHERE t.claimed=1 AND r.paused=0 AND r.deleted_at IS NULL AND t.next_scan_at<=? ORDER BY t.next_scan_at,r.id LIMIT 4").all(this.now()) as Row[];
    for (const row of due) {
      if (this.closed) return;
      const snapshot = this.get(row.id).snapshot; if (!snapshot?.configuration.periodic.enabled) { db.prepare("UPDATE sync_runtime SET next_scan_at=NULL WHERE source_id=?").run(row.id); continue; }
      db.prepare("UPDATE sync_runtime SET next_scan_at=? WHERE source_id=?").run(this.now() + snapshot.configuration.periodic.intervalSeconds * 1000, row.id);
      if (db.prepare("SELECT 1 FROM sync_job WHERE source_id=? AND state IN ('PENDING','RUNNING') LIMIT 1").get(row.id)) continue;
      try {
        const preview = await this.preview({ id: row.id, expectedVersion: row.version, expectedDraftRevision: row.draft_revision, expectedLifecycleRevision: row.lifecycle_revision, requestKey: randomUUID(), mode: "execution" });
        if (snapshot.configuration.type === "local") { db.prepare("UPDATE sync_runtime SET failure='本地新文件须核对完整性，请打开来源预览并确认后执行' WHERE source_id=?").run(row.id); continue; }
        db.prepare("INSERT INTO sync_periodic_preview(source_id,preview_id) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET preview_id=excluded.preview_id").run(row.id, preview.id);
      } catch (error) { db.prepare("UPDATE sync_runtime SET failure=? WHERE source_id=?").run(error instanceof Error ? error.message.slice(0, 500) : "周期扫描未完成，请重新预览来源", row.id); }
    }
    for (const row of db.prepare("SELECT * FROM sync_periodic_preview LIMIT 4").all() as { source_id: string; preview_id: string }[]) {
      if (this.closed) return;
      const source = this.row(row.source_id); if (!source || source.paused || source.deleted_at) continue;
      const preview = this.getPreview(row.preview_id);
      if (preview.state === "BUILDING") continue;
      try { if (preview.state !== "READY" || preview.download?.historyRestore && !preview.download.historyRestore.confirmed) throw conflict(preview.failure ?? "周期范围需要重新核对，请打开来源完整预览并确认"); await this.confirm({ previewId: row.preview_id, requestKey: row.preview_id }); }
      catch (error) { db.prepare("UPDATE sync_runtime SET failure=? WHERE source_id=?").run(error instanceof Error ? error.message.slice(0, 500) : "周期扫描未完成，请重新预览", row.source_id); }
      db.prepare("DELETE FROM sync_periodic_preview WHERE source_id=? AND preview_id=?").run(row.source_id, row.preview_id);
    }
  }
  quiesce() { this.closed = true; clearInterval(this.timer); }
  async close() { this.quiesce(); const local = this.local.close(); await Promise.allSettled([local, this.flight, this.queue, ...[...this.previews.values()].map((value) => value.promise)]); }
}
