import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { CoreDatabase } from "../../packages/media-core/dist/infrastructure/database.js";
import { DownloadCleanupEvidence } from "../../packages/media-core/dist/ingestion/download-cleanup-evidence.js";
import { ManagedRoot } from "../../packages/media-core/dist/files/index.js";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
// 窗口测试只允许已关闭客户端的自建临时配置，避免误用个人资料库。
const directory = dirname(dirname(resolve(config.database)));
if (!basename(directory).startsWith("marshal-cleanup-window-") || resolve(config.database) !== join(directory, "data", "desktop.sqlite3")) throw new Error("清理测试夹具仅支持指定的隔离配置");
const db = await CoreDatabase.open(config.database);
let root;
try {
  const row = db.connection.prepare("SELECT canonical_path,volume_identity FROM managed_download_root WHERE id=?").get(config.rootId);
  root = await ManagedRoot.open({ id: config.rootId, path: row.canonical_path, volume: JSON.parse(row.volume_identity) });
  const receipts = [];
  for (const segments of config.segments) {
    const evidence = (await root.inspectForRelocation(["completed", ...segments])).evidence;
    const id = randomUUID(), version = { kind: "weak", size: evidence.size, modifiedAt: null }, key = createHash("sha256").update(JSON.stringify(version)).digest("hex");
    db.connection.prepare("INSERT INTO sync_receipt VALUES(?,'cloud','隔离测试账户',?,?,?, ?,?,?, ?,?,?, 'download-item',?,'版本')").run(id, id, key, JSON.stringify(version), config.rootId, root.slotKey(segments), JSON.stringify(segments), evidence.sha256, evidence.size, new Date().toISOString(), randomUUID());
    db.connection.prepare("INSERT INTO sync_receipt_evidence VALUES(?,?)").run(id, JSON.stringify(evidence)); receipts.push(id);
  }
  const verification = new DownloadCleanupEvidence(db), plan = await verification.prepare(receipts[0], null, "HISTORICAL_PREVIEW"), cleanup = verification.journal.create(receipts[0], null, plan);
  verification.journal.fail(cleanup.id, "隔离测试故障：媒体库副本的原卷曾失联；恢复原卷后重试此项清理");
  process.stdout.write(JSON.stringify({ receiptIds: receipts, cleanupId: cleanup.id }));
} finally { await root?.close(); db.close(); }
