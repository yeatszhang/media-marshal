import { randomUUID } from "node:crypto";
import { DesktopError, CloudError, cloudFailure, sourceConfigurationSchema, type CoreInput, type SourceRun } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { CloudDownloads } from "../cloud/downloads.js";

interface RunRow { id: string; source_id: string; source_version: number; state: SourceRun["state"]; preview_id: string | null; preview_key: string; job_id: string | null; failure_json: string | null; created_at: string; updated_at: string; force_redownload: number }
const dto = (row: RunRow): SourceRun => ({ id: row.id, sourceId: row.source_id, sourceVersion: row.source_version, state: row.state, jobId: row.job_id, failure: row.failure_json ? JSON.parse(row.failure_json) : null, createdAt: row.created_at, updatedAt: row.updated_at, forceRedownload: !!row.force_redownload });

/** 一次执行的意图先落库；恢复只继续相同意图，不创建或启用周期订阅。 */
export class SourceRuns {
  private timer?: ReturnType<typeof setInterval>; private flight?: Promise<void>; private closed = false;
  constructor(private readonly database: CoreDatabase, private readonly downloads: CloudDownloads, private readonly now = Date.now) {}
  start() { if (!this.closed && !this.timer) this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 500); }
  private source(id: string) { return this.database.connection.prepare("SELECT s.*,v.configuration_json FROM source_rule s JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version WHERE s.id=?").get(id) as { id: string; version: number; lifecycle_revision: number; deleted_at: string | null; paused: number; review_required: number; subscription_id: string | null; configuration_json: string } | undefined; }
  get(id: string) { const row = this.database.connection.prepare("SELECT * FROM source_rule_run WHERE id=?").get(id) as RunRow | undefined; return row ? dto(row) : null; }
  enqueue(input: CoreInput<"source-rules.run-once">, prepared?: { previewId: string; previewKey: string; forceRedownload: boolean }): SourceRun {
    if (this.closed) throw new DesktopError("INTERRUPTED", "来源执行正在停止", true);
    const db = this.database.connection;
    return db.transaction(() => {
      const receipt = db.prepare("SELECT r.*,q.source_id AS requested_source,q.version AS requested_version,q.lifecycle_revision AS requested_lifecycle,q.preview_id AS requested_preview FROM source_rule_run_request q JOIN source_rule_run r ON r.id=q.run_id WHERE q.request_key=?").get(input.requestKey) as (RunRow & { requested_source: string; requested_version: number; requested_lifecycle: number; requested_preview: string | null }) | undefined;
      if (receipt) {
        if (receipt.requested_source !== input.id || receipt.requested_version !== input.expectedVersion || receipt.requested_lifecycle !== (input.expectedLifecycleRevision ?? 0) || receipt.requested_preview !== (prepared?.previewId ?? null) || !!receipt.force_redownload !== !!prepared?.forceRedownload) throw new DesktopError("CONFLICT", "请求标识已用于其他来源执行");
        return dto(receipt);
      }
      const source = this.source(input.id);
      if (!source || source.deleted_at || source.lifecycle_revision !== (input.expectedLifecycleRevision ?? 0) || source.version !== input.expectedVersion || source.paused || source.review_required || sourceConfigurationSchema.parse(JSON.parse(source.configuration_json)).type !== "cloud") throw new DesktopError("CONFLICT", "请先预览确认并恢复网盘来源");
      let run = db.prepare("SELECT * FROM source_rule_run WHERE source_id=? AND source_version=? AND force_redownload=? AND state IN ('QUEUED','SCANNING')").get(input.id, input.expectedVersion, Number(!!prepared?.forceRedownload)) as RunRow | undefined;
      if (!run) {
        const stamp = new Date(this.now()).toISOString();
        run = { id: randomUUID(), source_id: input.id, source_version: input.expectedVersion, state: prepared ? "SCANNING" : "QUEUED", preview_id: prepared?.previewId ?? null, preview_key: prepared?.previewKey ?? randomUUID(), job_id: null, failure_json: null, created_at: stamp, updated_at: stamp, force_redownload: Number(!!prepared?.forceRedownload) };
        db.prepare("INSERT INTO source_rule_run(id,source_id,source_version,state,preview_id,preview_key,created_at,updated_at,force_redownload) VALUES(?,?,?,?,?,?,?,?,?)").run(run.id, run.source_id, run.source_version, run.state, run.preview_id, run.preview_key, stamp, stamp, run.force_redownload);
      }
      db.prepare("INSERT INTO source_rule_run_request(request_key,run_id,source_id,version,preview_id,lifecycle_revision) VALUES(?,?,?,?,?,?)").run(input.requestKey, run.id, input.id, input.expectedVersion, prepared?.previewId ?? null, source.lifecycle_revision);
      return dto(run);
    })();
  }
  list(input: CoreInput<"source-rules.runs">) {
    const db = this.database.connection;
    return { items: (db.prepare("SELECT * FROM source_rule_run WHERE source_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?").all(input.sourceId, input.pageSize ?? 25, ((input.page ?? 1) - 1) * (input.pageSize ?? 25)) as RunRow[]).map(dto), total: (db.prepare("SELECT count(*) AS n FROM source_rule_run WHERE source_id=?").get(input.sourceId) as { n: number }).n };
  }
  private submitted(run: RunRow, jobId: string | null) {
    this.database.connection.prepare("UPDATE source_rule_run SET state='SUBMITTED',job_id=?,failure_json=NULL,updated_at=? WHERE id=? AND state IN ('QUEUED','SCANNING')").run(jobId, new Date(this.now()).toISOString(), run.id);
  }
  tick(): Promise<void> { if (this.closed) return Promise.resolve(); return this.flight ??= this.process().finally(() => { this.flight = undefined; }); }
  private async process() {
    const db = this.database.connection;
    const runs = db.prepare("SELECT * FROM source_rule_run WHERE state IN ('QUEUED','SCANNING') ORDER BY created_at,id LIMIT 4").all() as RunRow[];
    for (const run of runs) {
      if (this.closed) return;
      // 下载确认可能已提交而进程在更新执行记录前退出，先关联原作业。
      const committed = run.preview_id ? db.prepare("SELECT id FROM download_job WHERE preview_id=?").get(run.preview_id) as { id: string } | undefined : undefined;
      if (committed) { this.submitted(run, committed.id); continue; }
      const source = this.source(run.source_id);
      if (!source || source.version !== run.source_version) {
        if (run.preview_id) this.downloads.previews.cancel(run.preview_id);
        db.prepare("UPDATE source_rule_run SET state='ABANDONED',updated_at=? WHERE id=?").run(new Date(this.now()).toISOString(), run.id); continue;
      }
      if (source.paused || source.review_required) continue;
      const configuration = sourceConfigurationSchema.parse(JSON.parse(source.configuration_json));
      if (configuration.type !== "cloud") continue;
      if (!this.downloads.sourceRuntimeReady(configuration.accountId, configuration.downloadRootId)) continue;
      try {
        // 与周期扫描重叠时复用其尚未完成的同版本作业。
        const active = db.prepare("SELECT j.id FROM download_job j JOIN download_source_demand d ON d.job_id=j.id JOIN cloud_preview p ON p.id=j.preview_id WHERE d.source_id=? AND d.source_version=? AND j.state NOT IN ('COMPLETED','CANCELLED','CANCELLING','FAILED') AND ((?=0 AND coalesce(json_extract(p.snapshot_json,'$.variant'),'')='') OR (?=1 AND EXISTS(SELECT 1 FROM source_rule_run r WHERE r.job_id=j.id AND r.force_redownload=1))) ORDER BY j.created_at,j.id LIMIT 1").get(run.source_id, run.source_version, run.force_redownload, run.force_redownload) as { id: string } | undefined;
        if (active) { if (run.preview_id) this.downloads.previews.cancel(run.preview_id); this.submitted(run, active.id); continue; }
        if (!run.force_redownload && source.subscription_id && db.prepare("SELECT 1 FROM cloud_scan WHERE subscription_id=? AND state='SCANNING' LIMIT 1").get(source.subscription_id)) continue;
        let preview = run.preview_id ? this.downloads.previews.get(run.preview_key) : null;
        if (preview?.state === "EXPIRED") {
          if (run.force_redownload) throw new CloudError("CONFLICT");
          run.preview_key = randomUUID(); run.preview_id = null;
          db.prepare("UPDATE source_rule_run SET state='QUEUED',preview_id=NULL,preview_key=? WHERE id=?").run(run.preview_key, run.id); preview = null;
        }
        if (!preview) {
          preview = this.downloads.previews.start({ accountId: configuration.accountId, remoteRef: configuration.remoteRef, targetGrantId: configuration.downloadRootId, filters: configuration.filters, layout: "drive", requestKey: run.preview_key, forceRedownload: !!run.force_redownload });
          run.preview_id = preview.id;
          db.prepare("UPDATE source_rule_run SET state='SCANNING',preview_id=?,updated_at=? WHERE id=?").run(preview.id, new Date(this.now()).toISOString(), run.id);
        }
        if (preview.state === "BUILDING") continue;
        if (preview.state !== "READY" || !preview.complete || preview.conflicts) throw preview.failure ? new CloudError(preview.failure.code, preview.failure.retryAfterSeconds) : new CloudError("CONFLICT");
        if (!preview.files) { this.submitted(run, null); continue; }
        if (this.closed) return;
        const job = await this.downloads.confirm({ previewId: preview.id, requestKey: run.id }, { sourceId: run.source_id, sourceVersion: run.source_version, runId: run.id });
        this.submitted(run, job.jobId);
      } catch (error) {
        if (run.preview_id && db.prepare("SELECT 1 FROM download_job WHERE preview_id=?").get(run.preview_id)) continue;
        // 暂停或变更发生在异步预算检查期间时，保留原意图供协调或废弃。
        const latest = this.source(run.source_id);
        if (this.closed || latest?.paused || latest?.version !== run.source_version) continue;
        db.prepare("UPDATE source_rule_run SET state='FAILED',failure_json=?,updated_at=? WHERE id=? AND state IN ('QUEUED','SCANNING')").run(JSON.stringify(cloudFailure(error)), new Date(this.now()).toISOString(), run.id);
      }
    }
  }
  quiesce() { this.closed = true; clearInterval(this.timer); }
  async close() { this.quiesce(); await this.flight?.catch(() => {}); }
}
