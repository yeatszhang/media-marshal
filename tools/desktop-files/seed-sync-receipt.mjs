// 仅供隔离窗口验收：使用已由 Main 授权的测试根准备成功收据，再移除本地副本。
// 这份夹具验证 DTO／页面恢复，不作为真实网盘传输验收。
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CoreDatabase } from "../../packages/media-core/dist/infrastructure/database.js";
import { CloudRoots } from "../../packages/media-core/dist/cloud/roots.js";
import { SyncReceipts } from "../../packages/media-core/dist/sources/sync-receipts.js";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const db = await CoreDatabase.open(config.database, undefined, { exclusiveOwner: true }), roots = new CloudRoots(db);
try {
  const grant = roots.bootstrap().find((root) => root.id === config.rootId); assert(grant); await roots.authorize(grant);
  const root = roots.files.get(grant.id), attempt = randomUUID(), name = "已同步且本地移除的中文电影.mkv", bytes = Buffer.from("隔离窗口收据夹具"), stage = await root.prepareStage(attempt);
  await writeFile(join(stage, name), bytes); const evidence = await root.verifyStage(attempt, [name], bytes.length); await root.commit(attempt, [name], evidence);
  const account = randomUUID(), remote = randomUUID(), preview = randomUUID(), job = randomUUID(), item = randomUUID(), stamp = new Date().toISOString(), version = { kind: "hash", algorithm: "sha256", value: evidence.sha256 };
  db.connection.transaction(() => {
    db.connection.prepare("INSERT INTO cloud_account(id,name,provider_kind,status,created_at,updated_at) VALUES(?,'隔离窗口账号','quark','DISCONNECTED',?,?)").run(account, stamp, stamp);
    db.connection.prepare("INSERT INTO remote_entry(id,account_id,name,type,size,observed_at) VALUES(?,?,?,'file',?,?)").run(remote, account, name, bytes.length, stamp);
    db.connection.prepare("INSERT INTO cloud_preview(id,account_id,remote_root_ref,target_root_id,request_key,snapshot_json,state,configuration_version,created_at,expires_at) VALUES(?,?,?,?,?,?,'CONFIRMED',1,?,?)").run(preview, account, remote, grant.id, randomUUID(), JSON.stringify({ name, items: [], complete: true, failure: null }), stamp, stamp);
    db.connection.prepare("INSERT INTO download_job(id,account_id,preview_id,request_key,state,configuration_version,created_at,updated_at) VALUES(?,?,?,?,'COMPLETED',1,?,?)").run(job, account, preview, randomUUID(), stamp, stamp);
    db.connection.prepare("INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,target_root_id,target_path_key,target_segments_json,expected_size,state,local_sha256,completed_size,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'COMPLETED',?,?,?,?)").run(item, account, remote, createHash("sha256").update(JSON.stringify(version)).digest("hex"), JSON.stringify(version), grant.id, root.slotKey([name]), JSON.stringify([name]), bytes.length, evidence.sha256, bytes.length, stamp, stamp);
    db.connection.prepare("INSERT INTO download_item_runtime(item_id) VALUES(?)").run(item);
    db.connection.prepare("INSERT INTO download_job_item VALUES(?,?,?,'ACTIVE')").run(job, item, account);
  })();
  const receipts = new SyncReceipts(db), receipt = receipts.recordDownload(item, evidence); await rm(join(grant.path, "completed", name)); assert.equal(await receipts.observe(receipt, root), "REMOVED"); await root.cleanupAttempt(attempt);
  console.log(JSON.stringify({ jobId: job, receiptId: receipt.id, filename: name }));
} finally { await roots.close(); db.close(); }
