// 仅供隔离窗口验收：使用已由 Main 授权的测试根准备成功收据，再移除本地副本。
// 这份夹具验证 DTO／页面恢复，不作为真实网盘传输验收。
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CoreDatabase } from "../../packages/media-core/dist/infrastructure/database.js";
import { CloudRoots } from "../../packages/media-core/dist/cloud/roots.js";
import { SyncReceipts } from "../../packages/media-core/dist/sources/sync-receipts.js";
import { planOnce } from "../../packages/media-core/dist/cloud/planning.js";

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
  let historyPreview;
  if (config.historyPreview) {
    // 仅预置登录后待核对的页面状态，不安装凭据、不模拟真实账号校验。
    const binding = { accountId: account, bindingId: randomUUID(), generation: randomUUID() }, ref = randomUUID(), source = randomUUID(), previewId = randomUUID(), requestKey = randomUUID(), locator = { kind: "path", segments: [name] }, configuration = { type: "cloud", name: "重新登录的同步来源", accountId: account, remoteRef: ref, downloadRootId: grant.id, filters: { extensions: [], names: [] }, periodic: { enabled: false, intervalSeconds: 900 }, organization: null }, expires = Date.now() + 900000;
    const itemPlan = planOnce({ jobId: randomUUID(), requestKey, attemptId: randomUUID(), binding, targetGrantId: grant.id, files: [{ entry: { accountId: account, ref, parentRef: null, name, type: "file", size: bytes.length, modifiedAt: null, version }, locator, mapping: { segments: [name], slotKey: root.slotKey([name]) } }] });
    const pending = { ...itemPlan.items[0], receiptId: receipt.id, reuseItemId: item, historyPending: true, localRemoved: true }, snapshot = { binding, name, rootType: "file", layout: "drive", selectionPath: name, items: [pending], complete: true, failure: null, variant: "", filters: configuration.filters, policy: { maxAttempts: 3, retryBaseMs: 1000 } };
    db.connection.transaction(() => {
      db.connection.prepare("UPDATE cloud_account SET status='READY' WHERE id=?").run(account);
      db.connection.prepare("INSERT INTO provider_binding(id,account_id,implementation_id,configuration_version,generation,state,created_at) VALUES(?,?,'quark.openlist',1,?,'ACTIVE',?)").run(binding.bindingId, account, binding.generation, stamp);
      db.connection.prepare("INSERT INTO remote_entry(id,account_id,name,type,size,observed_at) VALUES(?,?,?,'file',?,?)").run(ref, account, name, bytes.length, stamp);
      db.connection.prepare("INSERT INTO remote_binding(remote_ref,binding_id,account_id,locator_json,locator_key,updated_at) VALUES(?,?,?,?,?,?)").run(ref, binding.bindingId, account, JSON.stringify(locator), createHash("sha256").update(JSON.stringify(locator)).digest("hex"), stamp);
      db.connection.prepare("INSERT INTO sync_receipt_origin VALUES(?,?,'path',?)").run(receipt.id, account, createHash("sha256").update(JSON.stringify(locator)).digest("hex"));
      db.connection.prepare("INSERT INTO cloud_preview(id,account_id,remote_root_ref,target_root_id,request_key,snapshot_json,state,configuration_version,created_at,expires_at) VALUES(?,?,?,?,?,?,'READY',1,?,?)").run(previewId, account, ref, grant.id, requestKey, JSON.stringify(snapshot), stamp, new Date(expires).toISOString());
      db.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,paused,created_at,updated_at) VALUES(?,'cloud',0,1,?,1,?,?)").run(source, JSON.stringify(configuration), stamp, stamp);
      db.connection.prepare("INSERT INTO source_rule_preview(id,source_id,version,draft_revision,request_key,configuration_json,download_preview_id,state,expires_at,created_at) VALUES(?,?,0,1,?,?,?,'READY',?,?)").run(randomUUID(), source, requestKey, JSON.stringify(configuration), previewId, expires, stamp);
    })();
    historyPreview = { sourceId: source, name: configuration.name, requestKey };
  }
  console.log(JSON.stringify({ jobId: job, receiptId: receipt.id, filename: name, ...(historyPreview ? { historyPreview } : {}) }));
} finally { await roots.close(); db.close(); }
