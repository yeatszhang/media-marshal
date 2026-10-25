import { createHash, randomUUID } from "node:crypto";
import {
  DesktopError, sourceConfigurationSchema, sourceRuleDraftSchema, sourceRuleSchema,
  type CoreInput, type SourceRule, type SourceRulePreview, type SourceLegacyReference,
} from "@media-marshal/contracts";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { CloudDownloads } from "../cloud/downloads.js";
import type { CloudSubscriptions } from "../cloud/subscriptions.js";
import type { IngestionPipeline } from "../ingestion/pipeline.js";
import { SourceRuns } from "./runs.js";
import { organizationConflicts } from "./organization.js";
import { SourceExecutionPreviews } from "./executions.js";
import { SourceScans } from "./scans.js";
import { LocalSourceHealthChecks } from "./local-health.js";

interface Row {
  id: string; type: SourceRule["type"]; version: number; draft_revision: number; draft_json: string;
  paused: number; review_required: number; local_source_id: string | null; subscription_id: string | null;
  ingestion_source_id: string | null; created_at: string; updated_at: string;
  deleted_at: string | null; lifecycle_revision: number;
}
interface PreviewRow { id: string; source_id: string; version: number; draft_revision: number; lifecycle_revision: number; request_key: string; configuration_json: string; download_preview_id: string | null; state: "READY" | "APPLIED" | "EXPIRED"; expires_at: number }
export interface SourceRuleGrants { source: ManagedRootGrant; target: ManagedRootGrant }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message = "来源配置已变化，请刷新并重新预览") => new DesktopError("CONFLICT", message);

/** 草稿、预览和已启用版本分别持久化，执行服务只读取已确认的关联。 */
export class SourceRules {
  private queue: Promise<unknown> = Promise.resolve(); private accepting = true;
  readonly runs: SourceRuns;
  readonly executions: SourceExecutionPreviews;
  readonly localHealth: LocalSourceHealthChecks;
  readonly scans: SourceScans;
  constructor(private readonly database: CoreDatabase, private readonly downloads: CloudDownloads, private readonly subscriptions: CloudSubscriptions, private readonly ingestion: IngestionPipeline, private readonly now = Date.now) { this.runs = new SourceRuns(database, downloads, now); this.executions = new SourceExecutionPreviews(database, downloads, this.runs, now); this.localHealth = new LocalSourceHealthChecks(database, (id) => this.get(id), (id) => ingestion.localDirectoryHealth(id), now); this.scans = new SourceScans(database, (id) => this.scanScope(id), (id, requestedId) => this.scanForRule(requestedId, id), now); }
  start() { this.synchronize(); this.runs.start(); this.scans.start(); }
  synchronize() { for (const source of this.list(true)) { try { this.reconcile(source.id); } catch { /* 主机授权恢复后再次协调，不因离线阻止 Core 启动。 */ } } }
  quiesce() { this.accepting = false; this.runs.quiesce(); this.executions.quiesce(); this.localHealth.quiesce(); this.scans.quiesce(); }
  private writable() { if (!this.accepting) throw new DesktopError("INTERRUPTED", "来源配置正在停止", true); }
  private async scanForRule(sourceId: string, physicalId: string) {
    const source = this.get(sourceId), result = await this.ingestion.scan(physicalId);
    if (source?.configuration?.type !== "cloud") return result;
    const rows = this.database.connection.prepare("SELECT DISTINCT i.target_segments_json FROM download_source_demand d JOIN download_job j ON j.id=d.job_id JOIN download_job_item ji ON ji.job_id=j.id JOIN download_item i ON i.id=ji.item_id WHERE d.source_id=? AND d.source_version=? AND d.review_required=0 AND ji.demand_state='ACTIVE' AND j.state NOT IN ('CANCELLED','CANCELLING') AND i.target_root_id=? AND i.state='COMPLETED' LIMIT 10001").all(sourceId, source.version, source.configuration.downloadRootId) as { target_segments_json: string }[];
    const allowed = new Set(rows.map((row) => ["completed", ...JSON.parse(row.target_segments_json)].join("/"))), checkedPaths = result.checkedPaths.filter((path) => allowed.has(path));
    return { discovered: checkedPaths.length, checkedPaths, issues: result.issues.filter((issue) => allowed.has(issue.relativePath)) };
  }
  private scanScope(id: string) {
    const rule = this.get(id), physicalId = rule ? rule.localSourceId ?? rule.ingestionSourceId : id;
    if (rule && (rule.deletedAt || rule.reviewRequired || !rule.configuration?.organization || !physicalId)) throw conflict(`来源「${rule.configuration?.name ?? rule.draft.name}」已删除、未启用整理或需要核对，请在来源页重新预览确认`);
    const physical = this.ingestion.scanScope(physicalId!);
    return { physicalId: physicalId!, name: rule?.configuration?.name ?? physical.name, context: JSON.stringify([id, rule?.version ?? null, rule?.lifecycleRevision ?? null, physicalId, physical.version]), waiting: rule?.paused || physical.paused || this.ingestion.pauseStatus().paused ? "来源或全部整理已暂停；恢复后继续补扫，不解除其他暂停" : !physical.available ? "等待原磁盘与目录授权恢复；不接管同名替代目录" : null };
  }
  private row(id: string) { return this.database.connection.prepare("SELECT * FROM source_rule WHERE id=?").get(id) as Row | undefined; }
  get(id: string): SourceRule | null {
    const row = this.row(id); if (!row) return null;
    const active = row.version ? this.database.connection.prepare("SELECT configuration_json FROM source_rule_version WHERE source_id=? AND version=?").get(id, row.version) as { configuration_json: string } | undefined : undefined;
    const configuration = active ? sourceConfigurationSchema.parse(JSON.parse(active.configuration_json)) : null, draft = sourceConfigurationSchema.parse(JSON.parse(row.draft_json));
    const visible = configuration ?? draft;
    const remote = visible.type === "cloud" ? this.database.connection.prepare("SELECT name FROM remote_entry WHERE id=? AND account_id=?").get(visible.remoteRef, visible.accountId) as { name: string } | undefined : undefined;
    return sourceRuleSchema.parse({ id, type: row.type, version: row.version, draftRevision: row.draft_revision, draft, configuration, paused: !!row.paused, reviewRequired: !!row.review_required, deletedAt: row.deleted_at, lifecycleRevision: row.lifecycle_revision, localSourceId: row.local_source_id, subscriptionId: row.subscription_id, ingestionSourceId: row.ingestion_source_id, createdAt: row.created_at, updatedAt: row.updated_at, remoteName: remote?.name ?? null, lastRun: this.runs.list({ sourceId: id, pageSize: 1 }).items[0] ?? null });
  }
  list(includeDeleted = false) { return (this.database.connection.prepare("SELECT id FROM source_rule WHERE ?=1 OR deleted_at IS NULL ORDER BY created_at,id LIMIT 1000").all(Number(includeDeleted)) as { id: string }[]).map((row) => this.get(row.id)!); }
  private pauseIntent(source: SourceRule) {
    const db = this.database.connection;
    db.prepare("INSERT OR IGNORE INTO source_rule_pause_job(source_id,job_id) SELECT ?,j.id FROM download_job j JOIN download_source_demand d ON d.job_id=j.id WHERE d.source_id=? AND d.source_version=? AND (j.state IN ('QUEUED','RUNNING','VERIFYING','COMMITTING','RETRY_WAIT') OR EXISTS(SELECT 1 FROM cloud_global_pause_job p WHERE p.job_id=j.id))").run(source.id, source.id, source.version);
    db.prepare("UPDATE source_rule_execution_preview SET expires_at=0 WHERE source_id=? AND run_id IS NULL").run(source.id);
  }
  lifecycle(input: CoreInput<"source-rules.remove">, operation: "remove" | "restore"): SourceRule {
    this.writable(); const db = this.database.connection;
    const old = db.prepare("SELECT * FROM source_rule_lifecycle_command WHERE request_key=?").get(input.requestKey) as { source_id: string; version: number; draft_revision: number; lifecycle_revision: number; operation: string } | undefined;
    if (old) {
      if (old.source_id !== input.id || old.version !== input.expectedVersion || old.draft_revision !== input.expectedDraftRevision || old.lifecycle_revision !== input.expectedLifecycleRevision || old.operation !== operation) throw conflict("请求标识已用于其他来源删除或恢复");
      this.reconcile(input.id); return this.get(input.id)!;
    }
    const source = this.get(input.id), row = this.row(input.id);
    if (!source || !row || source.version !== input.expectedVersion || source.draftRevision !== input.expectedDraftRevision || source.lifecycleRevision !== input.expectedLifecycleRevision) throw conflict();
    if ((operation === "remove") === !!source.deletedAt) throw conflict(operation === "remove" ? "来源已经删除，请刷新列表" : "来源尚未删除，请刷新列表");
    const physical = source.localSourceId ?? source.ingestionSourceId;
    if (operation === "remove") {
      const job = db.prepare("SELECT j.id FROM download_job j JOIN download_source_demand d ON d.job_id=j.id WHERE d.source_id=? AND j.state IN ('RUNNING','VERIFYING','COMMITTING','PAUSING','CANCELLING') LIMIT 1").get(source.id) as { id: string } | undefined;
      if (job) throw conflict(`下载任务 ${job.id} 仍在运行或停止中，请先暂停来源并等待停止完成后再删除`);
      if (physical) this.ingestion.assertRuleRemovalSafe(source.id, physical);
    } else {
      if (source.configuration) {
        const conflicts = organizationConflicts(this.database, source.id, source.configuration);
        if (conflicts.length) throw conflict(`恢复来源与「${conflicts[0]!.name}」的整理范围冲突，请先调整该来源（关联来源：${conflicts[0]!.sourceId}）`);
      }
      if (source.localSourceId) this.ingestion.assertRuleRestoreSafe(source.localSourceId);
    }
    const stamp = new Date(this.now()).toISOString();
    db.transaction(() => {
      if (operation === "remove") this.pauseIntent(source);
      db.prepare("UPDATE source_rule SET deleted_at=?,paused=1,lifecycle_revision=lifecycle_revision+1,updated_at=? WHERE id=?").run(operation === "remove" ? stamp : null, stamp, source.id);
      db.prepare("UPDATE source_rule_preview SET state='EXPIRED' WHERE source_id=? AND state='READY'").run(source.id);
      db.prepare("UPDATE source_rule_execution_preview SET expires_at=0 WHERE source_id=? AND run_id IS NULL").run(source.id);
      if (operation === "remove") {
        db.prepare("UPDATE cloud_preview SET state='EXPIRED' WHERE id IN (SELECT download_preview_id FROM source_rule_preview WHERE source_id=?) AND NOT EXISTS(SELECT 1 FROM download_job j WHERE j.preview_id=cloud_preview.id)").run(source.id);
        db.prepare("UPDATE source_rule_run SET state=CASE WHEN EXISTS(SELECT 1 FROM download_job j WHERE j.preview_id=source_rule_run.preview_id) THEN 'SUBMITTED' ELSE 'ABANDONED' END,job_id=coalesce(job_id,(SELECT j.id FROM download_job j WHERE j.preview_id=source_rule_run.preview_id)),updated_at=? WHERE source_id=? AND state IN ('QUEUED','SCANNING')").run(stamp, source.id);
        if (source.localSourceId) db.prepare("UPDATE ingestion_content_review SET state='CANCELLED',failure='所属来源已删除；已完成复核结果保留',updated_at=? WHERE source_id=? AND state IN ('PENDING','RUNNING','WAITING_SOURCE')").run(stamp, source.localSourceId);
      }
      if (physical) db.prepare("UPDATE desktop_source SET paused=1 WHERE id=? AND NOT EXISTS(SELECT 1 FROM source_rule s WHERE (s.local_source_id=? OR s.ingestion_source_id=?) AND s.deleted_at IS NULL AND s.paused=0 AND s.review_required=0)").run(physical, physical, physical);
      db.prepare("INSERT INTO source_rule_lifecycle_command VALUES(?,?,?,?,?,?,?)").run(input.requestKey, source.id, source.version, source.draftRevision, source.lifecycleRevision, operation, stamp);
    })();
    this.reconcile(source.id);
    if (physical) { if (source.type === "local") this.ingestion.sourceChanged(physical); this.ingestion.syncSourceWatcher(physical); }
    return this.get(source.id)!;
  }
  control(input: CoreInput<"source-rules.control">): SourceRule {
    this.writable(); const db = this.database.connection;
    const prior = db.prepare("SELECT source_id,version,operation,lifecycle_revision FROM source_rule_control WHERE request_key=?").get(input.requestKey) as { source_id: string; version: number; operation: string; lifecycle_revision: number } | undefined;
    if (prior) {
      if (prior.source_id !== input.id || prior.version !== input.expectedVersion || prior.operation !== input.operation || prior.lifecycle_revision !== (input.expectedLifecycleRevision ?? 0)) throw conflict("请求标识已用于其他来源控制");
      this.reconcile(input.id); return this.get(input.id)!;
    }
    const source = this.get(input.id);
    if (!source || source.deletedAt || source.version !== input.expectedVersion || source.lifecycleRevision !== (input.expectedLifecycleRevision ?? 0)) throw conflict("来源或删除状态已变化，请刷新后操作");
    if (input.operation !== "pause" && (!source.configuration || source.reviewRequired)) throw conflict("来源尚未确认或需要核对，请重新预览确认");
    if (input.operation === "scan") {
      if (source.paused || source.configuration?.type !== "cloud" || !source.configuration.periodic.enabled || !source.subscriptionId) throw conflict("仅已启用周期扫描的网盘来源可立即扫描");
      db.transaction(() => {
        this.subscriptions.control({ subscriptionId: source.subscriptionId!, operation: "scan", requestKey: input.requestKey }, true);
        db.prepare("INSERT INTO source_rule_control VALUES(?,?,?,?,?,?)").run(input.requestKey, source.id, source.version, input.operation, new Date(this.now()).toISOString(), source.lifecycleRevision);
      })();
      return this.get(source.id)!;
    }
    if (input.operation === "resume" && db.prepare("SELECT 1 FROM source_rule_pause_job p JOIN download_job j ON j.id=p.job_id WHERE p.source_id=? AND j.state='PAUSING' LIMIT 1").get(source.id)) throw conflict("云端写入仍在停止，请到达安全点后恢复来源");
    db.transaction(() => {
      if (input.operation === "pause") this.pauseIntent(source);
      db.prepare("UPDATE source_rule SET paused=?,updated_at=? WHERE id=?").run(Number(input.operation === "pause"), new Date(this.now()).toISOString(), source.id);
      if (input.operation === "resume") db.prepare("UPDATE ingestion_outbox SET delivery_attempts=0,next_attempt_at=NULL WHERE state='PENDING' AND item_id IN (SELECT ji.item_id FROM download_job_item ji JOIN download_source_demand d ON d.job_id=ji.job_id WHERE d.source_id=? AND d.source_version=?)").run(source.id, source.version);
      db.prepare("INSERT INTO source_rule_control VALUES(?,?,?,?,?,?)").run(input.requestKey, source.id, source.version, input.operation, new Date(this.now()).toISOString(), source.lifecycleRevision);
    })();
    this.reconcile(source.id, input.operation === "resume"); return this.get(source.id)!;
  }
  /** 持久暂停意图先提交；启动和重复请求均按当前意图协调，不重放旧控制。 */
  private reconcile(id: string, rescan = false) {
    const source = this.get(id); if (!source || !source.configuration) return;
    const db = this.database.connection, blocked = !!source.deletedAt || source.paused || source.reviewRequired;
    if (source.subscriptionId) {
      const subscription = db.prepare("SELECT s.enabled,r.state FROM cloud_subscription s JOIN cloud_subscription_runtime r ON r.subscription_id=s.id WHERE s.id=?").get(source.subscriptionId) as { enabled: number; state: string } | undefined;
      const enabled = !blocked && source.configuration.type === "cloud" && source.configuration.periodic.enabled;
      if (subscription && subscription.state !== "CANCELLED" && !!subscription.enabled !== enabled) this.subscriptions.control({ subscriptionId: source.subscriptionId, operation: enabled ? "resume" : "pause", requestKey: randomUUID() }, true);
    }
    const physical = source.localSourceId ?? source.ingestionSourceId;
    if (physical) {
      const paused = source.type === "local" ? blocked : !db.prepare("SELECT 1 FROM source_rule WHERE ingestion_source_id=? AND paused=0 AND review_required=0 LIMIT 1").get(physical);
      const changed = db.prepare("UPDATE desktop_source SET paused=? WHERE id=? AND paused!=?").run(Number(paused), physical, Number(paused));
      if (source.type === "cloud") this.ingestion.sourceRuleChanged(physical); else if (changed.changes) this.ingestion.sourceChanged(physical);
      if (!blocked && !paused && (changed.changes || rescan)) void this.ingestion.scan(physical).catch(() => {});
    }
    const jobs = db.prepare("SELECT j.id,j.state,d.source_version FROM source_rule_pause_job p JOIN download_job j ON j.id=p.job_id JOIN download_source_demand d ON d.job_id=j.id WHERE p.source_id=?").all(id) as { id: string; state: string; source_version: number }[];
    for (const job of jobs) {
      if (blocked) {
        if (!["COMPLETED", "CANCELLED", "CANCELLING", "PAUSED", "PAUSING"].includes(job.state)) this.downloads.control({ jobId: job.id, operation: "pause", requestKey: randomUUID() }, true);
        continue;
      }
      if (job.source_version === source.version && job.state === "PAUSED") {
        if (this.downloads.pauseStatus().paused) db.prepare("INSERT OR IGNORE INTO cloud_global_pause_job VALUES(?,?)").run(job.id, new Date(this.now()).toISOString());
        else this.downloads.control({ jobId: job.id, operation: "resume", requestKey: randomUUID() }, true);
      }
      if (job.state !== "PAUSING") db.prepare("DELETE FROM source_rule_pause_job WHERE source_id=? AND job_id=?").run(id, job.id);
    }
  }
  resolveLegacy(input: CoreInput<"source-rules.resolve-legacy">): SourceLegacyReference | null {
    if (input.kind === "managed-binding") {
      const current = this.database.connection.prepare("SELECT id FROM source_rule WHERE ingestion_source_id=? ORDER BY id LIMIT 2").all(input.id) as { id: string }[];
      if (current.length) return { ...input, sourceId: current.length === 1 ? current[0]!.id : null, status: current.length === 1 ? "MAPPED" : "REVIEW_REQUIRED", reason: current.length === 1 ? "NONE" : "AMBIGUOUS_OWNERSHIP" };
    }
    const row = this.database.connection.prepare("SELECT kind,legacy_id AS id,source_id AS sourceId,status,reason FROM source_rule_legacy_reference WHERE kind=? AND legacy_id=?").get(input.kind, input.id) as SourceLegacyReference | undefined;
    if (row) return row;
    const db = this.database.connection;
    const owners = input.kind === "download-job" ? db.prepare("SELECT source_id AS id FROM download_source_demand WHERE job_id=?").all(input.id) as { id: string }[]
      : db.prepare(input.kind === "subscription" ? "SELECT id FROM source_rule WHERE subscription_id=? LIMIT 2" : input.kind === "managed-binding" ? "SELECT id FROM source_rule WHERE ingestion_source_id=? LIMIT 2" : "SELECT id FROM source_rule WHERE local_source_id=? LIMIT 2").all(input.id) as { id: string }[];
    return owners.length === 1 ? { ...input, sourceId: owners[0]!.id, status: "MAPPED", reason: "NONE" } : owners.length > 1 ? { ...input, sourceId: null, status: "REVIEW_REQUIRED", reason: "AMBIGUOUS_OWNERSHIP" } : null;
  }
  legacy(input: CoreInput<"source-rules.legacy">) {
    const db = this.database.connection;
    return { items: db.prepare("SELECT kind,legacy_id AS id,source_id AS sourceId,status,reason FROM source_rule_legacy_reference WHERE (? IS NULL OR status=?) ORDER BY kind,legacy_id LIMIT ? OFFSET ?").all(input.status ?? null, input.status ?? null, input.pageSize ?? 25, ((input.page ?? 1) - 1) * (input.pageSize ?? 25)) as SourceLegacyReference[], total: (db.prepare("SELECT count(*) AS n FROM source_rule_legacy_reference WHERE (? IS NULL OR status=?)").get(input.status ?? null, input.status ?? null) as { n: number }).n };
  }
  private previous(requestKey: string, signature: string) {
    const row = this.database.connection.prepare("SELECT source_id,signature FROM source_rule_command WHERE request_key=?").get(requestKey) as { source_id: string; signature: string } | undefined;
    if (row && row.signature !== signature) throw conflict("请求标识已经用于其他来源操作"); return row?.source_id;
  }
  private receipt(requestKey: string, sourceId: string, operation: "configure" | "apply", signature: string) {
    this.database.connection.prepare("INSERT INTO source_rule_command(request_key,source_id,signature,operation,created_at) VALUES(?,?,?,?,?)").run(requestKey, sourceId, signature, operation, new Date(this.now()).toISOString());
  }
  configure(value: CoreInput<"source-rules.configure">): SourceRule {
    this.writable(); const input = sourceRuleDraftSchema.parse(value), { expectedLifecycleRevision, ...original } = input, signature = hash({ operation: "configure", ...original, ...(expectedLifecycleRevision ? { expectedLifecycleRevision } : {}) }), db = this.database.connection;
    const previous = this.previous(input.requestKey, signature); if (previous) return this.get(previous)!;
    return db.transaction(() => {
      const row = this.row(input.id);
      if (row?.deleted_at || (row?.lifecycle_revision ?? 0) !== (input.expectedLifecycleRevision ?? 0)) throw conflict("来源的删除状态已变化，请重新打开来源配置");
      if (row ? row.version !== input.expectedVersion || row.draft_revision !== input.expectedDraftRevision || row.type !== input.configuration.type : input.expectedVersion !== 0 || input.expectedDraftRevision !== 0) throw conflict();
      if (input.configuration.type === "local" && !["quark", "custom"].includes(input.configuration.client)) {
        const previous = row ? sourceConfigurationSchema.parse(JSON.parse(row.draft_json)) : null;
        if (previous?.type !== "local" || previous.client !== input.configuration.client) throw new DesktopError("UNSUPPORTED_CAPABILITY", "新建本地来源仅提供夸克客户端或自定义目录；历史标签可原样保留");
      }
      if (!row && (db.prepare("SELECT count(*) AS n FROM source_rule").get() as { n: number }).n >= 1000) throw conflict("来源数量已达到上限");
      const stamp = new Date(this.now()).toISOString();
      db.prepare("INSERT INTO source_rule(id,type,draft_revision,draft_json,created_at,updated_at) VALUES(?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET draft_revision=draft_revision+1,draft_json=excluded.draft_json,updated_at=excluded.updated_at")
        .run(input.id, input.configuration.type, JSON.stringify(input.configuration), stamp, stamp);
      db.prepare("UPDATE source_rule_preview SET state='EXPIRED' WHERE source_id=? AND state='READY'").run(input.id);
      this.receipt(input.requestKey, input.id, "configure", signature);
      return this.get(input.id)!;
    })();
  }
  preview(input: CoreInput<"source-rules.preview">): SourceRulePreview {
    this.writable(); const row = this.row(input.id), db = this.database.connection;
    const repeated = db.prepare("SELECT * FROM source_rule_preview WHERE request_key=?").get(input.requestKey) as PreviewRow | undefined;
    if (repeated) {
      if (repeated.source_id !== input.id || repeated.version !== input.expectedVersion || repeated.draft_revision !== input.expectedDraftRevision || repeated.lifecycle_revision !== (input.expectedLifecycleRevision ?? 0)) throw conflict();
      return this.previewDto(repeated);
    }
    if (!row || row.deleted_at || row.lifecycle_revision !== (input.expectedLifecycleRevision ?? 0) || row.version !== input.expectedVersion || row.draft_revision !== input.expectedDraftRevision) throw conflict();
    const configuration = sourceConfigurationSchema.parse(JSON.parse(row.draft_json));
    const download = configuration.type === "cloud" ? this.downloads.previews.start({ accountId: configuration.accountId, remoteRef: configuration.remoteRef, targetGrantId: configuration.downloadRootId, requestKey: input.requestKey, filters: configuration.filters, layout: "drive" }) : null;
    const id = randomUUID();
    db.prepare("INSERT INTO source_rule_preview(id,source_id,version,draft_revision,request_key,configuration_json,download_preview_id,state,expires_at,created_at,lifecycle_revision) VALUES(?,?,?,?,?,?,?,'READY',?,?,?)")
      .run(id, row.id, row.version, row.draft_revision, input.requestKey, row.draft_json, download?.id ?? null, this.now() + 15 * 60 * 1000, new Date(this.now()).toISOString(), row.lifecycle_revision);
    return this.getPreview(id)!;
  }
  getPreview(id: string): SourceRulePreview | null {
    const row = this.database.connection.prepare("SELECT * FROM source_rule_preview WHERE id=?").get(id) as PreviewRow | undefined;
    return row ? this.previewDto(row) : null;
  }
  private previewDto(row: PreviewRow): SourceRulePreview {
    const source = this.row(row.source_id), configuration = sourceConfigurationSchema.parse(JSON.parse(row.configuration_json));
    const underlying = row.download_preview_id ? this.downloads.previews.row(row.download_preview_id) : undefined;
    const download = underlying ? this.downloads.previews.get(underlying.request_key) : null;
    const conflicts = row.state === "APPLIED" ? [] : organizationConflicts(this.database, row.source_id, configuration);
    const state = row.state === "APPLIED" ? "APPLIED" : row.expires_at <= this.now() || row.state === "EXPIRED" || source?.deleted_at || source?.lifecycle_revision !== row.lifecycle_revision || source?.version !== row.version || source.draft_revision !== row.draft_revision ? "EXPIRED" : conflicts.length ? "FAILED" : configuration.type === "cloud" ? download?.state === "BUILDING" ? "BUILDING" : download?.state === "READY" && download.complete && download.conflicts === 0 ? "READY" : "FAILED" : "READY";
    return { id: row.id, sourceId: row.source_id, version: row.version, draftRevision: row.draft_revision, lifecycleRevision: row.lifecycle_revision, configuration, state, expiresAt: row.expires_at, download, organizationConflicts: conflicts };
  }
  apply(input: CoreInput<"source-rules.apply">, grants?: SourceRuleGrants): Promise<SourceRule> {
    const task = this.queue.catch(() => {}).then(() => this.applyOnce(input, grants)); this.queue = task; return task;
  }
  private async applyOnce(input: CoreInput<"source-rules.apply">, grants?: SourceRuleGrants) {
    this.writable(); const signature = hash({ operation: "apply", previewId: input.previewId, requestKey: input.requestKey, ...(input.runOnce ? { runOnce: true } : {}) }), repeated = this.previous(input.requestKey, signature);
    if (repeated) return this.get(repeated)!;
    const preview = this.getPreview(input.previewId);
    if (!preview || !["READY", "APPLIED"].includes(preview.state)) throw conflict("来源预览未完成、已经过期或存在冲突，请重新预览");
    if (preview.state === "APPLIED") throw conflict("该来源预览已经确认，请查询已有配置");
    const configuration = preview.configuration, row = this.row(preview.sourceId)!;
    if (input.runOnce && (configuration.type !== "cloud" || configuration.periodic.enabled)) throw conflict("确认并执行一次仅适用于未启用周期扫描的网盘来源");
    const previousPhysical = row.local_source_id ?? row.ingestion_source_id;
    if (previousPhysical && this.database.connection.prepare("SELECT 1 FROM ingestion_operation o WHERE o.candidate_id IN (SELECT id FROM ingestion_candidate WHERE source_id=?) AND (o.phase NOT IN ('RECORDED','NEEDS_ATTENTION') OR EXISTS(SELECT 1 FROM ingestion_accessory a WHERE a.operation_id=o.id AND a.phase NOT IN ('RECORDED','NEEDS_ATTENTION'))) LIMIT 1").get(previousPhysical)) throw conflict("来源仍有活动整理，请等待当前文件到达安全点后重新确认");
    let prepared: Awaited<ReturnType<IngestionPipeline["prepareRuleSource"]>> | undefined;
    let physicalId: string | null = null;
    if (configuration.organization) {
      if (!grants || grants.target.path !== configuration.organization.targetPath) throw new DesktopError("FORBIDDEN", "请通过原生目录选择完成授权");
      const expectedSource = configuration.type === "local" ? configuration.sourcePath : (this.database.connection.prepare("SELECT canonical_path FROM managed_download_root WHERE id=?").get(configuration.downloadRootId) as { canonical_path: string } | undefined)?.canonical_path;
      if (!expectedSource || grants.source.path !== expectedSource) throw conflict("来源目录授权与预览不一致");
      if (configuration.type === "local") physicalId = row.local_source_id ?? row.id;
      else {
        const existing = this.database.connection.prepare("SELECT source_id,target_root_id FROM ingestion_source WHERE download_root_id=?").get(configuration.downloadRootId) as { source_id: string; target_root_id: string } | undefined;
        physicalId = existing?.source_id ?? randomUUID();
      }
      prepared = await this.ingestion.prepareRuleSource({ id: physicalId, name: configuration.name, client: configuration.type === "local" ? configuration.client : "custom", mediaType: configuration.organization.mediaType, source: grants.source, target: grants.target, downloadRootId: configuration.type === "cloud" ? configuration.downloadRootId : null });
    }
    let committed = false;
    let subscription: ReturnType<CloudSubscriptions["prepareSourceConfiguration"]> | undefined;
    try {
      this.writable();
      if (configuration.type === "cloud") {
        const legacySubscription = row.subscription_id ? null : this.database.connection.prepare("SELECT legacy_id FROM source_rule_legacy_reference WHERE kind='subscription' AND source_id=? LIMIT 1").get(row.id) as { legacy_id: string } | undefined;
        subscription = this.subscriptions.prepareSourceConfiguration({ configuration, previewId: preview.download!.id, previousSubscriptionId: row.subscription_id ?? legacySubscription?.legacy_id ?? null, version: preview.version + 1 });
      }
      this.database.connection.transaction(() => {
        this.writable(); const current = this.row(row.id), checked = this.getPreview(preview.id);
        if (!current || current.deleted_at || current.lifecycle_revision !== row.lifecycle_revision || current.version !== preview.version || current.draft_revision !== preview.draftRevision || current.paused !== row.paused || checked?.state !== "READY") throw conflict();
        const installed = prepared?.commit(), subscriptionId = subscription?.commit() ?? null, nextVersion = preview.version + 1, stamp = new Date(this.now()).toISOString();
        this.database.connection.prepare("INSERT INTO source_rule_version(source_id,version,configuration_json,local_source_id,subscription_id,ingestion_source_id,target_root_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(row.id, nextVersion, JSON.stringify(configuration), configuration.type === "local" ? physicalId : null, subscriptionId, configuration.type === "cloud" ? physicalId : null, installed?.targetRootId ?? null, stamp);
        this.database.connection.prepare("UPDATE source_rule SET version=?,paused=0,review_required=0,local_source_id=?,subscription_id=?,ingestion_source_id=?,updated_at=? WHERE id=?")
          .run(nextVersion, configuration.type === "local" ? physicalId : null, subscriptionId, configuration.type === "cloud" ? physicalId : null, stamp, row.id);
        this.database.connection.prepare("UPDATE source_rule_run SET state='ABANDONED',updated_at=? WHERE source_id=? AND source_version!=? AND state IN ('QUEUED','SCANNING')").run(stamp, row.id, nextVersion);
        this.database.connection.prepare("UPDATE source_rule_preview SET state=CASE WHEN id=? THEN 'APPLIED' ELSE 'EXPIRED' END WHERE source_id=? AND state='READY'").run(preview.id, row.id);
        this.receipt(input.requestKey, row.id, "apply", signature);
        if (input.runOnce) this.runs.enqueue({ id: row.id, expectedVersion: nextVersion, expectedLifecycleRevision: row.lifecycle_revision, requestKey: input.requestKey });
        this.database.connection.prepare("UPDATE source_rule_legacy_reference SET status='MAPPED',reason='NONE' WHERE source_id=? AND kind IN ('local-source','subscription')").run(row.id);
      })(); committed = true;
      await prepared?.activate(); subscription?.activate();
      const stale = this.database.connection.prepare("SELECT j.id FROM download_job j JOIN download_source_demand d ON d.job_id=j.id WHERE d.source_id=? AND d.source_version!=? AND j.state NOT IN ('COMPLETED','CANCELLED','CANCELLING')").all(row.id, preview.version + 1) as { id: string }[];
      for (const job of stale) this.downloads.control({ jobId: job.id, operation: "cancel", requestKey: randomUUID() });
      return this.get(row.id)!;
    } finally { if (!committed) await prepared?.discard(); }
  }
  async close() { this.quiesce(); await this.queue.catch(() => {}); await this.localHealth.close(); await this.scans.close(); await this.runs.close(); }
}
