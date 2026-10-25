import { randomUUID } from "node:crypto";
import { DesktopError, sourceConfigurationSchema, type CoreInput, type SourceExecutionPreview } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { CloudDownloads } from "../cloud/downloads.js";
import type { SourceRuns } from "./runs.js";

interface Row { id: string; source_id: string; source_version: number; request_key: string; force_redownload: number; download_preview_id: string; run_id: string | null; expires_at: number }
const conflict = (message = "执行范围已变化或预览已过期，请重新预览") => new DesktopError("CONFLICT", message);
/** 执行预览绑定有效配置，不编辑草稿或周期策略；确认只写一次性意图。 */
export class SourceExecutionPreviews {
  private accepting = true;
  constructor(private readonly database: CoreDatabase, private readonly downloads: CloudDownloads, private readonly runs: SourceRuns, private readonly now = Date.now) {}
  quiesce() { this.accepting = false; }
  private writable() { if (!this.accepting) throw new DesktopError("INTERRUPTED", "来源执行正在停止", true); }
  private source(id: string) { return this.database.connection.prepare("SELECT s.version,s.paused,s.review_required,v.configuration_json FROM source_rule s JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version WHERE s.id=?").get(id) as { version: number; paused: number; review_required: number; configuration_json: string } | undefined; }
  start(input: CoreInput<"source-rules.preview-execution">): SourceExecutionPreview {
    this.writable(); const db = this.database.connection;
    const repeated = db.prepare("SELECT * FROM source_rule_execution_preview WHERE request_key=?").get(input.requestKey) as Row | undefined;
    if (repeated) { if (repeated.source_id !== input.id || repeated.source_version !== input.expectedVersion || !!repeated.force_redownload !== !!input.forceRedownload) throw conflict("请求标识已用于其他执行预览"); return this.dto(repeated); }
    const source = this.source(input.id);
    if (!source || source.version !== input.expectedVersion || source.paused || source.review_required) throw conflict("请先确认并恢复来源，再预览本次执行");
    const configuration = sourceConfigurationSchema.parse(JSON.parse(source.configuration_json));
    if (configuration.type !== "cloud") throw conflict("本地目录来源请使用整理补扫");
    const preview = this.downloads.previews.start({ accountId: configuration.accountId, remoteRef: configuration.remoteRef, targetGrantId: configuration.downloadRootId, filters: configuration.filters, layout: "drive", requestKey: input.requestKey, forceRedownload: input.forceRedownload });
    const id = randomUUID();
    db.prepare("INSERT INTO source_rule_execution_preview(id,source_id,source_version,request_key,force_redownload,download_preview_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, input.id, source.version, input.requestKey, Number(!!input.forceRedownload), preview.id, this.now() + 900000, new Date(this.now()).toISOString());
    return this.get(id)!;
  }
  get(id: string): SourceExecutionPreview | null {
    const row = this.database.connection.prepare("SELECT * FROM source_rule_execution_preview WHERE id=?").get(id) as Row | undefined;
    return row ? this.dto(row) : null;
  }
  private dto(row: Row): SourceExecutionPreview {
    const underlying = this.downloads.previews.row(row.download_preview_id), download = underlying ? this.downloads.previews.get(underlying.request_key) : null;
    if (!download) throw conflict("执行预览记录已不可用");
    const source = this.source(row.source_id), run = row.run_id ? this.runs.get(row.run_id) : null;
    const version = this.database.connection.prepare("SELECT configuration_json FROM source_rule_version WHERE source_id=? AND version=?").get(row.source_id, row.source_version) as { configuration_json: string };
    const configuration = sourceConfigurationSchema.parse(JSON.parse(version.configuration_json));
    const state = row.run_id ? "APPLIED" : !source || source.version !== row.source_version || source.paused || source.review_required || row.expires_at <= this.now() || download.state === "EXPIRED" ? "EXPIRED" : download.state === "BUILDING" ? "BUILDING" : download.state === "READY" && download.complete && !download.conflicts ? "READY" : "FAILED";
    return { id: row.id, sourceId: row.source_id, sourceVersion: row.source_version, name: configuration.name, forceRedownload: !!row.force_redownload, state, expiresAt: row.expires_at, download, run };
  }
  confirm(input: CoreInput<"source-rules.execute">) {
    this.writable(); const db = this.database.connection;
    return db.transaction(() => {
      const receipt = db.prepare("SELECT preview_id,run_id FROM source_rule_execution_confirmation WHERE request_key=?").get(input.requestKey) as { preview_id: string; run_id: string } | undefined;
      if (receipt) { if (receipt.preview_id !== input.previewId) throw conflict("请求标识已用于其他执行预览"); return this.runs.get(receipt.run_id)!; }
      const row = db.prepare("SELECT * FROM source_rule_execution_preview WHERE id=?").get(input.previewId) as Row | undefined;
      if (!row) throw conflict();
      const preview = this.dto(row);
      if (preview.state === "APPLIED" && preview.run) {
        const runReceipt = db.prepare("SELECT run_id FROM source_rule_run_request WHERE request_key=?").get(input.requestKey) as { run_id: string } | undefined;
        if (runReceipt && runReceipt.run_id !== preview.run.id) throw conflict("请求标识已用于其他执行");
        db.prepare("INSERT INTO source_rule_execution_confirmation VALUES(?,?,?)").run(input.requestKey, row.id, preview.run.id);
        return preview.run;
      }
      if (preview.state !== "READY") throw conflict();
      const underlying = this.downloads.previews.row(row.download_preview_id)!;
      const run = this.runs.enqueue({ id: row.source_id, expectedVersion: row.source_version, requestKey: input.requestKey }, { previewId: underlying.id, previewKey: underlying.request_key, forceRedownload: !!row.force_redownload });
      db.prepare("UPDATE source_rule_execution_preview SET run_id=? WHERE id=? AND run_id IS NULL").run(run.id, row.id);
      db.prepare("INSERT INTO source_rule_execution_confirmation VALUES(?,?,?)").run(input.requestKey, row.id, run.id); return run;
    })();
  }
}
