import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { DesktopError } from "@media-marshal/contracts";
import { managedRootGrantSchema, type ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import { ManagedRoot, sameVolumeRoot } from "./index.js";

export type AttemptOwner = "ingestion_operation" | "ingestion_accessory" | "download_attempt" | "local_sync_operation";
export class OwnedAttemptCleanup {
  constructor(private readonly database: CoreDatabase) {}
  private authorized(kind: AttemptOwner, expected: ManagedRootGrant) {
    const db = this.database.connection;
    let current: ManagedRootGrant;
    if (kind === "download_attempt" || kind === "local_sync_operation") {
      const row = db.prepare("SELECT canonical_path,volume_identity FROM managed_download_root WHERE id=? AND state='AVAILABLE'").get(expected.id) as { canonical_path: string; volume_identity: string } | undefined;
      if (!row) throw new DesktopError("LOCAL_UNAVAILABLE", "原下载根尚未恢复宿主授权，等待原卷恢复后继续回收", true);
      current = managedRootGrantSchema.parse({ id: expected.id, path: row.canonical_path, volume: JSON.parse(row.volume_identity) });
    } else {
      const row = db.prepare("SELECT grant_json FROM media_target_root WHERE id=? AND available=1").get(expected.id) as { grant_json: string } | undefined;
      if (!row) throw new DesktopError("LOCAL_UNAVAILABLE", "原媒体根尚未恢复宿主授权，等待原卷恢复后继续回收", true);
      current = managedRootGrantSchema.parse(JSON.parse(row.grant_json));
    }
    if (current.path !== expected.path || !sameVolumeRoot(current.volume, expected.volume)) throw new DesktopError("CONFLICT", "暂存目录授权或原卷身份已变化，请核对原作业与原目录后重试");
    return current;
  }
  recordDownload(attemptId: string, rootId: string) {
    const row = this.database.connection.prepare("SELECT canonical_path,volume_identity FROM managed_download_root WHERE id=?").get(rootId) as { canonical_path: string; volume_identity: string } | undefined;
    if (!row) throw new DesktopError("CONFLICT", "下载暂存缺少原受管根所有权，保留文件等待核对");
    this.record("download_attempt", attemptId, attemptId, managedRootGrantSchema.parse({ id: rootId, path: row.canonical_path, volume: JSON.parse(row.volume_identity) }));
  }
  record(kind: AttemptOwner, ownerId: string, attemptId: string, grant: ManagedRootGrant) {
    const db = this.database.connection;
    if (kind !== "download_attempt" && !db.prepare(`SELECT 1 FROM ${kind} WHERE id=? AND attempt_id=? AND ${kind === "local_sync_operation" ? "target_directory_id" : "target_root_id"}=? AND phase='RECORDED'`).get(ownerId, attemptId, grant.id)) throw new DesktopError("CONFLICT", "同步或整理恢复证据未完成记账，不能回收原暂存文件");
    db.prepare("INSERT OR IGNORE INTO owned_attempt_cleanup(owner_kind,owner_id,attempt_id,root_id,grant_json,state,updated_at) VALUES(?,?,?,?,?,'PENDING',?)").run(kind, ownerId, attemptId, grant.id, JSON.stringify(grant), new Date().toISOString());
  }
  async run(kind: AttemptOwner, ownerId: string, supplied?: ManagedRoot) {
    const db = this.database.connection, row = db.prepare("SELECT * FROM owned_attempt_cleanup WHERE owner_kind=? AND owner_id=?").get(kind, ownerId) as { attempt_id: string; grant_json: string; state: string; root_id: string } | undefined;
    if (!row || row.state === "DONE") return;
    let root: ManagedRoot | undefined;
    try {
      const grant = this.authorized(kind, managedRootGrantSchema.parse(JSON.parse(row.grant_json)));
      if (kind === "download_attempt") {
        const attempt = db.prepare("SELECT state,stop_evidence_json FROM download_attempt WHERE id=?").get(row.attempt_id) as { state: string; stop_evidence_json: string | null } | undefined;
        if (!attempt || !["STOPPED", "EXITED"].includes(attempt.state) || !attempt.stop_evidence_json || db.prepare("SELECT 1 FROM download_claim WHERE attempt_id=? UNION SELECT 1 FROM download_attempt_item a JOIN download_commit_intent c ON c.item_id=a.item_id WHERE a.attempt_id=? AND c.state!='RECORDED'").get(row.attempt_id, row.attempt_id)) throw new DesktopError("CONFLICT", "下载写入者或恢复消费者尚未释放，保留所属暂存目录");
      } else if (!db.prepare(`SELECT 1 FROM ${kind} WHERE id=? AND phase='RECORDED' AND attempt_id=?`).get(ownerId, row.attempt_id)) throw new DesktopError("CONFLICT", "整理恢复证据未完成记账，保留所属暂存目录");
      if (supplied && (supplied.grant.path !== grant.path || !sameVolumeRoot(supplied.grant.volume, grant.volume))) throw new DesktopError("LOCAL_UNAVAILABLE", "暂存目录原卷身份变化，恢复原卷后重试", true);
      root = supplied ?? await ManagedRoot.open(grant); await root.check();
      try { const size = await root.ownedAttemptBytes(row.attempt_id); db.prepare("UPDATE owned_attempt_cleanup SET retained_bytes=? WHERE owner_kind=? AND owner_id=?").run(size, kind, ownerId); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.authorized(kind, grant);
      try { await root.cleanupAttempt(row.attempt_id); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await root.check();
        try { await lstat(join(grant.path, ".media-marshal", "staging", row.attempt_id)); throw new DesktopError("CONFLICT", "暂存目录仍存在但缺少可靠所有权标记，请核对原作业后重试"); }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe; }
      }
      db.prepare("UPDATE owned_attempt_cleanup SET state='DONE',failure=NULL,released_bytes=retained_bytes,updated_at=? WHERE owner_kind=? AND owner_id=?").run(new Date().toISOString(), kind, ownerId);
    } catch (error) {
      db.prepare("UPDATE owned_attempt_cleanup SET state=?,failure=?,updated_at=? WHERE owner_kind=? AND owner_id=?").run((error as { code?: string }).code === "LOCAL_UNAVAILABLE" ? "PENDING" : "NEEDS_ATTENTION", `${row.root_id}/${row.attempt_id}：${error instanceof DesktopError ? error.message : "暂存回收失败，请恢复原卷及目录权限后重试"}`.slice(0, 500), new Date().toISOString(), kind, ownerId);
    } finally { if (root && !supplied) await root.close(); }
  }
}
