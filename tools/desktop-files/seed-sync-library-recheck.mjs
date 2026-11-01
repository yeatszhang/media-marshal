// 仅供隔离窗口验收：使用 Main 已授权的测试目录准备暂停的网盘任务，不安装网盘凭据、不执行传输。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CoreDatabase } from "../../packages/media-core/dist/infrastructure/database.js";
import { CloudRoots } from "../../packages/media-core/dist/cloud/roots.js";
import { ConfigurationDirectories } from "../../packages/media-core/dist/sources/configuration-directories.js";
import { planOnce } from "../../packages/media-core/dist/cloud/planning.js";
import { EmbyLibraryFiles, LibraryReviewRequired } from "../../packages/media-core/dist/sources/emby-library-files.js";
import { cloudFailure, CloudError, syncSourceConfigurationSchema } from "../../packages/contracts/dist/index.js";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const db = await CoreDatabase.open(config.database, undefined, { exclusiveOwner: true }), roots = new CloudRoots(db), directories = new ConfigurationDirectories(db, roots);
try {
  const grant = roots.bootstrap().find((root) => root.id === config.rootId); assert(grant); await roots.authorize(grant);
  const root = roots.files.get(grant.id), accountId = randomUUID(), remoteRef = randomUUID(), previewId = randomUUID(), jobId = randomUUID(), syncJobId = randomUUID(), sourceId = randomUUID(), stamp = new Date().toISOString();
  const binding = { accountId, bindingId: randomUUID(), generation: randomUUID() }, version = { kind: "weak", size: config.size, modifiedAt: null };
  const segments = config.segments ?? ["视频电影", "X 喜鹊+猫头鹰+翠鸟谋杀案", "猫头鹰谋杀案 (2024)", "第 1 季 - 2160p WEB-DL H265 10bit AAC", "Moonflower Murders S01E04 - 第 4 集 - 2160p WEB-DL H265 10bit AAC.mp4"], name = segments.at(-1);
  const requestKey = randomUUID(), plan = planOnce({ jobId, requestKey, attemptId: randomUUID(), binding, targetGrantId: grant.id, files: [{ entry: { accountId, ref: remoteRef, parentRef: null, name, type: "file", size: config.size, modifiedAt: null, version }, locator: { kind: "path", segments }, mapping: { segments, slotKey: root.slotKey(segments) } }] });
  const file = { ...plan.items[0] }, cloudSnapshot = { binding, name, items: [file], complete: true, failure: null, variant: "", rootType: "file", layout: "drive", selectionPath: segments.join("/"), policy: { maxAttempts: 3, retryBaseMs: 1000 } };
  const configuration = syncSourceConfigurationSchema.parse({ type: "cloud", name: "已有剧集复核窗口验证", accountId, remoteRef });
  const snapshot = { sourceId, sourceVersion: 1, configuration, inputDirectory: null, targetDirectory: directories.binding(grant.id), defaultDirectoryVersion: directories.defaults().version };
  db.connection.transaction(() => {
    db.connection.prepare("INSERT INTO cloud_account(id,name,provider_kind,status,created_at,updated_at) VALUES(?,'隔离复核账号','quark','DISCONNECTED',?,?)").run(accountId, stamp, stamp);
    db.connection.prepare("INSERT INTO remote_entry(id,account_id,name,type,size,observed_at) VALUES(?,?,?,'file',?,?)").run(remoteRef, accountId, name, config.size, stamp);
    db.connection.prepare("INSERT INTO cloud_preview(id,account_id,remote_root_ref,target_root_id,request_key,snapshot_json,state,configuration_version,created_at,expires_at) VALUES(?,?,?,?,?,?,'CONFIRMED',1,?,?)").run(previewId, accountId, remoteRef, grant.id, requestKey, JSON.stringify(cloudSnapshot), stamp, new Date(Date.now() + 900000).toISOString());
    if (!config.reviewPreview) {
    db.connection.prepare("INSERT INTO download_job(id,account_id,preview_id,request_key,state,configuration_version,created_at,updated_at) VALUES(?,?,?,?,'PAUSED',1,?,?)").run(jobId, accountId, previewId, requestKey, stamp, stamp);
    db.connection.prepare("INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,target_root_id,target_path_key,target_segments_json,expected_size,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'PAUSED',?,?)").run(file.itemId, accountId, remoteRef, file.versionKey, JSON.stringify(version), grant.id, file.targetPathKey, JSON.stringify(file.targetSegments), config.size, stamp, stamp);
    db.connection.prepare("INSERT INTO download_item_runtime(item_id) VALUES(?)").run(file.itemId);
    db.connection.prepare("INSERT INTO download_job_item VALUES(?,?,?,'ACTIVE')").run(jobId, file.itemId, accountId);
    }
    db.connection.prepare("INSERT INTO sync_source_rule(id,version,draft_revision,lifecycle_revision,draft_json,paused,review_json,created_at,updated_at) VALUES(?,1,1,0,?,1,'[]',?,?)").run(sourceId, JSON.stringify(configuration), stamp, stamp);
    db.connection.prepare("INSERT INTO sync_source_version VALUES(?,1,?)").run(sourceId, JSON.stringify(snapshot));
    db.connection.prepare("INSERT INTO sync_runtime(source_id,claimed) VALUES(?,1)").run(sourceId);
    if (!config.reviewPreview) {
    db.connection.prepare("INSERT INTO sync_job(id,source_id,source_version,snapshot_json,request_key,preview_id,download_job_id,state,created_at,updated_at) VALUES(?,?,1,?,?,?,?,'RUNNING',?,?)").run(syncJobId, sourceId, JSON.stringify(snapshot), requestKey, previewId, jobId, stamp, stamp);
    db.connection.prepare("INSERT INTO sync_cloud_demand VALUES(?,?,?,1)").run(jobId, syncJobId, sourceId);
    }
  })();
  let configurationPreviewId;
  if (config.reviewPreview) {
    db.connection.prepare("UPDATE media_target_root SET available=1").run();
    // 仅提供静态授权代际，不提供凭据或可执行网盘连接。
    db.connection.prepare("UPDATE cloud_account SET status='UNAVAILABLE' WHERE id=?").run(accountId);
    db.connection.prepare("INSERT INTO provider_binding(id,account_id,implementation_id,configuration_version,generation,state,created_at) VALUES(?,?,'quark.openlist',1,?,'ACTIVE',?)").run(binding.bindingId, accountId, binding.generation, stamp);
    try { await new EmbyLibraryFiles(db).find(name, config.size, undefined, version, segments); assert.fail("隔离夹具应产生待核对项"); }
    catch (error) { assert(error instanceof LibraryReviewRequired); file.libraryReview = error.review; file.libraryIssue = error.message; file.issue = cloudFailure(new CloudError("CONFLICT")); }
    configurationPreviewId = randomUUID();
    db.connection.prepare("UPDATE cloud_preview SET state='READY',snapshot_json=? WHERE id=?").run(JSON.stringify(cloudSnapshot), previewId);
    db.connection.prepare("INSERT INTO sync_configuration_preview(id,source_id,request_key,version,draft_revision,lifecycle_revision,snapshot_json,download_preview_id,mode,force,rebind_default,default_dependency,state,expires_at) VALUES(?,?,?,1,1,0,?,?,'execution',0,0,1,'READY',?)").run(configurationPreviewId, sourceId, randomUUID(), JSON.stringify(snapshot), previewId, Date.now() + 900000);
  }
  console.log(JSON.stringify({ jobId: syncJobId, sourceId, previewId: configurationPreviewId }));
} finally { await directories.close(); await roots.close(); db.close(); }
