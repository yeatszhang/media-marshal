import type Database from "better-sqlite3";
import { localFileEvidenceSchema } from "@media-marshal/contracts/internal";

export const syncReceiptMigrationSql = `
CREATE TABLE sync_receipt_evidence (
 receipt_id TEXT PRIMARY KEY REFERENCES sync_receipt(id), evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json))
);
CREATE TRIGGER sync_receipt_evidence_immutable BEFORE UPDATE ON sync_receipt_evidence
BEGIN SELECT RAISE(ABORT,'同步成功的文件证据不可修改'); END;
CREATE TABLE sync_receipt_local_state (
 receipt_id TEXT PRIMARY KEY REFERENCES sync_receipt(id),
 state TEXT NOT NULL CHECK(state IN ('PRESENT','REMOVED','CONFLICT','UNAVAILABLE')),
 checked_at TEXT NOT NULL
);
CREATE TABLE download_job_receipt (
 job_id TEXT NOT NULL REFERENCES download_job(id), receipt_id TEXT NOT NULL REFERENCES sync_receipt(id),
 PRIMARY KEY(job_id,receipt_id)
);
`;

export function migrateSyncReceiptEvidence(db: Database.Database) {
  let cursor = "";
  for (;;) {
    const rows = db.prepare("SELECT r.id,r.local_sha256,r.size,c.file_evidence_json FROM sync_receipt r JOIN download_commit_intent c ON r.result_kind='download-item' AND c.item_id=r.result_id AND c.state='RECORDED' WHERE r.id>? ORDER BY r.id LIMIT 250").all(cursor) as { id: string; local_sha256: string; size: number; file_evidence_json: string }[];
    if (!rows.length) break; cursor = rows.at(-1)!.id;
    for (const row of rows) {
      const evidence = localFileEvidenceSchema.safeParse(JSON.parse(row.file_evidence_json));
      if (evidence.success && evidence.data.sha256 === row.local_sha256 && evidence.data.size === row.size) db.prepare("INSERT INTO sync_receipt_evidence VALUES(?,?)").run(row.id, JSON.stringify(evidence.data));
    }
  }
}
