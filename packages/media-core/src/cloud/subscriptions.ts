import { createHash, randomUUID } from "node:crypto";
import { CloudError, cloudFailure, cloudFiltersSchema, type CloudFailure, type CloudInput, type CloudSubscription } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { RemoteCatalog } from "./catalog.js";
import type { CloudRoots } from "./roots.js";
import type { CloudDownloads } from "./downloads.js";
import type { PreviewSnapshot, PreviewRow } from "./previews.js";

interface SubscriptionRow {
  id: string; account_id: string; remote_root_ref: string; target_root_id: string; filters_json: string; interval_seconds: number;
  enabled: number; configuration_version: number; confirmed_preview_id: string; last_scan_at: string | null; next_scan_at: string | null;
  state: CloudSubscription["state"]; failure_json: string | null; retry_count: number; retry_after: string | null;
  last_files: number; last_bytes: number; last_reused: number; last_conflicts: number; last_complete: number; last_job_id: string | null;
  snapshot_json: string | null; remote_name: string;
}
interface ScanRow { id: string; subscription_id: string; configuration_version: number; generation: string; preview_id: string | null; execution_preview_id: string | null; summary_json: string | null }
type Summary = { files: number; bytes: number; reused: number; conflicts: number; complete: boolean };
const signature = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const joined = "SELECT s.*,r.*,p.snapshot_json,e.name AS remote_name FROM cloud_subscription s JOIN cloud_subscription_runtime r ON r.subscription_id=s.id JOIN remote_entry e ON e.id=s.remote_root_ref LEFT JOIN cloud_preview p ON p.id=s.confirmed_preview_id";

/** 订阅只编排扫描和下载需求；内容获取、提交与重试仍由同一下载服务负责。 */
export class CloudSubscriptions {
  private timer?: ReturnType<typeof setInterval>; private ticking = false; private closed = false;
  constructor(private readonly database: CoreDatabase, private readonly downloads: CloudDownloads, private readonly catalog: RemoteCatalog, private readonly roots: CloudRoots, private readonly now = Date.now) {
    const db = database.connection, stamp = new Date(this.now()).toISOString();
    db.prepare("UPDATE cloud_scan SET state='ABANDONED',cursor=NULL WHERE state='SCANNING'").run();
    db.prepare("UPDATE cloud_subscription_runtime SET state='IDLE' WHERE state='SCANNING'").run();
    // 应用退出期间的多个周期仅合并为一轮；认证/缺盘/失败不会因启动而无限重试。
    db.prepare("UPDATE cloud_subscription SET next_scan_at=? WHERE enabled=1 AND id IN (SELECT subscription_id FROM cloud_subscription_runtime WHERE state IN ('IDLE','RETRY_WAIT'))").run(stamp);
  }
  start() { if (!this.timer) this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 500); }
  private row(id: string) {
    const row = this.database.connection.prepare(joined + " WHERE s.id=?").get(id) as SubscriptionRow | undefined;
    if (!row) throw new CloudError("REMOTE_NOT_FOUND"); return row;
  }
  private dto(row: SubscriptionRow): CloudSubscription {
    const snapshot: PreviewSnapshot | null = row.snapshot_json ? JSON.parse(row.snapshot_json) : null;
    return { id: row.id, accountId: row.account_id, remoteRef: row.remote_root_ref, targetGrantId: row.target_root_id, name: snapshot?.name ?? row.remote_name,
      filters: cloudFiltersSchema.parse(JSON.parse(row.filters_json)), intervalSeconds: row.interval_seconds, enabled: !!row.enabled, configurationVersion: row.configuration_version,
      state: !row.enabled && row.state !== "CANCELLED" && row.state !== "RESELECT_REQUIRED" ? "PAUSED" : row.state,
      failure: row.failure_json ? JSON.parse(row.failure_json) : null, lastScanAt: row.last_scan_at, nextScanAt: row.next_scan_at,
      lastResult: row.last_scan_at ? { files: row.last_files, bytes: row.last_bytes, reused: row.last_reused, conflicts: row.last_conflicts, complete: !!row.last_complete, jobId: row.last_job_id } : null };
  }
  list(input: CloudInput<"cloud.subscriptions.list">) {
    const db = this.database.connection, rows = db.prepare(joined + " ORDER BY s.created_at DESC,s.id LIMIT ? OFFSET ?").all(input.pageSize ?? 25, ((input.page ?? 1) - 1) * (input.pageSize ?? 25)) as SubscriptionRow[];
    return { items: rows.map((row) => this.dto(row)), total: (db.prepare("SELECT count(*) AS n FROM cloud_subscription").get() as { n: number }).n };
  }
  private previous(requestKey: string, hash: string) {
    const row = this.database.connection.prepare("SELECT subscription_id,signature FROM cloud_subscription_command WHERE request_key=?").get(requestKey) as { subscription_id: string; signature: string } | undefined;
    if (row && row.signature !== hash) throw new CloudError("CONFLICT"); return row?.subscription_id;
  }
  configure(input: CloudInput<"cloud.subscriptions.configure">): CloudSubscription {
    if (this.closed) throw new CloudError("INTERRUPTED");
    const db = this.database.connection, interval = input.intervalSeconds ?? 900, hash = signature({ operation: "configure", subscriptionId: input.subscriptionId ?? null, configurationVersion: input.configurationVersion ?? null, previewId: input.previewId, interval });
    const repeated = this.previous(input.requestKey, hash); if (repeated) return this.dto(this.row(repeated));
    const preview = this.downloads.previews.row(input.previewId);
    if (!preview) throw new CloudError("REMOTE_NOT_FOUND");
    const snapshot: PreviewSnapshot = JSON.parse(preview.snapshot_json), old = input.subscriptionId ? this.row(input.subscriptionId) : null;
    if (preview.state !== "READY" || !snapshot.complete || snapshot.failure || snapshot.variant || snapshot.layout !== "drive" || snapshot.rootType !== "directory" || preview.expires_at <= new Date(this.now()).toISOString()) throw new CloudError("CONFLICT");
    if (this.catalog.source(preview.account_id, preview.remote_root_ref).binding.generation !== snapshot.binding.generation) throw new CloudError("REMOTE_CHANGED");
    if (old && (old.account_id !== preview.account_id || old.configuration_version !== input.configurationVersion || old.state === "CANCELLED")) throw new CloudError("CONFLICT");
    if (!old && (db.prepare("SELECT count(*) AS n FROM cloud_subscription").get() as { n: number }).n >= 100) throw new CloudError("CONFLICT");
    const id = old?.id ?? randomUUID(), version = (old?.configuration_version ?? 0) + 1, now = new Date(this.now()).toISOString();
    let abandoned: string[] = [];
    db.transaction(() => {
      if (old) abandoned = this.abandon(id, undefined, false);
      db.prepare("INSERT INTO cloud_subscription(id,account_id,remote_root_ref,target_root_id,filters_json,interval_seconds,enabled,configuration_version,confirmed_preview_id,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET remote_root_ref=excluded.remote_root_ref,target_root_id=excluded.target_root_id,filters_json=excluded.filters_json,interval_seconds=excluded.interval_seconds,enabled=1,configuration_version=excluded.configuration_version,confirmed_preview_id=excluded.confirmed_preview_id,updated_at=excluded.updated_at")
        .run(id, preview.account_id, preview.remote_root_ref, preview.target_root_id, JSON.stringify(cloudFiltersSchema.parse(snapshot.filters)), interval, version, preview.id, now, now);
      db.prepare("INSERT INTO cloud_subscription_runtime(subscription_id,state) VALUES(?,'SCANNING') ON CONFLICT(subscription_id) DO UPDATE SET state='SCANNING',failure_json=NULL,retry_count=0,retry_after=NULL").run(id);
      db.prepare("UPDATE cloud_preview SET state='CONFIRMED' WHERE id=?").run(preview.id);
      this.createScan(id, preview.account_id, preview.remote_root_ref, version, preview.id);
      db.prepare("INSERT INTO cloud_subscription_command(request_key,subscription_id,operation,signature,created_at) VALUES(?,?,'configure',?,?)").run(input.requestKey, id, hash, now);
    })();
    for (const preview of abandoned) this.downloads.previews.cancel(preview);
    this.cancelStaleJobs(); return this.dto(this.row(id));
  }
  private createScan(subscriptionId: string, accountId: string, remoteRef: string, version: number, previewId?: string) {
    const id = randomUUID(), generation = randomUUID();
    this.database.connection.prepare("INSERT INTO cloud_scan(id,subscription_id,account_id,remote_root_ref,generation,configuration_version,state,started_at) VALUES(?,?,?,?,?,?,'SCANNING',?)").run(id, subscriptionId, accountId, remoteRef, generation, version, new Date(this.now()).toISOString());
    this.database.connection.prepare("INSERT INTO cloud_scan_plan(scan_id,preview_id) VALUES(?,?)").run(id, previewId ?? null); return id;
  }
  private abandon(id: string, scanId?: string, cancel = true): string[] {
    const rows = this.database.connection.prepare("SELECT p.preview_id,p.execution_preview_id FROM cloud_scan c JOIN cloud_scan_plan p ON p.scan_id=c.id WHERE c.subscription_id=? AND c.state='SCANNING' AND (? IS NULL OR c.id=?)").all(id, scanId ?? null, scanId ?? null) as { preview_id: string | null; execution_preview_id: string | null }[];
    const ids = rows.flatMap((row) => [row.preview_id, row.execution_preview_id]).filter((id): id is string => !!id);
    if (cancel) for (const preview of ids) this.downloads.previews.cancel(preview);
    this.database.connection.prepare("UPDATE cloud_scan SET state='ABANDONED',cursor=NULL WHERE subscription_id=? AND state='SCANNING' AND (? IS NULL OR id=?)").run(id, scanId ?? null, scanId ?? null); return ids;
  }
  control(input: CloudInput<"cloud.subscriptions.control">): CloudSubscription {
    if (this.closed) throw new CloudError("INTERRUPTED");
    const db = this.database.connection, hash = signature({ id: input.subscriptionId, operation: input.operation }), repeated = this.previous(input.requestKey, hash);
    if (repeated) return this.dto(this.row(repeated)); const row = this.row(input.subscriptionId);
    if (row.state === "CANCELLED") throw new CloudError("CONFLICT");
    if (["resume", "scan"].includes(input.operation) && !row.confirmed_preview_id) throw new CloudError("CONFLICT");
    if (input.operation === "scan" && !row.enabled) throw new CloudError("CONFLICT");
    if (input.operation === "resume") { this.catalog.source(row.account_id, row.remote_root_ref); this.roots.files.get(row.target_root_id); }
    let abandoned: string[] = [];
    db.transaction(() => {
      if (input.operation === "pause" || input.operation === "cancel") {
        abandoned = this.abandon(row.id, undefined, false);
        db.prepare("UPDATE cloud_subscription SET enabled=0,next_scan_at=NULL,updated_at=? WHERE id=?").run(new Date(this.now()).toISOString(), row.id);
        db.prepare("UPDATE cloud_subscription_runtime SET state=?,retry_after=NULL WHERE subscription_id=?").run(input.operation === "cancel" ? "CANCELLED" : "PAUSED", row.id);
      } else if (row.state !== "SCANNING") {
        db.prepare("UPDATE cloud_subscription SET enabled=1,next_scan_at=?,updated_at=? WHERE id=?").run(new Date(this.now()).toISOString(), new Date(this.now()).toISOString(), row.id);
        db.prepare("UPDATE cloud_subscription_runtime SET state=CASE WHEN state='SCANNING' THEN state ELSE 'IDLE' END,failure_json=NULL,retry_count=0,retry_after=NULL WHERE subscription_id=?").run(row.id);
      }
      db.prepare("INSERT INTO cloud_subscription_command(request_key,subscription_id,operation,signature,created_at) VALUES(?,?,?,?,?)").run(input.requestKey, row.id, input.operation, hash, new Date(this.now()).toISOString());
    })();
    for (const preview of abandoned) this.downloads.previews.cancel(preview);
    if (input.operation === "pause" || input.operation === "cancel") {
      const excluded = input.operation === "cancel" ? "'COMPLETED','CANCELLED','CANCELLING'" : "'COMPLETED','CANCELLED','CANCELLING','PAUSING','PAUSED'";
      const jobs = db.prepare(`SELECT id,state FROM download_job WHERE subscription_id=? AND state NOT IN (${excluded})`).all(row.id) as { id: string; state: string }[];
      for (const job of jobs) this.downloads.control({ jobId: job.id, operation: input.operation, requestKey: randomUUID() });
    }
    if (input.operation === "resume" && !this.downloads.pauseStatus().paused) {
      const jobs = db.prepare("SELECT id FROM download_job WHERE subscription_id=? AND configuration_version=? AND state='PAUSED'").all(row.id, row.configuration_version) as { id: string }[];
      for (const job of jobs) this.downloads.control({ jobId: job.id, operation: "resume", requestKey: randomUUID() });
    }
    return this.dto(this.row(row.id));
  }
  private cancelStaleJobs() {
    const jobs = this.database.connection.prepare("SELECT j.id FROM download_job j JOIN cloud_subscription s ON s.id=j.subscription_id WHERE j.configuration_version!=s.configuration_version AND j.state NOT IN ('COMPLETED','CANCELLED','CANCELLING')").all() as { id: string }[];
    for (const job of jobs) this.downloads.control({ jobId: job.id, operation: "cancel", requestKey: randomUUID() });
  }
  private summary(preview: PreviewRow): Summary {
    const snapshot: PreviewSnapshot = JSON.parse(preview.snapshot_json);
    return { files: snapshot.items.length, bytes: snapshot.items.reduce((sum, item) => sum + item.expectedSize, 0), reused: snapshot.items.filter((item) => item.reuseItemId).length, conflicts: snapshot.items.filter((item) => item.issue).length, complete: snapshot.complete };
  }
  private fail(scan: ScanRow, row: SubscriptionRow, error: unknown, summary: Summary = { files: 0, bytes: 0, reused: 0, conflicts: 0, complete: false }) {
    const db = this.database.connection, failure = cloudFailure(error), retry = row.retry_count + 1, now = new Date(this.now()).toISOString();
    const retryable = failure.retryable && retry < 3;
    const until = retryable ? new Date(this.now() + Math.max((failure.retryAfterSeconds ?? 0) * 1000, Math.min(1000 * 2 ** (retry - 1), 60000))).toISOString() : null;
    const state = retryable ? "RETRY_WAIT" : failure.code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : failure.code === "LOCAL_UNAVAILABLE" ? "BLOCKED_LOCAL" : ["REMOTE_CHANGED", "REMOTE_NOT_FOUND"].includes(failure.code) ? "RESELECT_REQUIRED" : "FAILED";
    db.transaction(() => {
      db.prepare("UPDATE cloud_scan SET state='INCOMPLETE',cursor=NULL,completed_at=? WHERE id=? AND state='SCANNING'").run(now, scan.id);
      db.prepare("UPDATE cloud_subscription SET last_scan_at=?,next_scan_at=? WHERE id=? AND configuration_version=?").run(now, until, row.id, scan.configuration_version);
      db.prepare("UPDATE cloud_subscription_runtime SET state=?,failure_json=?,retry_count=?,retry_after=?,last_files=?,last_bytes=?,last_reused=?,last_conflicts=?,last_complete=0,last_job_id=NULL WHERE subscription_id=?").run(state, JSON.stringify(failure), Math.min(retry, 3), until, summary.files, summary.bytes, summary.reused, summary.conflicts, row.id);
      if (failure.code === "RATE_LIMITED") db.prepare("INSERT INTO cloud_account_backoff(account_id,until_at) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET until_at=max(until_at,excluded.until_at)").run(row.account_id, until ?? new Date(this.now() + (failure.retryAfterSeconds ?? 1) * 1000).toISOString());
    })();
  }
  private async process(scan: ScanRow) {
    const db = this.database.connection, row = this.row(scan.subscription_id);
    if (!row.enabled || row.configuration_version !== scan.configuration_version) { this.abandon(row.id, scan.id); return; }
    if (!scan.preview_id) {
      try {
        const preview = this.downloads.previews.start({ accountId: row.account_id, remoteRef: row.remote_root_ref, targetGrantId: row.target_root_id, requestKey: scan.generation, filters: cloudFiltersSchema.parse(JSON.parse(row.filters_json)), layout: "drive" });
        db.prepare("UPDATE cloud_scan_plan SET preview_id=? WHERE scan_id=?").run(preview.id, scan.id); scan.preview_id = preview.id;
      } catch (error) { this.fail(scan, row, error); return; }
    }
    const full = this.downloads.previews.row(scan.preview_id!); if (!full) { this.fail(scan, row, new CloudError("INTERRUPTED")); return; }
    const snapshot: PreviewSnapshot = JSON.parse(full.snapshot_json), summary: Summary = scan.summary_json ? JSON.parse(scan.summary_json) : this.summary(full);
    if (full.state === "BUILDING") return;
    if (snapshot.failure || !snapshot.complete || full.state === "EXPIRED") { this.fail(scan, row, snapshot.failure ? new CloudError(snapshot.failure.code, snapshot.failure.retryAfterSeconds) : new CloudError("INTERRUPTED"), summary); return; }
    try {
      if (!scan.execution_preview_id) {
        const needed = snapshot.items.filter((item) => {
          if (item.reuseItemId) return false;
          if (!item.existingItemId) return true;
          if (item.issue) return false;
          // 同一订阅已有有效需求或用户暂停的需求时不再创建相同作业；其他订阅仍建立独立需求。
          return !db.prepare("SELECT 1 FROM download_job_item d JOIN download_job j ON j.id=d.job_id WHERE d.item_id=? AND d.demand_state='ACTIVE' AND j.subscription_id=? AND j.configuration_version=? AND j.state NOT IN ('CANCELLED','CANCELLING','FAILED') LIMIT 1").get(item.existingItemId, row.id, row.configuration_version);
        });
        if (needed.length) {
          const id = randomUUID(), now = new Date(this.now()).toISOString(), derived: PreviewSnapshot = { ...snapshot, items: needed };
          db.transaction(() => {
            db.prepare("INSERT INTO cloud_preview(id,account_id,remote_root_ref,target_root_id,request_key,snapshot_json,state,configuration_version,created_at,expires_at) VALUES(?,?,?,?,?,?,'READY',?,?,?)").run(id, row.account_id, row.remote_root_ref, row.target_root_id, randomUUID(), JSON.stringify(derived), row.configuration_version, now, new Date(this.now() + 15 * 60 * 1000).toISOString());
            db.prepare("UPDATE cloud_scan_plan SET execution_preview_id=?,summary_json=? WHERE scan_id=?").run(id, JSON.stringify(summary), scan.id);
          })(); scan.execution_preview_id = id;
        }
      }
      const job = scan.execution_preview_id ? await this.downloads.confirm({ previewId: scan.execution_preview_id, requestKey: scan.generation }, { subscriptionId: row.id, configurationVersion: row.configuration_version, scanId: scan.id }) : null;
      const current = this.row(row.id);
      if (this.closed || !current.enabled || current.configuration_version !== scan.configuration_version) { this.cancelStaleJobs(); return; }
      const now = new Date(this.now()).toISOString();
      db.transaction(() => {
        db.prepare("UPDATE cloud_scan SET state='COMPLETE',cursor=NULL,completed_at=? WHERE id=? AND state='SCANNING'").run(now, scan.id);
        db.prepare("UPDATE cloud_subscription SET last_scan_at=?,next_scan_at=? WHERE id=?").run(now, new Date(this.now() + row.interval_seconds * 1000).toISOString(), row.id);
        db.prepare("UPDATE cloud_subscription_runtime SET state='IDLE',failure_json=NULL,retry_count=0,retry_after=NULL,last_files=?,last_bytes=?,last_reused=?,last_conflicts=?,last_complete=1,last_job_id=? WHERE subscription_id=?").run(summary.files, summary.bytes, summary.reused, summary.conflicts, job?.jobId ?? null, row.id);
        db.prepare("UPDATE cloud_scan_plan SET preview_id=NULL,summary_json=? WHERE scan_id=?").run(JSON.stringify(summary), scan.id);
        if (full.id !== row.confirmed_preview_id) db.prepare("UPDATE cloud_preview SET state='EXPIRED' WHERE id=?").run(full.id);
      })();
    } catch (error) {
      const current = this.row(row.id); if (!this.closed && current.enabled && current.configuration_version === scan.configuration_version) this.fail(scan, current, error, summary);
    }
  }
  private async tick() {
    if (this.closed || this.ticking) return; this.ticking = true;
    try {
      this.cancelStaleJobs(); const db = this.database.connection;
      const scans = db.prepare("SELECT c.*,p.preview_id,p.execution_preview_id,p.summary_json FROM cloud_scan c JOIN cloud_scan_plan p ON p.scan_id=c.id WHERE c.state='SCANNING' ORDER BY c.started_at,c.id LIMIT 4").all() as ScanRow[];
      for (const scan of scans) { if (this.closed) break; await this.process(scan); }
      const ready = new Set(this.catalog.accounts().filter((account) => ["READY", "RESELECT_REQUIRED"].includes(account.status)).map((account) => account.id)), now = new Date(this.now()).toISOString();
      const due = db.prepare(joined + " WHERE s.enabled=1 AND s.next_scan_at<=? AND r.state IN ('IDLE','RETRY_WAIT') AND NOT EXISTS(SELECT 1 FROM cloud_scan c WHERE c.subscription_id=s.id AND c.state='SCANNING') AND NOT EXISTS(SELECT 1 FROM cloud_account_backoff b WHERE b.account_id=s.account_id AND b.until_at>?) ORDER BY s.next_scan_at,s.id LIMIT 4").all(now, now) as SubscriptionRow[];
      for (const row of due) if (!this.closed && ready.has(row.account_id)) db.transaction(() => {
        this.createScan(row.id, row.account_id, row.remote_root_ref, row.configuration_version);
        db.prepare("UPDATE cloud_subscription_runtime SET state='SCANNING' WHERE subscription_id=?").run(row.id);
      })();
      db.prepare("DELETE FROM cloud_preview WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM download_job j WHERE j.preview_id=cloud_preview.id) AND NOT EXISTS(SELECT 1 FROM cloud_subscription s WHERE s.confirmed_preview_id=cloud_preview.id) AND NOT EXISTS(SELECT 1 FROM cloud_scan_plan p JOIN cloud_scan c ON c.id=p.scan_id WHERE c.state='SCANNING' AND (p.preview_id=cloud_preview.id OR p.execution_preview_id=cloud_preview.id))").run(now);
    } finally { this.ticking = false; }
  }
  async wake(hostGeneration: string) {
    const ready = new Set(this.catalog.accounts().filter((account) => account.status === "READY").map((account) => account.id));
    const db = this.database.connection, rows = db.prepare(joined + " WHERE s.enabled=1 AND r.state IN ('IDLE','AUTH_REQUIRED','BLOCKED_LOCAL')").all() as SubscriptionRow[];
    for (const row of rows) if (ready.has(row.account_id)) {
      try { this.catalog.source(row.account_id, row.remote_root_ref); await this.roots.files.get(row.target_root_id).check(); }
      catch { continue; }
      if (this.closed) return;
      db.transaction(() => {
        db.prepare("UPDATE cloud_subscription_runtime SET state='IDLE',failure_json=NULL,retry_count=CASE WHEN last_recovery_generation IS NULL OR last_recovery_generation!=? THEN 0 ELSE retry_count END,last_recovery_generation=? WHERE subscription_id=? AND state IN ('IDLE','AUTH_REQUIRED','BLOCKED_LOCAL')").run(hostGeneration, hostGeneration, row.id);
        db.prepare("UPDATE cloud_subscription SET next_scan_at=? WHERE id=? AND enabled=1").run(new Date(this.now()).toISOString(), row.id);
      })();
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.timer = undefined; while (this.ticking) await new Promise((done) => setTimeout(done, 10)); }
}
