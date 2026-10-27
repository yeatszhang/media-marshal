import { z } from "zod";
import { CloudError, cloudFailure } from "@media-marshal/contracts";
import { localFileEvidenceSchema } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { CloudRoots } from "./roots.js";

/** 接收端以 itemId/versionKey 做持久化唯一去重，提交候选事务之后才能返回确认。 */
export interface ManagedIngestionSink {
  canAccept?(input: { itemId: string; versionKey: string }): boolean;
  accept(candidate: { itemId: string; versionKey: string; rootId: string; completedSegments: string[]; sha256: string; size: number }, signal: AbortSignal): Promise<{ candidateId: string }>;
}
interface Delivery { id: string; item_id: string; version_key: string; target_root_id: string; target_segments_json: string; file_evidence_json: string; delivery_attempts: number }

/** 完成记账之外的独立投递；接收端尚未安装时保持 PENDING，不假造整理成功。 */
export class IngestionOutbox {
  private timer?: ReturnType<typeof setInterval>; private flight?: Promise<void>; private closed = false; private abort?: AbortController;
  constructor(private readonly database: CoreDatabase, private readonly roots: CloudRoots, private readonly sink?: ManagedIngestionSink, private readonly now = Date.now) {
    database.connection.prepare("UPDATE ingestion_outbox SET state='PENDING' WHERE state='DELIVERING'").run();
  }
  start() { if (!this.timer) this.timer = setInterval(() => { void this.deliver().catch(() => {}); }, 1000); }
  deliver(): Promise<void> {
    if (this.closed || !this.sink) return Promise.resolve();
    return this.flight ??= this.run().finally(() => { this.flight = undefined; });
  }
  private async run() {
    const db = this.database.connection;
    const rows = db.prepare("SELECT o.*,i.target_root_id,i.target_segments_json,c.file_evidence_json FROM ingestion_outbox o JOIN download_item i ON i.id=o.item_id AND i.version_key=o.version_key JOIN download_commit_intent c ON c.item_id=i.id AND c.state='RECORDED' WHERE o.state='PENDING' AND o.delivery_attempts<3 AND (o.next_attempt_at IS NULL OR o.next_attempt_at<=?) AND i.state='COMPLETED' ORDER BY o.created_at,o.id LIMIT 10").all(new Date(this.now()).toISOString()) as Delivery[];
    for (const row of rows) {
      if (this.closed) break;
      if (this.sink!.canAccept && !this.sink!.canAccept({ itemId: row.item_id, versionKey: row.version_key })) continue;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        db.prepare("UPDATE ingestion_outbox SET state='DELIVERING',delivery_attempts=delivery_attempts+1,updated_at=? WHERE id=? AND state='PENDING'").run(new Date(this.now()).toISOString(), row.id);
        const root = this.roots.files.get(row.target_root_id), segments: string[] = JSON.parse(row.target_segments_json), before = localFileEvidenceSchema.parse(JSON.parse(row.file_evidence_json));
        root.segments(segments); const after = await root.inspectCompleted(segments);
        if (before.volumeId !== after.volumeId || before.inode !== after.inode || before.birthtimeNs !== after.birthtimeNs || before.size !== after.size || before.sha256 !== after.sha256) throw new CloudError("CONFLICT");
        if (this.closed) break;
        const controller = new AbortController(); this.abort = controller;
        const result = await Promise.race([
          this.sink!.accept({ itemId: row.item_id, versionKey: row.version_key, rootId: row.target_root_id, completedSegments: segments, sha256: after.sha256, size: after.size }, controller.signal),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new CloudError("TIMEOUT")); }, 5000); controller.signal.addEventListener("abort", () => reject(new CloudError("INTERRUPTED")), { once: true }); }),
        ]);
        const candidateId = z.uuid().parse(result.candidateId);
        // 即使接收端已经提交，确认事务失败仍保留相同投递键，下一次投递由接收端去重。
        db.prepare("UPDATE ingestion_outbox SET state='ACKNOWLEDGED',candidate_id=?,failure_code=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND state='DELIVERING'").run(candidateId, new Date(this.now()).toISOString(), row.id);
      } catch (error) {
        const failure = cloudFailure(error);
        db.prepare("UPDATE ingestion_outbox SET state='PENDING',failure_code=?,next_attempt_at=?,updated_at=? WHERE id=? AND state!='ACKNOWLEDGED'").run(failure.code, new Date(this.now() + Math.min(30000 * 2 ** row.delivery_attempts, 3600000)).toISOString(), new Date(this.now()).toISOString(), row.id);
      } finally { clearTimeout(timeout); this.abort = undefined; }
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.abort?.abort(); await this.flight?.catch(() => {}); }
}
