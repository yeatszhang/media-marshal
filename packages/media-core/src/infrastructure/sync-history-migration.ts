import type Database from "better-sqlite3";
import { recordCloudReceiptOrigins } from "../sources/sync-history.js";

export const syncHistoryMigrationSql = `
CREATE TABLE sync_receipt_origin (
 receipt_id TEXT NOT NULL REFERENCES sync_receipt(id), account_id TEXT NOT NULL,
 object_namespace TEXT NOT NULL, locator_key TEXT NOT NULL,
 PRIMARY KEY(receipt_id,object_namespace,locator_key)
);
CREATE INDEX sync_receipt_origin_lookup ON sync_receipt_origin(account_id,object_namespace,locator_key);
CREATE TRIGGER sync_receipt_origin_immutable BEFORE UPDATE ON sync_receipt_origin
BEGIN SELECT RAISE(ABORT,'成功收据的来源线索不可修改'); END;
CREATE TABLE sync_history_confirmation (
 preview_id TEXT PRIMARY KEY REFERENCES cloud_preview(id), request_key TEXT NOT NULL UNIQUE,
 account_id TEXT NOT NULL REFERENCES cloud_account(id), binding_id TEXT NOT NULL REFERENCES provider_binding(id),
 generation TEXT NOT NULL, remote_root_ref TEXT NOT NULL, target_root_id TEXT NOT NULL,
 confirmed_at TEXT NOT NULL
);
CREATE TRIGGER sync_history_confirmation_immutable BEFORE UPDATE ON sync_history_confirmation
BEGIN SELECT RAISE(ABORT,'历史沿用确认不可修改'); END;
CREATE TABLE sync_receipt_reference (
 receipt_id TEXT NOT NULL REFERENCES sync_receipt(id), binding_id TEXT NOT NULL REFERENCES provider_binding(id),
 remote_ref TEXT NOT NULL, preview_id TEXT NOT NULL REFERENCES sync_history_confirmation(preview_id),
 PRIMARY KEY(receipt_id,binding_id,remote_ref)
);
CREATE INDEX sync_receipt_reference_lookup ON sync_receipt_reference(binding_id,remote_ref,receipt_id);
CREATE TRIGGER sync_receipt_reference_immutable BEFORE UPDATE ON sync_receipt_reference
BEGIN SELECT RAISE(ABORT,'成功收据的授权关联不可修改'); END;
`;

export function migrateSyncHistory(db: Database.Database) {
  let cursor = "";
  for (;;) {
    const rows = db.prepare("SELECT id,source_namespace,source_object_key FROM sync_receipt WHERE source_kind='cloud' AND id>? ORDER BY id LIMIT 250").all(cursor) as { id: string; source_namespace: string; source_object_key: string }[];
    if (!rows.length) break; cursor = rows.at(-1)!.id;
    for (const row of rows) recordCloudReceiptOrigins(db, row.id, row.source_namespace, row.source_object_key);
  }
}
