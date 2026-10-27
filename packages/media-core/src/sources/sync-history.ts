import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { CloudError } from "@media-marshal/contracts";
import { remoteLocatorSchema } from "@media-marshal/contracts/internal";

/** 路径身份只作为待人工核对的历史线索，不能证明两次登录属于同一个账号。 */
export function cloudReceiptLocator(db: Database.Database, bindingId: string, remoteRef: string, accountId: string) {
  const row = db.prepare("SELECT m.locator_json,b.object_namespace FROM remote_binding m JOIN provider_binding b ON b.id=m.binding_id WHERE m.binding_id=? AND m.remote_ref=? AND m.account_id=? AND b.account_id=m.account_id").get(bindingId, remoteRef, accountId) as { locator_json: string; object_namespace: string | null } | undefined;
  if (!row) return null;
  const locator = remoteLocatorSchema.parse(JSON.parse(row.locator_json));
  if (locator.kind === "stable-id" && !row.object_namespace) return null;
  return { key: createHash("sha256").update(JSON.stringify(locator)).digest("hex"), namespace: locator.kind === "path" ? "path" : row.object_namespace!, locator };
}

export function recordCloudReceiptOrigins(db: Database.Database, receiptId: string, accountId: string, remoteRef: string) {
  const rows = db.prepare("SELECT binding_id FROM remote_binding WHERE account_id=? AND remote_ref=? ORDER BY binding_id LIMIT 1001").all(accountId, remoteRef) as { binding_id: string }[];
  if (rows.length > 1000) throw new CloudError("UNSUPPORTED_CAPABILITY");
  for (const row of rows) {
    const identity = cloudReceiptLocator(db, row.binding_id, remoteRef, accountId);
    if (identity) db.prepare("INSERT OR IGNORE INTO sync_receipt_origin VALUES(?,?,?,?)").run(receiptId, accountId, identity.namespace, identity.key);
  }
}
