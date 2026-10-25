import { randomUUID } from "node:crypto";
import { CloudError, type RemoteEntry, type VersionEvidence } from "@media-marshal/contracts";
import { localFileEvidenceSchema, type LocalFileEvidence, type TransferItem } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { CloudRoots } from "./roots.js";
import type { RemoteCatalog } from "./catalog.js";

type Checkpoint = "verified" | "intent" | "linked" | "recorded";
interface Intent { item_id: string; attempt_id: string; account_id: string; version_key: string; file_evidence_json: string; state: string; target_root_id: string; target_segments_json: string }
const version = (entry: RemoteEntry): VersionEvidence | null => entry.version ?? (entry.size === null ? null : { kind: "weak", size: entry.size, modifiedAt: entry.modifiedAt });

/** 文件提交是独立事务边界；业务完成和 outbox 不依赖 Rclone 的成功日志。 */
export class DownloadCommits {
  constructor(private readonly database: CoreDatabase, private readonly roots: CloudRoots, private readonly catalog: Pick<RemoteCatalog, "stat" | "source">, private readonly checkpoint: (point: Checkpoint) => Promise<void> = async () => {}) {}
  private stopped(attemptId: string) {
    const row = this.database.connection.prepare("SELECT state,stop_evidence_json FROM download_attempt WHERE id=?").get(attemptId) as { state: string; stop_evidence_json: string | null } | undefined;
    if (!row || !["STOPPED", "EXITED"].includes(row.state) || !row.stop_evidence_json) throw new CloudError("CONFLICT");
  }
  private async remote(item: TransferItem) {
    const current = this.catalog.source(item.source.binding.accountId, item.source.remoteRef);
    if (current.binding.bindingId !== item.source.binding.bindingId || current.binding.generation !== item.source.binding.generation) throw new CloudError("INTERRUPTED");
    const entry = await this.catalog.stat(item.source.binding.accountId, item.source.remoteRef);
    if (entry.type !== "file" || entry.size !== item.expectedSize || JSON.stringify(version(entry)) !== JSON.stringify(item.source.expectedVersion)) throw new CloudError("REMOTE_CHANGED");
  }
  async verifyAndCommit(attemptId: string, targetRootId: string, item: TransferItem) {
    this.stopped(attemptId);
    const db = this.database.connection, root = this.roots.files.get(targetRootId);
    await this.remote(item);
    const expected = item.source.expectedVersion, evidence = await root.verifyStage(attemptId, item.targetSegments, item.expectedSize, expected?.kind === "hash" ? expected : undefined);
    await this.remote(item); await this.checkpoint("verified");
    this.stopped(attemptId);
    db.transaction(() => {
      const row = db.prepare("SELECT i.version_key FROM download_item i JOIN download_claim c ON c.item_id=i.id WHERE i.id=? AND c.attempt_id=? AND i.target_root_id=? AND i.state='VERIFYING'").get(item.itemId, attemptId, targetRootId) as { version_key: string } | undefined;
      if (!row) throw new CloudError("CONFLICT");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO download_commit_intent(item_id,attempt_id,account_id,version_key,local_sha256,size,file_evidence_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'PREPARED',?,?)")
        .run(item.itemId, attemptId, item.source.binding.accountId, row.version_key, evidence.sha256, evidence.size, JSON.stringify(evidence), now, now);
      db.prepare("UPDATE download_item SET state='COMMITTING',updated_at=? WHERE id=?").run(now, item.itemId);
    })();
    await this.checkpoint("intent"); return this.finish(item.itemId);
  }
  async finish(itemId: string) {
    const db = this.database.connection, intent = db.prepare("SELECT c.*,i.target_root_id,i.target_segments_json FROM download_commit_intent c JOIN download_item i ON i.id=c.item_id WHERE c.item_id=?").get(itemId) as Intent | undefined;
    if (!intent) throw new CloudError("CONFLICT");
    this.stopped(intent.attempt_id);
    const evidence = localFileEvidenceSchema.parse(JSON.parse(intent.file_evidence_json)), root = this.roots.files.get(intent.target_root_id), segments: string[] = JSON.parse(intent.target_segments_json);
    try {
      // 已发布文件必须仍与原暂存 inode、创建时间和摘要吻合；同名同内容的外部文件也不认领。
      const result = await root.commit(intent.attempt_id, segments, evidence);
      await this.checkpoint("linked");
      if (intent.state !== "RECORDED") db.prepare("UPDATE download_commit_intent SET state='COMMITTED',updated_at=? WHERE item_id=?").run(new Date().toISOString(), itemId);
      this.record(intent, result.evidence); await this.checkpoint("recorded"); return result;
    } catch (error) {
      if (intent.state !== "RECORDED") db.transaction(() => {
        db.prepare("UPDATE download_commit_intent SET state='RECONCILING',updated_at=? WHERE item_id=?").run(new Date().toISOString(), itemId);
        db.prepare("UPDATE download_item SET state=?,failure_code=?,updated_at=? WHERE id=? AND state!='COMPLETED'").run(error instanceof CloudError && error.code === "LOCAL_UNAVAILABLE" ? "BLOCKED_LOCAL" : "RECONCILING", error instanceof CloudError ? error.code : "CONFLICT", new Date().toISOString(), itemId);
      })();
      throw error;
    }
  }
  private record(intent: Intent, evidence: LocalFileEvidence) {
    const db = this.database.connection, now = new Date().toISOString();
    db.transaction(() => {
      db.prepare("UPDATE download_item SET state='COMPLETED',local_sha256=?,completed_size=?,failure_code=NULL,updated_at=? WHERE id=? AND version_key=?").run(evidence.sha256, evidence.size, now, intent.item_id, intent.version_key);
      db.prepare("INSERT INTO ingestion_outbox(id,item_id,version_key,state,created_at,updated_at) VALUES(?,?,?,'PENDING',?,?) ON CONFLICT(item_id,version_key) DO NOTHING").run(randomUUID(), intent.item_id, intent.version_key, now, now);
      db.prepare("UPDATE download_commit_intent SET state='RECORDED',updated_at=? WHERE item_id=?").run(now, intent.item_id);
      db.prepare("DELETE FROM download_claim WHERE item_id=? AND attempt_id=?").run(intent.item_id, intent.attempt_id);
    })();
  }
}
