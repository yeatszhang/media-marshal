import { createHash } from "node:crypto";
import { DesktopError, type CoreOutput } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { CloudDownloads } from "../cloud/downloads.js";
import type { PreviewSnapshot } from "../cloud/previews.js";
import { EmbyLibraryFiles, isLibraryVideo } from "./emby-library-files.js";

type Progress = NonNullable<CoreOutput<"sync.job">["libraryRecheck"]>;
interface Recheck extends Progress { requestKey: string; sourceId: string; lifecycle: number; previewId: string; signature: string }
interface Job { id: string; source_id: string; preview_id: string | null; download_job_id: string | null; state: string; snapshot_json: string }
const key = (id: string) => "sync.library-recheck." + id;
const conflict = (message: string) => new DesktopError("CONFLICT", message);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 复核是原同步作业上的持久后台操作，页面卸载不取消，Core 关闭保留重启恢复位置。 */
export class SyncLibraryRechecks {
  private readonly abort = new AbortController();
  constructor(private readonly database: CoreDatabase, private readonly downloads: CloudDownloads, private readonly now = Date.now) {}
  private get(id: string) {
    const row = this.database.connection.prepare("SELECT value FROM app_setting WHERE key=?").get(key(id)) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Recheck : undefined;
  }
  status(id: string): Progress | undefined {
    const state = this.get(id); if (!state) return;
    const { state: phase, checked, total, matched, skippedBytes, failure, updatedAt, relativePath } = state;
    return { state: phase, checked, total, matched, skippedBytes, failure, updatedAt, relativePath };
  }
  busy(id: string) { const state = this.get(id)?.state; return state === "PENDING" || state === "RUNNING"; }
  busyForSource(sourceId: string) {
    return !!this.database.connection.prepare("SELECT 1 FROM app_setting a JOIN sync_job j ON a.key='sync.library-recheck.' || j.id WHERE j.source_id=? AND json_extract(a.value,'$.state') IN ('PENDING','RUNNING') LIMIT 1").get(sourceId);
  }
  blockedReason(id: string): string | null {
    const db = this.database.connection, row = db.prepare("SELECT * FROM sync_job WHERE id=?").get(id) as Job | undefined;
    if (!row) return "同步任务不存在，请刷新列表";
    if (this.busy(id)) return "正在重新核对媒体库，请等待结果；来源保持暂停";
    if (db.prepare("SELECT 1 FROM app_setting WHERE key=?").get(`sync.job.removed.${id}`)) return "此任务已删除，请从来源重新预览";
    if (["DONE", "CANCELED"].includes(row.state)) return "此任务已结束，成功历史保持；如需新检查请从来源重新预览";
    if (JSON.parse(row.snapshot_json).configuration.type !== "cloud") return "本地来源请重新预览执行，以重新检查媒体库";
    const preview = row.preview_id ? this.downloads.previews.row(row.preview_id) : undefined;
    if (!preview) return "原网盘预览不存在，请从来源重新预览";
    if ((JSON.parse(preview.snapshot_json) as PreviewSnapshot).variant) return "显式重新同步不会按普通去重跳过文件";
    const source = db.prepare("SELECT paused,deleted_at FROM sync_source_rule WHERE id=?").get(row.source_id) as { paused: number; deleted_at: string | null } | undefined;
    if (!source || source.deleted_at) return "来源已删除，请先恢复来源并核对配置";
    if (!source.paused) return "请先暂停对应来源，等待在途下载停止后重新核对";
    if (row.download_job_id && (db.prepare("SELECT state FROM download_job WHERE id=?").get(row.download_job_id) as { state: string } | undefined)?.state !== "PAUSED") return "在途下载尚未到达暂停安全点，请稍后重试";
    return null;
  }
  private save(id: string, state: Recheck) {
    state.updatedAt = new Date(this.now()).toISOString();
    this.database.connection.prepare("INSERT INTO app_setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key(id), JSON.stringify(state));
  }
  start(id: string, requestKey: string) {
    const reason = this.blockedReason(id); if (reason) throw conflict(`同步任务 ${id} 无法重新核对：${reason}`);
    const db = this.database.connection, job = db.prepare("SELECT * FROM sync_job WHERE id=?").get(id) as Job;
    const source = db.prepare("SELECT lifecycle_revision FROM sync_source_rule WHERE id=?").get(job.source_id) as { lifecycle_revision: number };
    const preview = this.downloads.previews.row(job.preview_id!)!;
    const snapshot = JSON.parse(preview.snapshot_json) as PreviewSnapshot;
    this.save(id, { state: "PENDING", checked: 0, total: snapshot.items.filter((file) => isLibraryVideo(file.targetSegments.at(-1)!)).length, matched: 0, skippedBytes: 0, failure: null, updatedAt: "", requestKey, sourceId: job.source_id, lifecycle: source.lifecycle_revision, previewId: preview.id, signature: hash([preview.snapshot_json, job.download_job_id, job.snapshot_json]) });
  }
  private assertCurrent(id: string, state: Recheck, full = false) {
    if (this.abort.signal.aborted) throw new DesktopError("INTERRUPTED", "媒体库复核已中断，重启后继续核对原任务", true);
    const db = this.database.connection;
    const row = db.prepare("SELECT j.*,r.paused,r.deleted_at,r.lifecycle_revision FROM sync_job j JOIN sync_source_rule r ON r.id=j.source_id WHERE j.id=?").get(id) as (Job & { paused: number; deleted_at: string | null; lifecycle_revision: number }) | undefined;
    const preview = full ? this.downloads.previews.row(state.previewId) : undefined;
    if (!row || !row.paused || row.deleted_at || row.lifecycle_revision !== state.lifecycle || row.preview_id !== state.previewId || full && (!preview || hash([preview.snapshot_json, row.download_job_id, row.snapshot_json]) !== state.signature) || ["DONE", "CANCELED"].includes(row.state)) throw conflict("复核期间来源、作业或冻结清单已变化，请保持暂停并重新核对");
    if (full && row.download_job_id && (db.prepare("SELECT state FROM download_job WHERE id=?").get(row.download_job_id) as { state: string } | undefined)?.state !== "PAUSED") throw conflict("复核期间原下载未保持暂停，请等待安全点后重新核对");
    return { row, preview: preview! };
  }
  async tick() {
    const pending = this.database.connection.prepare("SELECT key,value FROM app_setting WHERE key LIKE 'sync.library-recheck.%' AND json_extract(value,'$.state') IN ('PENDING','RUNNING') ORDER BY key LIMIT 1").get() as { key: string; value: string } | undefined;
    if (!pending || this.abort.signal.aborted) return;
    const id = pending.key.slice("sync.library-recheck.".length), state = JSON.parse(pending.value) as Recheck;
    try {
      const { row, preview } = this.assertCurrent(id, state, true), snapshot = JSON.parse(preview.snapshot_json) as PreviewSnapshot;
      state.state = "RUNNING"; state.checked = 0; state.matched = 0; state.skippedBytes = 0; this.save(id, state);
      const library = new EmbyLibraryFiles(this.database, this.abort.signal);
      const originalLibrary = new Set(snapshot.items.filter((file) => file.libraryFile).map((file) => file.targetPathKey));
      const completed = new Set((row.download_job_id ? this.database.connection.prepare("SELECT i.target_path_key FROM download_job_item d JOIN download_item i ON i.id=d.item_id WHERE d.job_id=? AND i.state='COMPLETED'").all(row.download_job_id) as { target_path_key: string }[] : []).map((item) => item.target_path_key));
      for (const file of snapshot.items) {
        if (!isLibraryVideo(file.targetSegments.at(-1)!)) continue;
        state.relativePath = file.targetSegments.join("/"); this.save(id, state);
        this.assertCurrent(id, state);
        if (!file.libraryFile && !file.receiptId && !file.reuseItemId && !completed.has(file.targetPathKey)) {
          try {
            const evidence = await library.find(file.targetSegments.at(-1)!, file.expectedSize, undefined, file.source.expectedVersion ?? undefined, file.targetSegments);
            if (evidence) { file.libraryFile = evidence; delete file.libraryIssue; delete file.issue; state.matched++; state.skippedBytes += file.expectedSize; }
          } catch (error) {
            if (error instanceof DesktopError) throw error;
            throw conflict(`无法核对 ${file.targetSegments.join("/").slice(-250)}，请检查原媒体目录后重新核对`);
          }
        }
        state.checked++; this.save(id, state);
      }
      for (const file of snapshot.items) if (file.libraryFile && !originalLibrary.has(file.targetPathKey)) {
        state.relativePath = file.targetSegments.join("/"); this.save(id, state); await library.verify(file.libraryFile);
      }
      this.database.connection.transaction(() => {
        this.assertCurrent(id, state, true);
        if (row.download_job_id) this.downloads.applyLibraryRecheck(row.download_job_id, snapshot);
        // 完成中的共享项可能已被所有者保留为成功，此时据最终清单重算新增跳过数。
        const before = originalLibrary;
        const matched = snapshot.items.filter((file) => file.libraryFile && !before.has(file.targetPathKey));
        state.matched = matched.length; state.skippedBytes = matched.reduce((sum, file) => sum + file.expectedSize, 0);
        this.database.connection.prepare("UPDATE cloud_preview SET snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), preview.id);
        const finished = row.download_job_id ? (this.database.connection.prepare("SELECT state FROM download_job WHERE id=?").get(row.download_job_id) as { state: string }).state === "COMPLETED" : snapshot.items.every((file) => file.libraryFile || file.receiptId || file.reuseItemId);
        this.database.connection.prepare("UPDATE sync_job SET state=?,failure=NULL,updated_at=? WHERE id=?").run(finished ? "DONE" : row.download_job_id ? "RUNNING" : "PENDING", new Date(this.now()).toISOString(), id);
        state.state = "DONE"; state.relativePath = null; this.save(id, state);
      })();
    } catch (error) {
      if (this.abort.signal.aborted) { state.state = "PENDING"; this.save(id, state); return; }
      state.state = "FAILED"; state.failure = error instanceof DesktopError ? error.message.slice(0, 500) : `同步任务 ${id} 的媒体库复核未完成，请恢复原媒体目录并核验授权后重试`;
      state.matched = 0; state.skippedBytes = 0; this.save(id, state);
    }
  }
  close() { this.abort.abort(); }
}
