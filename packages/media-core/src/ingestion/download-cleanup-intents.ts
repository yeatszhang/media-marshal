import { randomUUID } from "node:crypto";
import type { CoreDatabase } from "../infrastructure/database.js";

/** 仅由本版本新确认的整理事务登记；不扫描旧成功记录来推断删除授权。 */
export function authorizeOrganizedDownloadCleanup(database: CoreDatabase, operationId: string, taskId: string) {
  const db = database.connection;
  const operation = db.prepare("SELECT plan_json FROM ingestion_operation WHERE id=?").get(operationId) as { plan_json: string };
  const plan = JSON.parse(operation.plan_json);
  if (!db.prepare("SELECT 1 FROM managed_download_root WHERE id=?").get(plan.source.id)) return;
  const assets = db.prepare("SELECT id FROM ingestion_accessory WHERE operation_id=?").all(operationId) as { id: string }[];
  for (const accessoryId of [null, ...assets.map((asset) => asset.id)]) db.prepare("INSERT INTO download_cleanup_intent VALUES(?,?,?,?,'PENDING',NULL,NULL,?)").run(randomUUID(), operationId, accessoryId, taskId, new Date().toISOString());
}
