import { randomUUID } from "node:crypto";
import { CloudError, cloudFailure, cloudFiltersSchema, type CloudFailure, type DownloadPreview, type CloudInput, type RemoteEntry } from "@media-marshal/contracts";
import { localFileEvidenceSchema, type BindingRef, type TransferItem } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { RemoteCatalog } from "./catalog.js";
import type { CloudRoots } from "./roots.js";
import { planOnce } from "./planning.js";
import { SyncReceipts } from "../sources/sync-receipts.js";

export interface PreviewSnapshot {
  binding: BindingRef; name: string; complete: boolean; failure: CloudFailure | null;
  rootType?: "file" | "directory"; variant?: string; filters?: { extensions: string[]; names?: string[] }; layout?: "selection" | "drive"; selectionPath?: string;
  items: (TransferItem & { versionKey: string; targetPathKey: string; reuseItemId?: string; existingItemId?: string; receiptId?: string; localRemoved?: boolean; issue?: CloudFailure })[];
  policy: { maxAttempts: number; retryBaseMs: number };
}
export interface PreviewRow { id: string; account_id: string; remote_root_ref: string; target_root_id: string; request_key: string; state: string; expires_at: string; snapshot_json: string }
export class DownloadPreviews {
  private flights = new Map<string, Promise<unknown>>(); private cancelled = new Set<string>(); private closed = false;
  constructor(private readonly database: CoreDatabase, private readonly catalog: RemoteCatalog, private readonly roots: CloudRoots, private readonly now = Date.now) {
    database.connection.prepare("UPDATE cloud_preview SET state='EXPIRED' WHERE state='BUILDING'").run();
  }
  row(id: string) { return this.database.connection.prepare("SELECT * FROM cloud_preview WHERE id=?").get(id) as PreviewRow | undefined; }
  get(requestKey: string) {
    const row = this.database.connection.prepare("SELECT * FROM cloud_preview WHERE request_key=?").get(requestKey) as PreviewRow | undefined;
    return row ? this.dto(row) : null;
  }
  private dto(row: PreviewRow): DownloadPreview {
    const snapshot: PreviewSnapshot = JSON.parse(row.snapshot_json);
    const localRemovedFiles = snapshot.items.filter((item) => item.localRemoved).length;
    return { id: row.id, accountId: row.account_id, remoteRef: row.remote_root_ref, targetGrantId: row.target_root_id, files: snapshot.items.length, bytes: snapshot.items.reduce((sum, item) => sum + item.expectedSize, 0), complete: snapshot.complete, weakComparison: snapshot.items.some((item) => item.source.expectedVersion?.kind === "weak"), expiresAt: row.expires_at, state: snapshot.failure ? "FAILED" : row.state === "CONFIRMED" ? "CONFIRMED" : row.expires_at <= new Date(this.now()).toISOString() ? "EXPIRED" : row.state as DownloadPreview["state"], failure: snapshot.failure, reuseFiles: snapshot.items.filter((item) => item.reuseItemId || item.receiptId).length, conflicts: snapshot.items.filter((item) => item.issue).length, forceRedownload: !!snapshot.variant, destinationPrefix: snapshot.variant ? `completed/redownload-${row.id}` : "completed", selectionPath: snapshot.selectionPath ?? snapshot.name, layout: snapshot.layout ?? "selection", ...(localRemovedFiles ? { localRemovedFiles } : {}) };
  }
  start(input: CloudInput<"cloud.downloads.preview">): DownloadPreview {
    if (this.closed) throw new CloudError("INTERRUPTED");
    const previous = this.database.connection.prepare("SELECT * FROM cloud_preview WHERE request_key=?").get(input.requestKey) as PreviewRow | undefined;
    const filters = cloudFiltersSchema.parse(input.filters); filters.extensions = [...new Set(filters.extensions)].sort(); filters.names = [...new Set(filters.names)].sort();
    if (previous) {
      const snapshot: PreviewSnapshot = JSON.parse(previous.snapshot_json);
      if (previous.account_id !== input.accountId || previous.remote_root_ref !== input.remoteRef || previous.target_root_id !== input.targetGrantId || JSON.stringify(cloudFiltersSchema.parse(snapshot.filters)) !== JSON.stringify(filters) || !!snapshot.variant !== !!input.forceRedownload || (snapshot.layout ?? "selection") !== (input.layout ?? "selection")) throw new CloudError("CONFLICT");
      return this.dto(previous);
    }
    if (this.flights.size >= 4) throw new CloudError("CONFLICT");
    const root = this.roots.files.get(input.targetGrantId), source = this.catalog.source(input.accountId, input.remoteRef), id = randomUUID(), now = new Date(this.now()).toISOString();
    const snapshot: PreviewSnapshot = { binding: source.binding, name: "", items: [], complete: false, failure: null, variant: input.forceRedownload ? `force:${id}` : "", filters, layout: input.layout ?? "selection", policy: { maxAttempts: 3, retryBaseMs: 1000 } };
    const row: PreviewRow = { id, account_id: input.accountId, remote_root_ref: input.remoteRef, target_root_id: input.targetGrantId, request_key: input.requestKey, state: "BUILDING", expires_at: new Date(this.now() + 15 * 60 * 1000).toISOString(), snapshot_json: JSON.stringify(snapshot) };
    this.database.connection.prepare("INSERT INTO cloud_preview(id,account_id,remote_root_ref,target_root_id,request_key,snapshot_json,state,configuration_version,created_at,expires_at) VALUES(?,?,?,?,?,?,'BUILDING',1,?,?)")
      .run(id, input.accountId, input.remoteRef, input.targetGrantId, input.requestKey, row.snapshot_json, now, row.expires_at);
    const task = this.scan(row, snapshot, root); this.flights.set(id, task); void task.finally(() => { this.flights.delete(id); this.cancelled.delete(id); }).catch(() => {});
    return this.dto(row);
  }
  private async scan(row: PreviewRow, snapshot: PreviewSnapshot, root: ReturnType<CloudRoots["files"]["get"]>) {
    const save = (state: string) => this.database.connection.prepare("UPDATE cloud_preview SET snapshot_json=?,state=? WHERE id=?").run(JSON.stringify(snapshot), state, row.id);
    try {
      const selected = await this.catalog.stat(row.account_id, row.remote_root_ref); snapshot.name = selected.name; snapshot.rootType = selected.type;
      const prefix = snapshot.variant ? [`redownload-${row.id}`] : [], selection = snapshot.layout === "drive" ? this.catalog.relativePath(row.account_id, selected.ref) : [selected.name]; snapshot.selectionPath = selection.join("/");
      const queue: { entry: RemoteEntry; parts: string[] }[] = [{ entry: selected, parts: [...prefix, ...selection] }], seen = new Set<string>(); let bytes = 0, requiredBytes = 0, snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot)) + 4096;
      while (queue.length) {
        if (this.closed || this.cancelled.has(row.id)) throw new CloudError("INTERRUPTED");
        const current = queue.shift()!;
        if (seen.has(current.entry.ref) || seen.size >= 10000) throw new CloudError("UNSUPPORTED_CAPABILITY"); seen.add(current.entry.ref);
        if (current.parts.length) root.segments(current.parts);
        if (current.entry.type === "file") {
          const extensions = snapshot.filters?.extensions ?? [];
          if (extensions.length && !extensions.includes(current.entry.name.split(".").at(-1)!.toLowerCase())) continue;
          if (snapshot.filters?.names?.length && !snapshot.filters.names.includes(current.entry.name)) continue;
          const source = this.catalog.source(row.account_id, current.entry.ref);
          if (source.binding.generation !== snapshot.binding.generation) throw new CloudError("INTERRUPTED");
          const plan = planOnce({ jobId: row.id, requestKey: row.request_key, attemptId: randomUUID(), binding: snapshot.binding, targetGrantId: row.target_root_id, files: [{ entry: current.entry, locator: source.locator, mapping: { segments: current.parts, slotKey: root.slotKey(current.parts) } }] });
          const item = { ...plan.items[0]! } as PreviewSnapshot["items"][number], db = this.database.connection;
          const previous = db.prepare("SELECT i.id,i.state,c.file_evidence_json FROM download_item i LEFT JOIN download_commit_intent c ON c.item_id=i.id AND c.state='RECORDED' WHERE i.account_id=? AND i.remote_ref=? AND i.version_key=? AND i.request_variant=? AND i.target_root_id=? AND i.target_path_key=?").get(row.account_id, current.entry.ref, item.versionKey, snapshot.variant ?? "", row.target_root_id, item.targetPathKey) as { id: string; state: string; file_evidence_json: string | null } | undefined;
          if (previous) item.existingItemId = previous.id;
          const receipts = new SyncReceipts(this.database, this.now), receipt = !snapshot.variant && item.source.expectedVersion ? receipts.find("cloud", row.account_id, current.entry.ref, item.source.expectedVersion, row.target_root_id, item.targetPathKey) : undefined;
          if (receipt) {
            const state = await receipts.observe(receipt, root);
            if (state === "PRESENT" || state === "REMOVED") {
              item.receiptId = receipt.id; item.localRemoved = state === "REMOVED";
              if (db.prepare("SELECT 1 FROM download_item WHERE id=?").get(receipt.result_id)) item.reuseItemId = receipt.result_id;
            } else {
              item.issue = cloudFailure(new CloudError(state === "UNAVAILABLE" ? "LOCAL_UNAVAILABLE" : "CONFLICT"));
              if (state === "CONFLICT") db.prepare("UPDATE download_item SET state='RECONCILING',failure_code='CONFLICT',updated_at=? WHERE id=? AND state='COMPLETED'").run(new Date(this.now()).toISOString(), receipt.result_id);
            }
          } else if (previous?.state === "COMPLETED") {
            try {
              if (!previous.file_evidence_json) throw new CloudError("CONFLICT");
              const before = localFileEvidenceSchema.parse(JSON.parse(previous.file_evidence_json)), after = await root.inspectCompleted(item.targetSegments);
              if (before.volumeId !== after.volumeId || before.inode !== after.inode || before.birthtimeNs !== after.birthtimeNs || before.sha256 !== after.sha256 || before.size !== after.size) throw new CloudError("CONFLICT");
              item.reuseItemId = previous.id;
              // 摘要及归属仍吻合时，允许更新无内容变化的时间戳证据。
              db.prepare("UPDATE download_commit_intent SET file_evidence_json=?,updated_at=? WHERE item_id=? AND state='RECORDED'").run(JSON.stringify(after), new Date(this.now()).toISOString(), previous.id);
            } catch {
              item.issue = cloudFailure(new CloudError("CONFLICT"));
              db.prepare("UPDATE download_item SET state='RECONCILING',failure_code='CONFLICT',updated_at=? WHERE id=? AND state='COMPLETED'").run(new Date(this.now()).toISOString(), previous.id);
            }
          } else if (previous && ["RUNNING", "VERIFYING", "COMMITTING", "QUEUED", "RETRY_WAIT", "PAUSED"].includes(previous.state)) {
            // 重叠范围共享已存在的需求，不把在途占位解释为目标冲突。
          } else {
            try { await root.assertVacant(item.targetSegments); } catch (error) { item.issue = cloudFailure(error); }
          }
          if (!item.reuseItemId && !item.receiptId && !item.issue) requiredBytes += current.entry.size!;
          snapshotBytes += Buffer.byteLength(JSON.stringify(item)) + 1;
          if (snapshotBytes > 16 * 1024 * 1024) throw new CloudError("UNSUPPORTED_CAPABILITY");
          snapshot.items.push(item); bytes += current.entry.size!;
          if (!Number.isSafeInteger(bytes)) throw new CloudError("UNSUPPORTED_CAPABILITY");
        } else {
          let cursor: string | null = null;
          do {
            if (this.closed || this.cancelled.has(row.id)) throw new CloudError("INTERRUPTED");
            const page = await this.catalog.list({ accountId: row.account_id, parentRef: current.entry.ref, cursor, pageSize: 100 }, row.id);
            for (const entry of page.items) queue.push({ entry, parts: [...current.parts, entry.name] });
            if (queue.length + seen.size > 10000) throw new CloudError("UNSUPPORTED_CAPABILITY");
            cursor = page.nextCursor;
            if (!cursor && !page.complete) throw new CloudError("NETWORK_UNAVAILABLE");
          } while (cursor);
        }
        // 有界预览，不将不完整范围计为最终总量；失败时仍保留已枚举计数。
        if (snapshot.items.length % 100 === 0) save("BUILDING");
      }
      root.assertMappings(snapshot.items.map((item) => item.targetSegments));
      await this.roots.budget(row.target_root_id, requiredBytes);
      if (this.closed || this.cancelled.has(row.id)) throw new CloudError("INTERRUPTED");
      snapshot.complete = true; save("READY");
    } catch (error) { snapshot.failure = cloudFailure(error); snapshot.complete = false; save("EXPIRED"); }
  }
  cancel(id: string) { if (this.flights.has(id)) this.cancelled.add(id); this.database.connection.prepare("UPDATE cloud_preview SET state='EXPIRED' WHERE id=? AND state IN ('BUILDING','READY')").run(id); }
  async close() { this.closed = true; await Promise.allSettled([...this.flights.values()]); }
}
