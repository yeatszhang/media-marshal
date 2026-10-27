import { randomUUID, createHash } from "node:crypto";
import { CloudError, DesktopError, versionEvidenceSchema, type VersionEvidence } from "@media-marshal/contracts";
import { localFileEvidenceSchema, type LocalFileEvidence } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { ManagedRoot } from "../files/index.js";
import { cloudReceiptLocator, recordCloudReceiptOrigins } from "./sync-history.js";
import type { PreviewSnapshot } from "../cloud/previews.js";

export interface SyncReceipt {
  id: string; source_kind: "local" | "cloud"; source_namespace: string; source_object_key: string; source_version_key: string;
  version_json: string; target_directory_id: string; target_slot: string; target_segments_json: string;
  local_sha256: string; size: number; result_kind: "download-item" | "local-sync"; result_id: string;
  request_variant: string; completed_at: string;
}
export type ReceiptLocalState = "PRESENT" | "REMOVED" | "CONFLICT" | "UNAVAILABLE";
const versionKey = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 成功事实不可变；本地现状是独立观测，不能将删除解释成未完成传输。 */
export class SyncReceipts {
  constructor(private readonly database: CoreDatabase, private readonly now = Date.now) {}
  get(id: string) { return this.database.connection.prepare("SELECT * FROM sync_receipt WHERE id=?").get(id) as SyncReceipt | undefined; }
  byResult(kind: SyncReceipt["result_kind"], resultId: string) { return this.database.connection.prepare("SELECT * FROM sync_receipt WHERE result_kind=? AND result_id=?").get(kind, resultId) as SyncReceipt | undefined; }
  find(kind: SyncReceipt["source_kind"], namespace: string, objectKey: string, version: VersionEvidence, targetId: string, slot: string) {
    const parsed = versionEvidenceSchema.parse(version);
    // weak 的 mtime 不是可靠内容版本；同尺寸时间变化不能绕过成功记录。
    return this.database.connection.prepare("SELECT * FROM sync_receipt WHERE source_kind=? AND source_namespace=? AND source_object_key=? AND target_directory_id=? AND target_slot=? AND (source_version_key=? OR (?='weak' AND json_extract(version_json,'$.kind')='weak' AND json_extract(version_json,'$.size')=?)) ORDER BY completed_at DESC,id DESC LIMIT 1")
      .get(kind, namespace, objectKey, targetId, slot, versionKey(parsed), parsed.kind, parsed.kind === "weak" ? parsed.size : null) as SyncReceipt | undefined;
  }
  findCloud(accountId: string, remoteRef: string, version: VersionEvidence, targetId: string, slot: string, bindingId: string) {
    const direct = this.find("cloud", accountId, remoteRef, version, targetId, slot); if (direct) return direct;
    const parsed = versionEvidenceSchema.parse(version);
    return this.database.connection.prepare("SELECT r.* FROM sync_receipt r JOIN sync_receipt_reference a ON a.receipt_id=r.id JOIN sync_history_confirmation c ON c.preview_id=a.preview_id JOIN provider_binding b ON b.id=a.binding_id AND b.state='ACTIVE' WHERE r.source_kind='cloud' AND r.source_namespace=? AND a.binding_id=? AND a.remote_ref=? AND c.account_id=? AND c.generation=b.generation AND r.target_directory_id=? AND r.target_slot=? AND (r.source_version_key=? OR (?='weak' AND json_extract(r.version_json,'$.kind')='weak' AND json_extract(r.version_json,'$.size')=?)) ORDER BY r.completed_at DESC,r.id DESC LIMIT 1")
      .get(accountId, bindingId, remoteRef, accountId, targetId, slot, versionKey(parsed), parsed.kind, parsed.kind === "weak" ? parsed.size : null) as SyncReceipt | undefined;
  }
  pendingCloudHistory(accountId: string, remoteRef: string, version: VersionEvidence, targetId: string, slot: string, bindingId: string) {
    const identity = cloudReceiptLocator(this.database.connection, bindingId, remoteRef, accountId); if (!identity) return;
    const parsed = versionEvidenceSchema.parse(version);
    return this.database.connection.prepare("SELECT r.* FROM sync_receipt r JOIN sync_receipt_origin o ON o.receipt_id=r.id WHERE r.source_kind='cloud' AND r.source_namespace=? AND o.account_id=? AND o.object_namespace=? AND o.locator_key=? AND r.target_directory_id=? AND r.target_slot=? AND (r.source_version_key=? OR (?='weak' AND json_extract(r.version_json,'$.kind')='weak' AND json_extract(r.version_json,'$.size')=?)) ORDER BY r.completed_at DESC,r.id DESC LIMIT 1")
      .get(accountId, accountId, identity.namespace, identity.key, targetId, slot, versionKey(parsed), parsed.kind, parsed.kind === "weak" ? parsed.size : null) as SyncReceipt | undefined;
  }
  /** 只在来源确认事务内调用；范围、版本与授权由持久预览重新核对，页面只提供明确接受。 */
  confirmHistory(previewId: string, requestKey: string, accepted?: boolean) {
    if (!this.database.connection.inTransaction) throw new Error("同步历史确认必须与来源配置在同一事务提交");
    const db = this.database.connection, row = db.prepare("SELECT account_id,remote_root_ref,target_root_id,snapshot_json,state,expires_at FROM cloud_preview WHERE id=?").get(previewId) as { account_id: string; remote_root_ref: string; target_root_id: string; snapshot_json: string; state: string; expires_at: string } | undefined;
    if (!row) throw new DesktopError("CONFLICT", "同步历史预览已不存在，请重新预览");
    const snapshot: PreviewSnapshot = JSON.parse(row.snapshot_json), pending = snapshot.items.filter((item) => item.historyPending && item.receiptId);
    if (!pending.length) { if (accepted) throw new DesktopError("CONFLICT", "本次预览没有需要确认的登录历史，请刷新预览"); return; }
    if (!accepted) throw new DesktopError("CONFLICT", "请核对重新登录的账号与目录，并确认沿用原同步历史");
    if (snapshot.variant || !snapshot.complete || snapshot.failure || !["READY", "CONFIRMED"].includes(row.state) || row.expires_at <= new Date(this.now()).toISOString() || !db.prepare("SELECT 1 FROM provider_binding b JOIN cloud_account a ON a.id=b.account_id WHERE b.id=? AND b.account_id=? AND b.generation=? AND b.state='ACTIVE' AND a.status IN ('READY','RESELECT_REQUIRED')").get(snapshot.binding.bindingId, row.account_id, snapshot.binding.generation)) throw new DesktopError("CONFLICT", "账号授权或目录预览已变化，请重新选择并预览");
    const selected = cloudReceiptLocator(db, snapshot.binding.bindingId, row.remote_root_ref, row.account_id); if (!selected) throw new CloudError("CONFLICT");
    db.prepare("INSERT INTO sync_history_confirmation VALUES(?,?,?,?,?,?,?,?)").run(previewId, requestKey, row.account_id, snapshot.binding.bindingId, snapshot.binding.generation, row.remote_root_ref, row.target_root_id, new Date(this.now()).toISOString());
    for (const item of pending) {
      if (item.issue || !item.source.expectedVersion || item.source.binding.bindingId !== snapshot.binding.bindingId || item.source.binding.generation !== snapshot.binding.generation) throw new CloudError("CONFLICT");
      const receipt = this.pendingCloudHistory(row.account_id, item.source.remoteRef, item.source.expectedVersion, row.target_root_id, item.targetPathKey, snapshot.binding.bindingId);
      if (!receipt || receipt.id !== item.receiptId) throw new DesktopError("CONFLICT", "待沿用的文件历史已变化，请重新预览");
      db.prepare("INSERT OR IGNORE INTO sync_receipt_reference VALUES(?,?,?,?)").run(receipt.id, snapshot.binding.bindingId, item.source.remoteRef, previewId);
    }
  }
  record(input: Omit<SyncReceipt, "id" | "local_sha256" | "size">, evidence: LocalFileEvidence) {
    const parsed = localFileEvidenceSchema.parse(evidence), db = this.database.connection;
    return db.transaction(() => {
      const prior = this.byResult(input.result_kind, input.result_id);
      if (prior) {
        if (prior.source_kind !== input.source_kind || prior.source_namespace !== input.source_namespace || prior.source_object_key !== input.source_object_key || prior.source_version_key !== input.source_version_key || prior.target_directory_id !== input.target_directory_id || prior.target_slot !== input.target_slot || prior.target_segments_json !== input.target_segments_json || prior.request_variant !== input.request_variant || prior.size !== parsed.size || prior.local_sha256 !== parsed.sha256) throw new CloudError("CONFLICT");
        const stored = db.prepare("SELECT evidence_json FROM sync_receipt_evidence WHERE receipt_id=?").get(prior.id) as { evidence_json: string } | undefined;
        if (stored) {
          const before = localFileEvidenceSchema.parse(JSON.parse(stored.evidence_json));
          if (before.volumeId !== parsed.volumeId || before.inode !== parsed.inode || before.birthtimeNs !== parsed.birthtimeNs) throw new CloudError("CONFLICT");
        } else db.prepare("INSERT INTO sync_receipt_evidence VALUES(?,?)").run(prior.id, JSON.stringify(parsed));
        if (input.source_kind === "cloud") recordCloudReceiptOrigins(db, prior.id, input.source_namespace, input.source_object_key);
        return prior;
      }
      const id = randomUUID();
      db.prepare("INSERT INTO sync_receipt VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, input.source_kind, input.source_namespace, input.source_object_key, input.source_version_key, input.version_json, input.target_directory_id, input.target_slot, input.target_segments_json, parsed.sha256, parsed.size, input.completed_at, input.result_kind, input.result_id, input.request_variant);
      db.prepare("INSERT INTO sync_receipt_evidence VALUES(?,?)").run(id, JSON.stringify(parsed));
      if (input.source_kind === "cloud") recordCloudReceiptOrigins(db, id, input.source_namespace, input.source_object_key);
      return this.get(id)!;
    })();
  }
  recordDownload(itemId: string, evidence: LocalFileEvidence) {
    const row = this.database.connection.prepare("SELECT * FROM download_item WHERE id=? AND state='COMPLETED'").get(itemId) as { id: string; account_id: string; remote_ref: string; version_key: string; version_json: string; target_root_id: string; target_path_key: string; target_segments_json: string; local_sha256: string; completed_size: number; updated_at: string; request_variant: string } | undefined;
    if (!row || row.local_sha256 !== evidence.sha256 || row.completed_size !== evidence.size) throw new CloudError("CONFLICT");
    return this.record({ source_kind: "cloud", source_namespace: row.account_id, source_object_key: row.remote_ref, source_version_key: row.version_key, version_json: row.version_json, target_directory_id: row.target_root_id, target_slot: row.target_path_key, target_segments_json: row.target_segments_json, completed_at: row.updated_at, result_kind: "download-item", result_id: row.id, request_variant: row.request_variant }, evidence);
  }
  async observe(receipt: SyncReceipt, root: ManagedRoot): Promise<ReceiptLocalState> {
    let state: ReceiptLocalState;
    try {
      if (root.grant.id !== receipt.target_directory_id) throw new CloudError("LOCAL_UNAVAILABLE");
      await root.check();
      let after: LocalFileEvidence;
      try { after = await root.inspectCompleted(JSON.parse(receipt.target_segments_json)); }
      catch (error) {
        // 缺盘／根替换不等于删除。只有原根在失败后仍有效，ENOENT 才能记为本地移除。
        await root.check();
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.observed(receipt.id, "REMOVED"); return "REMOVED"; }
        throw error;
      }
      const stored = this.database.connection.prepare("SELECT evidence_json FROM sync_receipt_evidence WHERE receipt_id=?").get(receipt.id) as { evidence_json: string } | undefined;
      const before = stored ? localFileEvidenceSchema.parse(JSON.parse(stored.evidence_json)) : null;
      state = before && before.volumeId === after.volumeId && before.inode === after.inode && before.birthtimeNs === after.birthtimeNs && receipt.local_sha256 === after.sha256 && receipt.size === after.size ? "PRESENT" : "CONFLICT";
    } catch (error) { state = error instanceof CloudError && error.code === "CONFLICT" ? "CONFLICT" : "UNAVAILABLE"; }
    this.observed(receipt.id, state); return state;
  }
  private observed(id: string, state: ReceiptLocalState) {
    this.database.connection.prepare("INSERT INTO sync_receipt_local_state VALUES(?,?,?) ON CONFLICT(receipt_id) DO UPDATE SET state=excluded.state,checked_at=excluded.checked_at").run(id, state, new Date(this.now()).toISOString());
  }
}
