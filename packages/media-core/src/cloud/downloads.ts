import { createHash, randomUUID } from "node:crypto";
import { CloudError, cloudFailure, type CloudFailure, type CloudInput, type DownloadJob, type DownloadState } from "@media-marshal/contracts";
import { transferPlanSchema, localFileEvidenceSchema, type ExecutionContext, type ExecutionHandle, type HostEvent, type TransferPlan } from "@media-marshal/contracts/internal";
import type { CoreHostGateway } from "@media-marshal/contracts/internal/rpc";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { CloudRoots } from "./roots.js";
import type { RemoteCatalog } from "./catalog.js";
import { DownloadPreviews, type PreviewSnapshot } from "./previews.js";
import { DownloadCommits } from "./commits.js";
import { acceptExecutionEvent } from "./planning.js";
import { SyncReceipts } from "../sources/sync-receipts.js";

interface Item { id: string; account_id: string; remote_ref: string; version_json: string; target_root_id: string; target_path_key: string; target_segments_json: string; expected_size: number; state: DownloadState; attempt_count: number }
interface Attempt { id: string; host_generation: string; core_generation: string; binding_generation: string; execution_id: string | null; state: string; plan_json: string }
interface Running { item: Item; context?: ExecutionContext; handle?: ExecutionHandle; stop: boolean; sequence: number; confirmedExit?: { exitCode: number; stopped: boolean }; failure?: CloudFailure; done?: Promise<void> }
export type DownloadOwner = { subscriptionId: string; configurationVersion: number; scanId: string } | { sourceId: string; sourceVersion: number; runId: string } | { syncSourceId: string; syncSourceVersion: number; syncJobId: string };
const activeStates = "'QUEUED','RUNNING','VERIFYING','COMMITTING','RETRY_WAIT','AUTH_REQUIRED','BLOCKED_LOCAL','RECONCILING'";
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const versionKey = (version: unknown) => createHash("sha256").update(JSON.stringify(version)).digest("hex");

/** 业务调度只依赖远端引用、宿主契约和文件提交组件，不解释具体传输协议。 */
export class CloudDownloads {
  readonly previews: DownloadPreviews;
  readonly commits: DownloadCommits;
  private active = new Map<string, Running>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false; private closed = false; private suspended = false;
  constructor(private readonly database: CoreDatabase, private readonly host: CoreHostGateway, private readonly catalog: RemoteCatalog, private readonly roots: CloudRoots, private readonly now = Date.now) {
    this.previews = new DownloadPreviews(database, catalog, roots, now); this.commits = new DownloadCommits(database, roots, catalog);
    database.connection.prepare("UPDATE download_item SET state='RECONCILING' WHERE state IN ('RUNNING','VERIFYING','COMMITTING','PAUSING','CANCELLING')").run();
    database.connection.prepare("UPDATE download_attempt SET state='UNCERTAIN' WHERE state IN ('CLAIMED','RUNNING','STOPPING')").run();
  }
  reconcileRestored() {
    const db = this.database.connection;
    db.transaction(() => {
      const items = db.prepare("SELECT id FROM download_item WHERE state='COMPLETED'").all() as { id: string }[];
      for (const item of items) {
        db.prepare("INSERT OR IGNORE INTO app_setting(key,value) VALUES(?, '')").run(`cloud.restore.audit.${item.id}`);
        db.prepare("UPDATE download_item SET state='RECONCILING',failure_code=NULL,updated_at=? WHERE id=? AND state='COMPLETED'").run(new Date(this.now()).toISOString(), item.id);
      }
    })(); this.aggregate();
  }
  private async auditRestored() {
    const db = this.database.connection, items = db.prepare("SELECT i.id,i.target_root_id,i.target_segments_json,c.file_evidence_json FROM download_item i JOIN app_setting s ON s.key='cloud.restore.audit.'||i.id LEFT JOIN download_commit_intent c ON c.item_id=i.id AND c.state='RECORDED' WHERE i.state='RECONCILING' ORDER BY s.value,i.id LIMIT 4").all() as (Item & { file_evidence_json: string | null })[];
    for (const item of items) {
      if (this.closed) break;
      try {
        const root = this.roots.files.get(item.target_root_id); await root.check();
        const receipts = new SyncReceipts(this.database, this.now), receipt = receipts.byResult("download-item", item.id);
        if (receipt) {
          const local = await receipts.observe(receipt, root);
          if (local === "REMOVED") {
            db.transaction(() => { this.state(item.id, "COMPLETED"); db.prepare("DELETE FROM app_setting WHERE key=?").run(`cloud.restore.audit.${item.id}`); })();
            continue;
          }
          if (local !== "PRESENT") throw new CloudError(local === "UNAVAILABLE" ? "LOCAL_UNAVAILABLE" : "CONFLICT");
        }
        if (!item.file_evidence_json) throw new CloudError("CONFLICT");
        const before = localFileEvidenceSchema.parse(JSON.parse(item.file_evidence_json));
        let after;
        try { after = await root.inspectCompleted(JSON.parse(item.target_segments_json)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CloudError("CONFLICT"); throw error; }
        if (before.volumeId !== after.volumeId || before.inode !== after.inode || before.birthtimeNs !== after.birthtimeNs || before.sha256 !== after.sha256 || before.size !== after.size) throw new CloudError("CONFLICT");
        db.transaction(() => {
          db.prepare("UPDATE download_commit_intent SET file_evidence_json=?,updated_at=? WHERE item_id=? AND state='RECORDED'").run(JSON.stringify(after), new Date(this.now()).toISOString(), item.id);
          this.state(item.id, "COMPLETED"); db.prepare("DELETE FROM app_setting WHERE key=?").run(`cloud.restore.audit.${item.id}`);
        })();
      } catch (error) {
        const failure = cloudFailure(error instanceof CloudError ? error : new CloudError(["EIO", "ENXIO", "ESTALE", "EBADF", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") ? "LOCAL_UNAVAILABLE" : "CONFLICT")); this.state(item.id, "RECONCILING", failure.code);
        if (failure.code === "LOCAL_UNAVAILABLE") db.prepare("UPDATE app_setting SET value=? WHERE key=?").run(new Date(this.now()).toISOString(), `cloud.restore.audit.${item.id}`);
        else db.prepare("DELETE FROM app_setting WHERE key=?").run(`cloud.restore.audit.${item.id}`);
      }
    }
  }
  quiesce() { this.suspended = true; }
  start() { if (!this.timer) this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 250); }
  async completedRoot(jobId: string) {
    const row = this.database.connection.prepare("SELECT i.target_root_id FROM download_item i JOIN download_job_item d ON d.item_id=i.id WHERE d.job_id=? AND i.state='COMPLETED' UNION SELECT r.target_directory_id AS target_root_id FROM download_job_receipt j JOIN sync_receipt r ON r.id=j.receipt_id WHERE j.job_id=? LIMIT 1").get(jobId, jobId) as { target_root_id: string } | undefined;
    if (!row) throw new CloudError("CONFLICT"); return this.roots.files.get(row.target_root_id).completedDirectory();
  }
  /** 只由 Main 完成 OS 回收后的新 Host 代际消息触发，不从超时或 UNKNOWN 推断停止。 */
  writersReaped(replacementHostGeneration: string) {
    this.database.connection.prepare("UPDATE download_attempt SET state='STOPPED',stopped_at=?,stop_evidence_json=? WHERE host_generation!=? AND state IN ('CLAIMED','RUNNING','STOPPING','UNCERTAIN')")
      .run(new Date(this.now()).toISOString(), JSON.stringify({ kind: "host-generation-reaped", replacementHostGeneration }), replacementHostGeneration);
  }
  async accountWritersStopped(accountId: string) {
    this.database.connection.prepare("UPDATE download_attempt SET state='STOPPED',stopped_at=?,stop_evidence_json=? WHERE account_id=? AND state IN ('CLAIMED','RUNNING','STOPPING','UNCERTAIN')").run(new Date(this.now()).toISOString(), JSON.stringify({ kind: "main-account-quiesced" }), accountId);
    const running = this.active.get(accountId); if (running) { running.failure = cloudFailure(new CloudError("INTERRUPTED")); await running.done?.catch(() => {}); }
  }
  retireAccountPlans(accountId: string) {
    const jobs = this.database.connection.prepare("SELECT id FROM download_job WHERE account_id=? AND state NOT IN ('COMPLETED','CANCELLED','CANCELLING')").all(accountId) as { id: string }[];
    for (const job of jobs) this.control({ jobId: job.id, operation: "cancel", requestKey: randomUUID() });
  }
  async wake() {
    const ready = new Set(this.catalog.accounts().filter((account) => account.status === "READY").map((account) => account.id));
    const rows = this.database.connection.prepare("SELECT id,account_id,remote_ref,target_root_id FROM download_item WHERE state IN ('AUTH_REQUIRED','BLOCKED_LOCAL') AND NOT EXISTS(SELECT 1 FROM download_claim c WHERE c.item_id=download_item.id)").all() as Item[];
    for (const item of rows) if (ready.has(item.account_id)) {
      try { this.catalog.source(item.account_id, item.remote_ref); await this.roots.files.get(item.target_root_id).check(); }
      catch { continue; }
      this.database.connection.prepare("UPDATE download_item SET state='QUEUED',failure_code=NULL WHERE id=? AND state IN ('AUTH_REQUIRED','BLOCKED_LOCAL')").run(item.id);
    }
  }
  pauseStatus() {
    const db = this.database.connection;
    return { paused: (db.prepare("SELECT value FROM app_setting WHERE key='cloud.downloads.paused'").get() as { value: string } | undefined)?.value === "true", pausing: !!db.prepare("SELECT 1 FROM cloud_global_pause_job p JOIN download_job j ON j.id=p.job_id WHERE j.state='PAUSING' LIMIT 1").get() };
  }
  setPaused(input: CloudInput<"cloud.downloads.set-paused">) {
    const db = this.database.connection, key = `cloud.pause.command.${input.requestKey}`, previous = db.prepare("SELECT value FROM app_setting WHERE key=?").get(key) as { value: string } | undefined;
    if (previous) { if (previous.value !== String(input.paused)) throw new CloudError("CONFLICT"); return this.pauseStatus(); }
    if (this.closed || (!input.paused && this.pauseStatus().pausing)) throw new CloudError("CONFLICT");
    db.transaction(() => {
      db.prepare("INSERT INTO app_setting(key,value) VALUES('cloud.downloads.paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(input.paused));
      if (input.paused) {
        const jobs = db.prepare("SELECT id FROM download_job WHERE state IN ('QUEUED','RUNNING','VERIFYING','COMMITTING','RETRY_WAIT')").all() as { id: string }[];
        for (const job of jobs) {
          db.prepare("INSERT OR IGNORE INTO cloud_global_pause_job(job_id,created_at) VALUES(?,?)").run(job.id, new Date(this.now()).toISOString());
          this.control({ jobId: job.id, operation: "pause", requestKey: randomUUID() }, true);
        }
      } else {
        const jobs = db.prepare("SELECT j.id FROM cloud_global_pause_job p JOIN download_job j ON j.id=p.job_id WHERE j.state='PAUSED'").all() as { id: string }[];
        for (const job of jobs) if (this.sourceEligible(job.id)) this.control({ jobId: job.id, operation: "resume", requestKey: randomUUID() }, true);
        db.prepare("DELETE FROM cloud_global_pause_job").run();
      }
      db.prepare("INSERT INTO app_setting(key,value) VALUES(?,?)").run(key, String(input.paused));
    })(); return this.pauseStatus();
  }
  private demands(itemId: string, excludeJob?: string): number {
    return (this.database.connection.prepare(`SELECT count(*) AS n FROM download_job_item d JOIN download_job j ON j.id=d.job_id LEFT JOIN download_source_demand o ON o.job_id=j.id LEFT JOIN source_rule s ON s.id=o.source_id LEFT JOIN sync_cloud_demand m ON m.job_id=j.id LEFT JOIN sync_source_rule r ON r.id=m.source_id WHERE d.item_id=? AND d.demand_state='ACTIVE' AND j.state IN (${activeStates}) AND (o.job_id IS NULL OR (s.version=o.source_version AND s.paused=0 AND s.review_required=0)) AND (m.job_id IS NULL OR (r.paused=0 AND r.deleted_at IS NULL)) AND (? IS NULL OR j.id!=?)`).get(itemId, excludeJob ?? null, excludeJob ?? null) as { n: number }).n;
  }
  sourceEligible(jobId: string) {
    return !this.database.connection.prepare("SELECT 1 FROM download_source_demand d JOIN source_rule s ON s.id=d.source_id WHERE d.job_id=? AND (s.version!=d.source_version OR s.paused=1 OR s.review_required=1) UNION SELECT 1 FROM sync_cloud_demand d JOIN sync_source_rule s ON s.id=d.source_id WHERE d.job_id=? AND (s.paused=1 OR s.deleted_at IS NOT NULL)").get(jobId, jobId);
  }
  sourceRuntimeReady(accountId: string, rootId: string) {
    if (!this.catalog.accounts().some((account) => account.id === accountId && ["READY", "RESELECT_REQUIRED"].includes(account.status))) return false;
    try { this.roots.files.get(rootId); return true; } catch { return false; }
  }
  private retainedDemand(itemId: string) { return !!this.database.connection.prepare("SELECT 1 FROM download_job_item d JOIN download_job j ON j.id=d.job_id WHERE d.item_id=? AND d.demand_state='ACTIVE' AND j.state NOT IN ('CANCELLED','CANCELLING') LIMIT 1").get(itemId); }
  private sourceSnapshot(previewId: string, owner?: DownloadOwner) {
    const db = this.database.connection;
    if (owner && "syncJobId" in owner) return undefined;
    if (owner && "sourceId" in owner) { const row = db.prepare("SELECT lifecycle_revision FROM source_rule WHERE id=?").get(owner.sourceId) as { lifecycle_revision: number } | undefined; return { source_id: owner.sourceId, source_version: owner.sourceVersion, source_lifecycle: row?.lifecycle_revision ?? 0 }; }
    if (owner) return db.prepare("SELECT id AS source_id,version AS source_version,lifecycle_revision AS source_lifecycle FROM source_rule WHERE subscription_id=?").get(owner.subscriptionId) as { source_id: string; source_version: number; source_lifecycle: number } | undefined;
    const preview = db.prepare("SELECT source_id,version+1 AS source_version,state FROM source_rule_preview WHERE download_preview_id=?").get(previewId) as { source_id: string; source_version: number; state: string } | undefined;
    if (preview && preview.state !== "APPLIED") throw new CloudError("CONFLICT");
    if (!preview) return undefined;
    const row = db.prepare("SELECT lifecycle_revision FROM source_rule WHERE id=?").get(preview.source_id) as { lifecycle_revision: number };
    return { ...preview, source_lifecycle: row.lifecycle_revision };
  }
  private assertSourceSnapshot(snapshot: { source_id: string; source_version: number; source_lifecycle: number } | undefined) {
    if (snapshot && !this.database.connection.prepare("SELECT 1 FROM source_rule WHERE id=? AND version=? AND lifecycle_revision=? AND deleted_at IS NULL AND paused=0 AND review_required=0").get(snapshot.source_id, snapshot.source_version, snapshot.source_lifecycle)) throw new CloudError("CONFLICT");
  }
  async confirm(input: CloudInput<"cloud.downloads.confirm">, owner?: DownloadOwner) {
    if (this.closed) throw new CloudError("INTERRUPTED");
    const subscriptionOwner = owner && "subscriptionId" in owner ? owner : undefined;
    const syncOwner = owner && "syncJobId" in owner ? owner : undefined;
    const assertSync = () => { if (syncOwner && !this.database.connection.prepare("SELECT 1 FROM sync_job j JOIN sync_source_rule r ON r.id=j.source_id WHERE j.id=? AND j.source_id=? AND j.source_version=? AND j.preview_id=? AND j.state IN ('PENDING','RUNNING') AND r.paused=0 AND r.deleted_at IS NULL").get(syncOwner.syncJobId, syncOwner.syncSourceId, syncOwner.syncSourceVersion, input.previewId)) throw new CloudError("INTERRUPTED"); };
    const db = this.database.connection, prior = db.prepare("SELECT id,preview_id FROM download_job WHERE request_key=?").get(input.requestKey) as { id: string; preview_id: string } | undefined;
    if (prior) { if (prior.preview_id !== input.previewId) throw new CloudError("CONFLICT"); return { jobId: prior.id }; }
    const preview = this.previews.row(input.previewId);
    if (!preview) throw new CloudError("REMOTE_NOT_FOUND");
    if (!owner && db.prepare("SELECT 1 FROM source_rule_execution_preview WHERE download_preview_id=?").get(preview.id)) throw new CloudError("CONFLICT");
    if (!owner && db.prepare("SELECT 1 FROM sync_configuration_preview WHERE download_preview_id=?").get(preview.id)) throw new CloudError("CONFLICT");
    const existing = db.prepare("SELECT id FROM download_job WHERE preview_id=?").get(preview.id) as { id: string } | undefined;
    if (existing) return { jobId: existing.id };
    const snapshot: PreviewSnapshot = JSON.parse(preview.snapshot_json);
    const source = this.sourceSnapshot(preview.id, owner); this.assertSourceSnapshot(source);
    assertSync();
    if (!(preview.state === "READY" || (owner && preview.state === "CONFIRMED")) || !snapshot.complete || snapshot.failure || !syncOwner && preview.expires_at <= new Date(this.now()).toISOString()) throw new CloudError("CONFLICT");
    if (!owner && db.prepare("SELECT 1 FROM cloud_subscription WHERE confirmed_preview_id=?").get(preview.id)) throw new CloudError("CONFLICT");
    if (this.catalog.source(preview.account_id, preview.remote_root_ref).binding.generation !== snapshot.binding.generation) throw new CloudError("REMOTE_CHANGED");
    const root = this.roots.files.get(preview.target_root_id); root.assertMappings(snapshot.items.map((item) => item.targetSegments));
    await this.roots.budget(preview.target_root_id, snapshot.items.reduce((sum, item) => sum + (!item.reuseItemId && !item.receiptId && !item.issue ? item.expectedSize : 0), 0));
    const id = randomUUID(), now = new Date(this.now()).toISOString();
    const jobId = db.transaction(() => {
      const repeated = db.prepare("SELECT id,preview_id FROM download_job WHERE request_key=? OR preview_id=?").get(input.requestKey, preview.id) as { id: string; preview_id: string } | undefined;
      if (repeated) { if (repeated.preview_id !== preview.id) throw new CloudError("CONFLICT"); return repeated.id; }
      if (this.closed || !syncOwner && preview.expires_at <= new Date(this.now()).toISOString()) throw new CloudError("CONFLICT");
      assertSync();
      this.assertSourceSnapshot(source);
      if (owner && "subscriptionId" in owner && !db.prepare("SELECT 1 FROM cloud_subscription s JOIN cloud_scan c ON c.subscription_id=s.id JOIN cloud_scan_plan p ON p.scan_id=c.id WHERE s.id=? AND s.enabled=1 AND s.configuration_version=? AND c.id=? AND c.configuration_version=s.configuration_version AND c.state='SCANNING' AND p.execution_preview_id=?").get(owner.subscriptionId, owner.configurationVersion, owner.scanId, preview.id)) throw new CloudError("INTERRUPTED");
      if (owner && "runId" in owner && !db.prepare("SELECT 1 FROM source_rule_run WHERE id=? AND source_id=? AND source_version=? AND state='SCANNING' AND preview_id=?").get(owner.runId, owner.sourceId, owner.sourceVersion, preview.id)) throw new CloudError("INTERRUPTED");
      db.prepare("INSERT INTO download_job(id,account_id,subscription_id,preview_id,request_key,state,configuration_version,created_at,updated_at) VALUES(?,?,?,?,?,'QUEUED',?,?,?)").run(id, preview.account_id, subscriptionOwner?.subscriptionId ?? null, preview.id, input.requestKey, subscriptionOwner?.configurationVersion ?? source?.source_version ?? 1, now, now);
      if (source) db.prepare("INSERT INTO download_source_demand(job_id,source_id,source_version) VALUES(?,?,?)").run(id, source.source_id, source.source_version);
      if (syncOwner) {
        db.prepare("INSERT INTO sync_cloud_demand VALUES(?,?,?,?)").run(id, syncOwner.syncJobId, syncOwner.syncSourceId, syncOwner.syncSourceVersion);
        db.prepare("UPDATE sync_job SET download_job_id=?,state='RUNNING',updated_at=? WHERE id=?").run(id, now, syncOwner.syncJobId);
      }
      for (const item of snapshot.items) {
        if (item.receiptId && !item.issue) {
          if (snapshot.variant || !item.source.expectedVersion) throw new CloudError("CONFLICT");
          const receipts = new SyncReceipts(this.database), receipt = receipts.findCloud(preview.account_id, item.source.remoteRef, item.source.expectedVersion, preview.target_root_id, item.targetPathKey, snapshot.binding.bindingId);
          if (!receipt || receipt.id !== item.receiptId) throw new CloudError("CONFLICT");
          const existingResult = db.prepare("SELECT id FROM download_item WHERE id=? AND account_id=? AND target_root_id=?").get(receipt.result_id, preview.account_id, preview.target_root_id);
          if (existingResult) {
            this.state(receipt.result_id, "COMPLETED"); db.prepare("DELETE FROM app_setting WHERE key=?").run(`cloud.restore.audit.${receipt.result_id}`);
            db.prepare("INSERT INTO download_job_item(job_id,item_id,account_id,demand_state) VALUES(?,?,?,'ACTIVE')").run(id, receipt.result_id, preview.account_id);
          } else db.prepare("INSERT INTO download_job_receipt VALUES(?,?)").run(id, receipt.id);
          continue;
        }
        const previous = db.prepare("SELECT id,state FROM download_item WHERE account_id=? AND remote_ref=? AND version_key=? AND request_variant=? AND target_root_id=? AND target_path_key=?").get(preview.account_id, item.source.remoteRef, item.versionKey, snapshot.variant ?? "", preview.target_root_id, item.targetPathKey) as { id: string; state: DownloadState } | undefined;
        const itemId = previous?.id ?? item.itemId;
        if (!previous) {
          db.prepare("INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,request_variant,target_root_id,target_path_key,target_segments_json,expected_size,state,failure_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(itemId, preview.account_id, item.source.remoteRef, item.versionKey, JSON.stringify(item.source.expectedVersion), snapshot.variant ?? "", preview.target_root_id, item.targetPathKey, JSON.stringify(item.targetSegments), item.expectedSize, item.issue ? "FAILED" : "QUEUED", item.issue?.code ?? null, now, now);
          db.prepare("INSERT INTO download_item_runtime(item_id) VALUES(?)").run(itemId);
        } else if (!item.issue && previous.state !== "COMPLETED" && !this.demands(itemId) && !db.prepare("SELECT 1 FROM download_claim WHERE item_id=?").get(itemId) && !db.prepare("SELECT 1 FROM download_commit_intent WHERE item_id=?").get(itemId)) {
          this.state(itemId, "QUEUED"); db.prepare("UPDATE download_item_runtime SET attempt_count=0,retry_after=NULL WHERE item_id=?").run(itemId);
        }
        db.prepare("INSERT INTO download_job_item(job_id,item_id,account_id,demand_state) VALUES(?,?,?,'ACTIVE')").run(id, itemId, preview.account_id);
      }
      db.prepare("UPDATE cloud_preview SET state='CONFIRMED' WHERE id=?").run(preview.id); return id;
    })();
    if (this.pauseStatus().paused) {
      db.prepare("INSERT OR IGNORE INTO cloud_global_pause_job(job_id,created_at) VALUES(?,?)").run(jobId, now);
      this.control({ jobId, operation: "pause", requestKey: randomUUID() }, true);
    }
    this.aggregate(); return { jobId };
  }
  control(input: CloudInput<"cloud.downloads.control">, global = false) {
    if (this.closed) throw new CloudError("INTERRUPTED");
    const db = this.database.connection;
    db.transaction(() => {
      const previous = db.prepare("SELECT job_id,operation FROM download_control WHERE request_key=?").get(input.requestKey) as { job_id: string; operation: string } | undefined;
      if (previous) { if (previous.job_id !== input.jobId || previous.operation !== input.operation) throw new CloudError("CONFLICT"); return; }
      if (!global && ["resume", "retry"].includes(input.operation) && this.pauseStatus().paused) throw new CloudError("CONFLICT");
      if (["resume", "retry"].includes(input.operation) && !this.sourceEligible(input.jobId)) throw new CloudError("CONFLICT");
      if (!global && ["pause", "cancel"].includes(input.operation)) db.prepare("DELETE FROM cloud_global_pause_job WHERE job_id=?").run(input.jobId);
      if (!global && ["pause", "cancel"].includes(input.operation)) db.prepare("DELETE FROM source_rule_pause_job WHERE job_id=?").run(input.jobId);
      const job = db.prepare("SELECT state FROM download_job WHERE id=?").get(input.jobId) as { state: DownloadState } | undefined;
      if (!job) throw new CloudError("REMOTE_NOT_FOUND");
      if (["PAUSING", "CANCELLING"].includes(job.state) && ["resume", "retry"].includes(input.operation)) throw new CloudError("CONFLICT");
      const items = db.prepare("SELECT i.* FROM download_item i JOIN download_job_item d ON d.item_id=i.id WHERE d.job_id=?").all(input.jobId) as Item[];
      if (input.operation === "pause" || input.operation === "cancel") {
        const cancel = input.operation === "cancel";
        if (job.state === "COMPLETED" || job.state === "CANCELLED") return;
        db.prepare("UPDATE download_job SET state=?,updated_at=? WHERE id=?").run(cancel ? "CANCELLING" : "PAUSING", new Date(this.now()).toISOString(), input.jobId);
        if (cancel) db.prepare("UPDATE download_job_item SET demand_state='CANCELLED' WHERE job_id=?").run(input.jobId);
        for (const item of items) if (item.state !== "COMPLETED" && !this.demands(item.id, input.jobId)) {
          const running = this.active.get(item.account_id);
          if (running?.item.id === item.id) { running.stop = true; if (item.state !== "COMMITTING") this.state(item.id, cancel ? "CANCELLING" : "PAUSING"); }
          else if (item.state !== "COMMITTING" && !db.prepare("SELECT 1 FROM download_claim WHERE item_id=?").get(item.id)) this.state(item.id, cancel ? "CANCELLED" : "PAUSED");
        }
      } else {
        if (!["PAUSED", "FAILED", "AUTH_REQUIRED", "BLOCKED_LOCAL", "RETRY_WAIT", "RECONCILING"].includes(job.state)) throw new CloudError("CONFLICT");
        for (const item of items) if (!["COMPLETED", "RUNNING", "VERIFYING", "COMMITTING"].includes(item.state)) {
          if (db.prepare("SELECT 1 FROM download_claim WHERE item_id=?").get(item.id) || db.prepare("SELECT 1 FROM download_commit_intent WHERE item_id=? AND state!='RECORDED'").get(item.id)) throw new CloudError("CONFLICT");
          this.state(item.id, "QUEUED"); db.prepare("UPDATE download_item_runtime SET attempt_count=0,retry_after=NULL WHERE item_id=?").run(item.id);
        }
        db.prepare("UPDATE download_job SET state='QUEUED',updated_at=? WHERE id=?").run(new Date(this.now()).toISOString(), input.jobId);
      }
      db.prepare("INSERT INTO download_control(request_key,job_id,operation,created_at) VALUES(?,?,?,?)").run(input.requestKey, input.jobId, input.operation, new Date(this.now()).toISOString());
    })();
    this.aggregate(); return { jobId: input.jobId };
  }
  private state(id: string, state: DownloadState, failure: string | null = null) { this.database.connection.prepare("UPDATE download_item SET state=?,failure_code=?,updated_at=? WHERE id=? AND state!='COMPLETED'").run(state, failure, new Date(this.now()).toISOString(), id); }
  private policy(itemId: string) {
    const row = this.database.connection.prepare("SELECT p.snapshot_json FROM download_job_item d JOIN download_job j ON j.id=d.job_id JOIN cloud_preview p ON p.id=j.preview_id WHERE d.item_id=? ORDER BY j.created_at,j.id LIMIT 1").get(itemId) as { snapshot_json: string };
    return (JSON.parse(row.snapshot_json) as PreviewSnapshot).policy;
  }
  private fail(item: Item, error: unknown) {
    const failure = cloudFailure(error), policy = this.policy(item.id), attempts = (this.database.connection.prepare("SELECT attempt_count FROM download_item_runtime WHERE item_id=?").get(item.id) as { attempt_count: number }).attempt_count;
    let state: DownloadState = failure.code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : failure.code === "LOCAL_UNAVAILABLE" ? "BLOCKED_LOCAL" : "FAILED";
    if (failure.retryable && attempts < policy.maxAttempts) {
      state = "RETRY_WAIT";
      const milliseconds = Math.max((failure.retryAfterSeconds ?? 0) * 1000, Math.min(policy.retryBaseMs * 2 ** Math.max(0, attempts - 1), 60000));
      const until = new Date(this.now() + milliseconds).toISOString();
      this.database.connection.prepare("UPDATE download_item_runtime SET retry_after=? WHERE item_id=?").run(until, item.id);
    }
    if (failure.code === "RATE_LIMITED") this.database.connection.prepare("INSERT INTO cloud_account_backoff(account_id,until_at) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET until_at=max(until_at,excluded.until_at)").run(item.account_id, new Date(this.now() + Math.max(1000, (failure.retryAfterSeconds ?? 1) * 1000)).toISOString());
    if (failure.code === "AUTH_REQUIRED") this.database.connection.prepare("UPDATE cloud_account SET status='AUTH_REQUIRED',updated_at=? WHERE id=?").run(new Date(this.now()).toISOString(), item.account_id);
    this.state(item.id, state, failure.code);
  }
  private aggregate() {
    const db = this.database.connection, jobs = db.prepare("SELECT id,state FROM download_job WHERE state!='CANCELLED'").all() as { id: string; state: DownloadState }[];
    for (const job of jobs) {
      const items = db.prepare("SELECT i.id,i.account_id,i.state FROM download_item i JOIN download_job_item d ON d.item_id=i.id WHERE d.job_id=?").all(job.id) as Item[];
      const pending = items.filter((item) => item.state !== "COMPLETED"); let next: DownloadState;
      if (job.state === "CANCELLING" || job.state === "PAUSING") {
        const waiting = pending.some((item) => item.state === "COMMITTING" || (!this.demands(item.id, job.id) && (this.active.get(item.account_id)?.item.id === item.id || !!db.prepare("SELECT 1 FROM download_claim WHERE item_id=?").get(item.id))));
        next = waiting ? job.state : job.state === "CANCELLING" ? "CANCELLED" : pending.length ? "PAUSED" : "COMPLETED";
      } else if (!pending.length) next = "COMPLETED";
      else if (job.state === "PAUSED") continue;
      else next = (["COMMITTING", "VERIFYING", "RUNNING", "RECONCILING", "QUEUED", "RETRY_WAIT", "AUTH_REQUIRED", "BLOCKED_LOCAL", "FAILED", "PAUSED", "CANCELLED"] as DownloadState[]).find((state) => pending.some((item) => item.state === state)) ?? "FAILED";
      if (job.state !== next) db.prepare("UPDATE download_job SET state=?,updated_at=? WHERE id=?").run(next, new Date(this.now()).toISOString(), job.id);
    }
  }
  get(id: string) { return this.list({ page: 1, pageSize: 1 }, id).items[0] ?? null; }
  list(input: CloudInput<"cloud.downloads.list">, id?: string) {
    if (!id) this.aggregate(); const db = this.database.connection;
    const rows = db.prepare("SELECT j.*,p.snapshot_json FROM download_job j JOIN cloud_preview p ON p.id=j.preview_id WHERE ? IS NULL OR j.id=? ORDER BY j.created_at DESC,j.id LIMIT ? OFFSET ?").all(id ?? null, id ?? null, input.pageSize ?? 25, ((input.page ?? 1) - 1) * (input.pageSize ?? 25)) as { id: string; account_id: string; state: DownloadState; updated_at: string; snapshot_json: string }[];
    const items: DownloadJob[] = rows.map((job) => {
      const values = db.prepare("SELECT i.state,i.expected_size,i.failure_code,r.bytes,r.speed,r.total_bytes FROM download_job_item d JOIN download_item i ON i.id=d.item_id JOIN download_item_runtime r ON r.item_id=i.id WHERE d.job_id=?").all(job.id) as { state: DownloadState; expected_size: number; failure_code: CloudFailure["code"] | null; bytes: number; speed: number; total_bytes: number | null }[];
      const historical = db.prepare("SELECT r.size FROM download_job_receipt j JOIN sync_receipt r ON r.id=j.receipt_id WHERE j.job_id=?").all(job.id) as { size: number }[];
      const historicalBytes = historical.reduce((sum, receipt) => sum + receipt.size, 0);
      const localRemovedFiles = (db.prepare("SELECT count(*) AS n FROM sync_receipt_local_state s WHERE s.state='REMOVED' AND s.receipt_id IN (SELECT r.id FROM sync_receipt r JOIN download_job_item j ON r.result_kind='download-item' AND r.result_id=j.item_id WHERE j.job_id=? UNION SELECT receipt_id FROM download_job_receipt WHERE job_id=?)").get(job.id, job.id) as { n: number }).n;
      const total = values.reduce((sum, item) => sum + item.expected_size, historicalBytes), bytes = values.reduce((sum, item) => sum + (item.state === "COMPLETED" ? item.expected_size : ["RUNNING", "VERIFYING", "COMMITTING"].includes(item.state) ? item.bytes : 0), historicalBytes), failed = values.find((item) => item.failure_code);
      const totalUnknown = bytes > total || values.some((item) => item.state === "RUNNING" && item.total_bytes === null);
      const stages = db.prepare("SELECT o.state AS outbox_state,c.state AS candidate_state,t.status,t.delivery_status FROM download_job_item d JOIN download_item i ON i.id=d.item_id LEFT JOIN ingestion_outbox o ON o.item_id=i.id AND o.version_key=i.version_key LEFT JOIN ingestion_candidate c ON c.managed_item_id=i.id AND c.managed_version_key=i.version_key LEFT JOIN media_task t ON t.id=c.task_id WHERE d.job_id=? AND i.state='COMPLETED'").all(job.id) as { outbox_state: string | null; candidate_state: string | null; status: string | null; delivery_status: string | null }[];
      const owner = db.prepare("SELECT d.source_id,d.source_version,d.review_required,s.review_required AS source_review,json_extract(v.configuration_json,'$.organization') AS organization FROM download_source_demand d JOIN source_rule_version v ON v.source_id=d.source_id AND v.version=d.source_version JOIN source_rule s ON s.id=d.source_id WHERE d.job_id=?").get(job.id) as { source_id: string; source_version: number; review_required: number; source_review: number; organization: string | null } | undefined;
      const syncOwner = db.prepare("SELECT source_id,source_version FROM sync_cloud_demand WHERE job_id=?").get(job.id) as { source_id: string; source_version: number } | undefined;
      const organization = syncOwner ? "NOT_ENABLED" : !owner ? "UNASSIGNED" : owner.review_required || owner.source_review ? "REVIEW_REQUIRED" : owner.organization ? "ENABLED" : "NOT_ENABLED";
      const visible = organization === "NOT_ENABLED" ? [] : stages;
      const ingestion = { organization, pending: visible.filter((row) => row.outbox_state !== "ACKNOWLEDGED").length, candidates: visible.filter((row) => row.candidate_state !== null).length, organized: visible.filter((row) => row.status === "DONE").length, collected: visible.filter((row) => row.delivery_status === "COLLECTED").length, needsAttention: visible.filter((row) => row.status === "FAILED" || row.delivery_status === "NEEDS_ATTENTION").length } as NonNullable<DownloadJob["ingestion"]>;
      return { id: job.id, accountId: job.account_id, sourceId: syncOwner?.source_id ?? owner?.source_id ?? null, sourceVersion: syncOwner?.source_version ?? owner?.source_version ?? null, name: (JSON.parse(job.snapshot_json) as PreviewSnapshot).name, state: job.state, updatedAt: job.updated_at, failure: failed ? cloudFailure(new CloudError(failed.failure_code!)) : null, ingestion, ...(localRemovedFiles ? { localRemovedFiles } : {}), progress: { bytes, totalBytes: totalUnknown ? null : total, bytesPerSecond: values.reduce((sum, item) => sum + (item.state === "RUNNING" ? item.speed : 0), 0), completedItems: values.filter((item) => item.state === "COMPLETED").length + historical.length, totalItems: values.length + historical.length } };
    });
    return { items, total: (db.prepare("SELECT count(*) AS n FROM download_job").get() as { n: number }).n };
  }
  private async tick() {
    if (this.ticking || this.closed) return; this.ticking = true;
    try {
      await this.auditRestored(); await this.reconcile();
      const db = this.database.connection, now = new Date(this.now()).toISOString();
      db.prepare("UPDATE download_item SET state='QUEUED' WHERE state='RETRY_WAIT' AND id IN (SELECT item_id FROM download_item_runtime WHERE retry_after<=?)").run(now);
      const ready = new Set(this.catalog.accounts().filter((account) => account.status === "READY" || account.status === "RESELECT_REQUIRED").map((account) => account.id));
      if (this.suspended || this.pauseStatus().paused) { this.aggregate(); return; }
      const candidates = db.prepare("SELECT i.*,r.attempt_count FROM download_item i JOIN download_item_runtime r ON r.item_id=i.id WHERE i.state='QUEUED' AND NOT EXISTS(SELECT 1 FROM download_claim c WHERE c.item_id=i.id) AND NOT EXISTS(SELECT 1 FROM download_attempt a WHERE a.account_id=i.account_id AND a.state IN ('CLAIMED','RUNNING','STOPPING','UNCERTAIN')) AND NOT EXISTS(SELECT 1 FROM cloud_account_backoff b WHERE b.account_id=i.account_id AND b.until_at>?) ORDER BY i.created_at,i.id LIMIT 100").all(now) as Item[];
      for (const item of candidates) {
        if (this.closed || this.suspended || this.pauseStatus().paused || this.active.size >= 4) break;
        if (this.active.has(item.account_id) || !ready.has(item.account_id) || !this.demands(item.id)) continue;
        const running: Running = { item, stop: false, sequence: 0 }; this.active.set(item.account_id, running);
        running.done = this.run(running).finally(() => { this.active.delete(item.account_id); this.aggregate(); }); void running.done.catch(() => {});
      }
      this.aggregate();
    } finally { this.ticking = false; }
  }
  private async run(running: Running) {
    const { item } = running, db = this.database.connection; let claimed = false, stopped = false, unobserve: (() => void) | undefined;
    db.prepare("UPDATE download_item_runtime SET attempt_count=attempt_count+1,bytes=0,speed=0,total_bytes=NULL,sequence=0 WHERE item_id=?").run(item.id);
    try {
      await this.roots.budget(item.target_root_id, item.expected_size);
      const root = this.roots.files.get(item.target_root_id), segments: string[] = JSON.parse(item.target_segments_json);
      await root.assertVacant(segments);
      const metadata = await this.catalog.stat(item.account_id, item.remote_ref), expectedVersion = JSON.parse(item.version_json);
      const observedVersion = metadata.version ?? { kind: "weak", size: metadata.size, modifiedAt: metadata.modifiedAt };
      if (metadata.type !== "file" || metadata.size !== item.expected_size || versionKey(observedVersion) !== versionKey(expectedVersion)) throw new CloudError("REMOTE_CHANGED");
      if (this.suspended) { db.prepare("UPDATE download_item_runtime SET attempt_count=max(0,attempt_count-1) WHERE item_id=?").run(item.id); return; }
      if (running.stop || this.closed || this.pauseStatus().paused || !this.demands(item.id)) { if (!this.closed) this.state(item.id, this.retainedDemand(item.id) ? "PAUSED" : "CANCELLED"); return; }
      const source = this.catalog.source(item.account_id, item.remote_ref), attemptId = randomUUID(), context = this.host.context(source.binding.generation, attemptId);
      const plan = transferPlanSchema.parse({ attemptId, targetGrantId: item.target_root_id, items: [{ itemId: item.id, source: { ...source, expectedVersion }, targetSegments: segments, expectedSize: item.expected_size }] }); running.context = context;
      db.transaction(() => {
        if ((db.prepare("SELECT state FROM download_item WHERE id=?").get(item.id) as Item).state !== "QUEUED") throw new CloudError("CONFLICT");
        db.prepare("INSERT INTO download_attempt(id,account_id,binding_id,core_generation,binding_generation,host_generation,idempotency_key,staging_key,state,plan_json,retries,created_at) VALUES(?,?,?,?,?,?,?,?,'CLAIMED',?,?,?)")
          .run(attemptId, item.account_id, source.binding.bindingId, context.coreGeneration, context.bindingGeneration, context.hostGeneration, attemptId, attemptId, JSON.stringify({ plan, policy: this.policy(item.id) }), item.attempt_count, new Date(this.now()).toISOString());
        db.prepare("INSERT INTO download_claim(item_id,attempt_id,account_id,target_root_id,target_path_key,ordinal) VALUES(?,?,?,?,?,0)").run(item.id, attemptId, item.account_id, item.target_root_id, item.target_path_key);
        db.prepare("INSERT INTO download_attempt_item(attempt_id,item_id) VALUES(?,?)").run(attemptId, item.id); this.state(item.id, "RUNNING");
      })(); claimed = true;
      const handle = await this.host.request("transfer.start", plan, context, attemptId); running.handle = handle;
      db.prepare("UPDATE download_attempt SET state='RUNNING',execution_id=? WHERE id=? AND state='CLAIMED'").run(handle.executionId, attemptId);
      unobserve = this.host.observe?.(handle, context, (event) => this.event(running, event));
      let exitCode = -1;
      for (;;) {
        const proven = db.prepare("SELECT state FROM download_attempt WHERE id=?").get(attemptId) as { state: string };
        if (proven.state === "STOPPED") { stopped = true; break; }
        if (running.confirmedExit) { exitCode = running.confirmedExit.exitCode; stopped = true; break; }
        await this.roots.files.get(item.target_root_id).check();
        if (running.stop || this.closed || !this.demands(item.id)) {
          await this.host.request("transfer.stop", handle, context, randomUUID()); stopped = true; break;
        }
        const status = await this.host.request("transfer.status", { attemptId }, context, randomUUID());
        if (status.state === "EXITED" || status.state === "STOPPED") { exitCode = status.exitCode ?? -1; stopped = true; break; }
        if (status.state === "UNKNOWN" || status.state === "UNCERTAIN") throw new CloudError("COMPONENT_UNAVAILABLE");
        await delay(250);
      }
      db.prepare("UPDATE download_attempt SET state=?,exit_code=?,stopped_at=?,stop_evidence_json=? WHERE id=?").run(running.stop || this.closed ? "STOPPED" : "EXITED", exitCode, new Date(this.now()).toISOString(), JSON.stringify({ kind: "host-confirmed", executionId: handle.executionId, hostGeneration: context.hostGeneration }), attemptId);
      if (running.stop || this.closed || !this.demands(item.id)) { this.state(item.id, this.closed ? "QUEUED" : this.retainedDemand(item.id) ? "PAUSED" : "CANCELLED"); return; }
      this.state(item.id, "VERIFYING");
      try { await this.commits.verifyAndCommit(attemptId, item.target_root_id, plan.items[0]!); }
      catch (error) {
        if (running.stop && !db.prepare("SELECT 1 FROM download_commit_intent WHERE item_id=?").get(item.id)) { this.state(item.id, "PAUSED"); return; }
        if (!db.prepare("SELECT 1 FROM download_commit_intent WHERE item_id=?").get(item.id)) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && exitCode !== 0) throw running.failure ? new CloudError(running.failure.code, running.failure.retryAfterSeconds) : new CloudError(exitCode === 5 ? "NETWORK_UNAVAILABLE" : "COMPONENT_UNAVAILABLE");
          throw error;
        }
      }
    } catch (error) {
      if (claimed && (db.prepare("SELECT state FROM download_attempt WHERE id=?").get(running.context!.attemptId) as Attempt)?.state === "STOPPED") stopped = true;
      if (claimed && !stopped && running.handle && running.context) {
        try { await this.host.request("transfer.stop", running.handle, running.context, randomUUID()); stopped = true; db.prepare("UPDATE download_attempt SET state='STOPPED',stopped_at=?,stop_evidence_json=? WHERE id=?").run(new Date(this.now()).toISOString(), JSON.stringify({ kind: "host-confirmed-stop", executionId: running.handle.executionId }), running.context.attemptId); } catch {}
      }
      if (claimed && !stopped) { db.prepare("UPDATE download_attempt SET state='UNCERTAIN' WHERE id=?").run(running.context!.attemptId); this.state(item.id, "RECONCILING", "COMPONENT_UNAVAILABLE"); }
      else if (!db.prepare("SELECT 1 FROM download_commit_intent WHERE item_id=?").get(item.id)) {
        if (running.stop || this.closed) this.state(item.id, this.closed ? "QUEUED" : this.retainedDemand(item.id) ? "PAUSED" : "CANCELLED"); else this.fail(item, error);
      }
    } finally {
      unobserve?.();
      if (claimed && stopped) {
        const intent = db.prepare("SELECT state FROM download_commit_intent WHERE item_id=?").get(item.id) as { state: string } | undefined;
        if (!intent || intent.state === "RECORDED") {
          db.prepare("DELETE FROM download_claim WHERE item_id=? AND attempt_id=?").run(item.id, running.context!.attemptId);
          try { await this.roots.files.get(item.target_root_id).cleanupAttempt(running.context!.attemptId); } catch { /* 原卷恢复后继续回收所属暂存区。 */ }
        }
      }
    }
  }
  private event(running: Running, event: HostEvent) {
    if (!running.context || !running.handle) return;
    const cursor = { context: running.context, executionId: running.handle.executionId, sequence: running.sequence }, next = acceptExecutionEvent(cursor, event);
    if (next === cursor) return; running.sequence = next.sequence;
    if (event.event.type === "exited") running.confirmedExit = event.event;
    if (running.stop || this.closed) return;
    if (event.event.type === "failure") running.failure = event.event.failure;
    if (event.event.type === "progress") this.database.connection.prepare("UPDATE download_item_runtime SET bytes=?,speed=?,total_bytes=?,sequence=? WHERE item_id=? AND EXISTS(SELECT 1 FROM download_claim c JOIN download_item i ON i.id=c.item_id WHERE c.item_id=? AND c.attempt_id=? AND i.state='RUNNING')")
      .run(event.event.bytes, event.event.bytesPerSecond, event.event.totalBytes, event.sequence, running.item.id, running.item.id, running.context.attemptId);
  }
  private async reconcile() {
    const db = this.database.connection, items = db.prepare("SELECT i.*,a.id AS attempt_id,a.state AS attempt_state,c.state AS commit_state FROM download_item i JOIN download_claim d ON d.item_id=i.id JOIN download_attempt a ON a.id=d.attempt_id LEFT JOIN download_commit_intent c ON c.item_id=i.id WHERE a.state IN ('STOPPED','EXITED') AND i.state IN ('RECONCILING','COMMITTING','BLOCKED_LOCAL') LIMIT 100").all() as (Item & { attempt_id: string; commit_state: string | null })[];
    for (const item of items) {
      if (this.closed || this.active.has(item.account_id)) continue;
      try {
        await this.roots.files.get(item.target_root_id).check();
        if (item.commit_state) await this.commits.finish(item.id);
        else { await this.roots.files.get(item.target_root_id).cleanupAttempt(item.attempt_id).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); db.prepare("DELETE FROM download_claim WHERE item_id=?").run(item.id); this.state(item.id, this.demands(item.id) ? "QUEUED" : this.retainedDemand(item.id) ? "PAUSED" : "CANCELLED"); }
      } catch { /* 缺盘或归属证据不足时保留 claim/intent，不重传或覆盖。 */ }
    }
    // 完成事务之后、暂存清理之前崩溃时，只回收带原所有权标记的已停止 attempt。
    const garbage = db.prepare("SELECT DISTINCT a.id,i.target_root_id FROM download_attempt a JOIN download_attempt_item m ON m.attempt_id=a.id JOIN download_item i ON i.id=m.item_id WHERE a.state IN ('STOPPED','EXITED') AND coalesce(json_extract(a.stop_evidence_json,'$.stagingCleaned'),0)=0 AND NOT EXISTS(SELECT 1 FROM download_claim c WHERE c.attempt_id=a.id) AND NOT EXISTS(SELECT 1 FROM download_attempt_item x JOIN download_commit_intent c ON c.item_id=x.item_id WHERE x.attempt_id=a.id AND c.state!='RECORDED') LIMIT 100").all() as { id: string; target_root_id: string }[];
    for (const attempt of garbage) {
      if (this.closed) break;
      try {
        const root = this.roots.files.get(attempt.target_root_id); await root.check();
        await root.cleanupAttempt(attempt.id).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
        db.prepare("UPDATE download_attempt SET stop_evidence_json=json_set(stop_evidence_json,'$.stagingCleaned',1) WHERE id=?").run(attempt.id);
      } catch { /* 目录尚未恢复或标记不匹配时不删除任何文件。 */ }
    }
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.timer = undefined;
    for (const running of this.active.values()) running.stop = true;
    await this.previews.close(); await Promise.allSettled([...this.active.values()].map((run) => run.done));
    while (this.ticking) await delay(10);
  }
}
