// 真实独立进程的 SQL/文件崩溃边界；不注册到产品、不连接云账号。
import { randomUUID, createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const load = (name) => import(pathToFileURL(resolve("packages/media-core/dist", name)).href);
const { CoreDatabase } = await load("infrastructure/database.js"), { CloudAccounts } = await load("cloud/accounts.js"), { CloudRoots } = await load("cloud/roots.js"), { DownloadCommits } = await load("cloud/commits.js");
const content = Buffer.from("独立进程真实文件：下载、校验、提交与崩溃记账。".repeat(100));
process.once("message", async (input) => {
  try {
    const db = await CoreDatabase.open(join(input.path, "desktop.sqlite3")), roots = new CloudRoots(db); await roots.authorize(input.grant);
    const accounts = new CloudAccounts(db), prepared = accounts.dispatch("cloud.authorization.begin", { name: "崩溃夹具", requestKey: randomUUID(), implementationId: "test.crash" });
    const capabilities = { authorizationMethods: ["cookie"], accountIdentity: "unavailable", objectIdentity: "path", reliableRevision: false, hashAlgorithms: ["sha256"], rangeRead: "unknown", sourceKinds: ["webdav"] };
    accounts.dispatch("cloud.authorization.finish", { jobId: prepared.job.id, failure: null, capabilities, identityKey: null });
    const binding = prepared.candidate.binding, remoteRef = randomUUID(), itemId = randomUUID(), attemptId = randomUUID(), previewId = randomUUID(), jobId = randomUUID(), now = new Date().toISOString();
    const evidence = { kind: "hash", algorithm: "sha256", value: createHash("sha256").update(content).digest("hex") }, key = createHash("sha256").update(JSON.stringify(evidence)).digest("hex"), root = roots.files.get(input.grant.id);
    const item = { itemId, source: { binding: { accountId: binding.accountId, bindingId: binding.bindingId, generation: binding.generation }, remoteRef, locator: { kind: "path", segments: ["sample.bin"] }, expectedVersion: evidence }, expectedSize: content.length, targetSegments: ["sample.bin"] };
    const plan = { attemptId, targetGrantId: input.grant.id, items: [item] }, snapshot = { name: "sample.bin", complete: true, failure: null, binding: item.source.binding, items: [{ ...item, versionKey: key, targetPathKey: root.slotKey(item.targetSegments) }], policy: { maxAttempts: 3, retryBaseMs: 1000 } };
    db.connection.transaction(() => {
      db.connection.prepare("INSERT INTO remote_entry(id,account_id,name,type,size,version_json,observed_at) VALUES(?,?,'sample.bin','file',?,?,?)").run(remoteRef, binding.accountId, content.length, JSON.stringify(evidence), now);
      db.connection.prepare("INSERT INTO cloud_preview(id,account_id,remote_root_ref,target_root_id,request_key,snapshot_json,state,configuration_version,created_at,expires_at) VALUES(?,?,?,?,?,?,'CONFIRMED',1,?,?)").run(previewId, binding.accountId, remoteRef, input.grant.id, randomUUID(), JSON.stringify(snapshot), now, now);
      db.connection.prepare("INSERT INTO download_job(id,account_id,preview_id,request_key,state,configuration_version,created_at,updated_at) VALUES(?,?,?,?,'RUNNING',1,?,?)").run(jobId, binding.accountId, previewId, randomUUID(), now, now);
      db.connection.prepare("INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,target_root_id,target_path_key,target_segments_json,expected_size,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'RUNNING',?,?)").run(itemId, binding.accountId, remoteRef, key, JSON.stringify(evidence), input.grant.id, root.slotKey(item.targetSegments), JSON.stringify(item.targetSegments), content.length, now, now);
      db.connection.prepare("INSERT INTO download_item_runtime(item_id,attempt_count) VALUES(?,1)").run(itemId);
      db.connection.prepare("INSERT INTO download_job_item(job_id,item_id,account_id,demand_state) VALUES(?,?,?,'ACTIVE')").run(jobId, itemId, binding.accountId);
      db.connection.prepare("INSERT INTO download_attempt(id,account_id,binding_id,core_generation,binding_generation,host_generation,idempotency_key,staging_key,state,plan_json,created_at) VALUES(?,?,?,?,?,?,?,?,'CLAIMED',?,?)").run(attemptId, binding.accountId, binding.bindingId, randomUUID(), binding.generation, randomUUID(), randomUUID(), attemptId, JSON.stringify({ plan, policy: snapshot.policy }), now);
      db.connection.prepare("INSERT INTO download_claim(item_id,attempt_id,account_id,target_root_id,target_path_key,ordinal) VALUES(?,?,?,?,?,0)").run(itemId, attemptId, binding.accountId, input.grant.id, root.slotKey(item.targetSegments));
      db.connection.prepare("INSERT INTO download_attempt_item VALUES(?,?)").run(attemptId, itemId);
    })();
    const checkpoint = async (point) => { if (point === input.point) { process.send({ point, itemId, attemptId, jobId, size: content.length, sha256: evidence.value }); await new Promise(() => {}); } };
    await checkpoint("planned");
    const stage = await root.prepareStage(attemptId); await writeFile(join(stage, "sample.bin"), content.subarray(0, 10));
    db.connection.prepare("UPDATE download_attempt SET state='RUNNING' WHERE id=?").run(attemptId); await checkpoint("writing");
    await writeFile(join(stage, "sample.bin"), content);
    db.connection.prepare("UPDATE download_attempt SET state='EXITED',exit_code=0,stopped_at=?,stop_evidence_json=? WHERE id=?").run(now, JSON.stringify({ kind: "fixture-write-finished", processId: process.pid }), attemptId);
    db.connection.prepare("UPDATE download_item SET state='VERIFYING' WHERE id=?").run(itemId);
    const catalog = { source: () => item.source, stat: async () => ({ accountId: binding.accountId, ref: remoteRef, parentRef: null, name: "sample.bin", type: "file", size: content.length, modifiedAt: null, version: evidence }) };
    await new DownloadCommits(db, roots, catalog, checkpoint).verifyAndCommit(attemptId, input.grant.id, item);
    process.send({ error: true });
  } catch { process.send({ error: true }); }
});
