import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { CoreDatabase } from "../../packages/media-core/dist/infrastructure/database.js";
import { ManagedRoot } from "../../packages/media-core/dist/files/index.js";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const directory = dirname(dirname(resolve(config.database)));
if (!basename(directory).startsWith("marshal-recovery-window-") || resolve(config.database) !== join(directory, "data/desktop.sqlite3")) throw new Error("恢复夹具仅支持已关闭客户端的隔离测试配置");
const database = await CoreDatabase.open(config.database), db = database.connection;
let root;
try {
  const row = db.prepare("SELECT canonical_path,volume_identity FROM managed_download_root WHERE id=?").get(config.rootId);
  root = await ManagedRoot.open({ id: config.rootId, path: row.canonical_path, volume: JSON.parse(row.volume_identity) });
  const accountId = randomUUID(), bindingId = randomUUID(), generation = randomUUID(), remoteRoot = randomUUID(), previewId = randomUUID(), jobId = randomUUID(), now = new Date().toISOString();
  db.prepare("INSERT INTO cloud_account(id,name,provider_kind,status,created_at,updated_at) VALUES(?,'隔离恢复测试账号','quark','DISCONNECTED',?,?)").run(accountId, now, now);
  db.prepare("INSERT INTO provider_binding(id,account_id,implementation_id,configuration_version,generation,state,created_at) VALUES(?,?,'isolated-recovery',1,?,'RETIRED',?)").run(bindingId, accountId, generation, now);
  db.prepare("INSERT INTO remote_entry(id,account_id,name,type,observed_at) VALUES(?,?,'提交恢复测试','directory',?)").run(remoteRoot, accountId, now);
  db.prepare("INSERT INTO cloud_preview(id,account_id,remote_root_ref,target_root_id,request_key,snapshot_json,state,configuration_version,created_at,expires_at) VALUES(?,?,?,?,?,?,'CONFIRMED',1,?,?)").run(previewId, accountId, remoteRoot, config.rootId, randomUUID(), JSON.stringify({ name: "提交异常恢复测试", policy: { maxAttempts: 3, retryBaseMs: 1000 }, items: [] }), now, new Date(Date.now() + 3600000).toISOString());
  db.prepare("INSERT INTO download_job(id,account_id,preview_id,request_key,state,configuration_version,created_at,updated_at) VALUES(?,?,?,?,'RECONCILING',1,?,?)").run(jobId, accountId, previewId, randomUUID(), now, now);
  const items = [], content = Buffer.from("隔离测试：原下载已完整停止，外部同内容文件仍不得认领。");
  for (let index = 1; index <= 11; index++) {
    const itemId = randomUUID(), attemptId = randomUUID(), ref = randomUUID(), segments = ["长目录名称用于检验窄窗口中的完整路径换行".repeat(3), `第${String(index).padStart(2, "0")}集.1080p.WEB-DL.H264.mkv`];
    await root.prepareStage(attemptId); const stage = await root.stageFilePath(attemptId, segments); await writeFile(stage, content);
    const evidence = await root.verifyStage(attemptId, segments, content.length), target = join(row.canonical_path, "completed", ...segments);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
    const version = JSON.stringify({ kind: "weak", size: content.length, modifiedAt: null }), key = createHash("sha256").update(version).digest("hex"), slot = root.slotKey(segments);
    db.prepare("INSERT INTO remote_entry(id,account_id,parent_ref,name,type,size,version_json,observed_at) VALUES(?,?,?,?,'file',?,?,?)").run(ref, accountId, remoteRoot, segments.at(-1), content.length, version, now);
    db.prepare("INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,target_root_id,target_path_key,target_segments_json,expected_size,state,failure_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'RECONCILING','CONFLICT',?,?)").run(itemId, accountId, ref, key, version, config.rootId, slot, JSON.stringify(segments), content.length, now, now);
    db.prepare("INSERT INTO download_item_runtime(item_id,attempt_count) VALUES(?,1)").run(itemId);
    db.prepare("INSERT INTO download_job_item(job_id,item_id,account_id,demand_state) VALUES(?,?,?,'ACTIVE')").run(jobId, itemId, accountId);
    db.prepare("INSERT INTO download_attempt(id,account_id,binding_id,core_generation,binding_generation,host_generation,idempotency_key,staging_key,state,plan_json,retries,created_at,stopped_at,stop_evidence_json) VALUES(?,?,?,?,?,?,?,?,'EXITED','{}',0,?,?,?)").run(attemptId, accountId, bindingId, randomUUID(), generation, randomUUID(), attemptId, attemptId, now, now, JSON.stringify({ kind: "isolated-stopped" }));
    db.prepare("INSERT INTO download_attempt_item VALUES(?,?)").run(attemptId, itemId);
    db.prepare("INSERT INTO download_claim VALUES(?,?,?,?,?,0)").run(itemId, attemptId, accountId, config.rootId, slot);
    db.prepare("INSERT INTO download_commit_intent(item_id,attempt_id,account_id,version_key,local_sha256,size,file_evidence_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'RECONCILING',?,?)").run(itemId, attemptId, accountId, key, evidence.sha256, evidence.size, JSON.stringify(evidence), now, now);
    items.push({ itemId, segments, target, inode: evidence.inode });
  }
  process.stdout.write(JSON.stringify({ jobId, items }));
} finally { await root?.close(); database.close(); }
