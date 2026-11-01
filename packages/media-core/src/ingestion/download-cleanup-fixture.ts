import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRoot } from "../files/index.js";
import { CoreDatabase } from "../infrastructure/database.js";
import { DownloadCleanupEvidence } from "./download-cleanup-evidence.js";

/** 测试专用隔离目录；不读取用户配置和凭据。 */
export async function cleanupFixture(dispose: ((work: () => unknown | Promise<unknown>) => void)) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "marshal-cleanup-evidence-")));
  const database = await CoreDatabase.open(join(folder, "state.sqlite")); dispose(() => database.close());
  const grant = async (name: string) => {
    const path = join(folder, name); await mkdir(path); const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true });
    return { id: randomUUID(), path, volume: { volumeId: randomUUID(), rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "isolated-test", caseSensitive: true, unicodeEquivalent: true, pathMaxBytes: 4096 } };
  };
  const sourceGrant = await grant("下载"), targetGrant = await grant("媒体库"), stamp = new Date().toISOString(), db = database.connection;
  await mkdir(join(sourceGrant.path, "completed")); const sourceSegments = ["completed", "01.mp4"], targetSegments = ["作品 - S01E01.mp4"], bytes = Buffer.from("隔离目录中的相同媒体内容");
  await writeFile(join(sourceGrant.path, ...sourceSegments), bytes); await writeFile(join(targetGrant.path, ...targetSegments), bytes);
  db.prepare("INSERT INTO managed_download_root VALUES(?,?,?,?,'AVAILABLE',?)").run(sourceGrant.id, randomUUID(), sourceGrant.path, JSON.stringify(sourceGrant.volume), stamp);
  db.prepare("INSERT INTO media_target_root VALUES(?,?,1)").run(targetGrant.id, JSON.stringify(targetGrant));
  const connectionId = randomUUID(); db.prepare("INSERT INTO emby_connection VALUES(?,1,'isolated-server','http://127.0.0.1',1,?)").run(connectionId, stamp);
  const binding = { id: randomUUID(), version: 1, targetId: targetGrant.id, targetDirectory: { id: targetGrant.id, version: 1, path: targetGrant.path }, serverId: "isolated-server", connectionVersion: 1, libraryId: "isolated-library", libraryRoot: targetGrant.path, mediaType: "TV_SHOW", conversion: null };
  db.prepare("INSERT INTO emby_library VALUES(?,'isolated-library',?,?,?)").run(connectionId, targetGrant.path, targetGrant.id, JSON.stringify(binding));
  const source = await ManagedRoot.open(sourceGrant); dispose(() => source.close()); await source.initialize(); const evidence = (await source.inspectForRelocation(sourceSegments)).evidence;
  const receiptId = randomUUID(); db.prepare("INSERT INTO sync_receipt VALUES(?,'cloud','账户','对象','版本','{}',?,'槽位',?,?,?,?,'download-item',?,'版本')").run(receiptId, sourceGrant.id, JSON.stringify(sourceSegments.slice(1)), evidence.sha256, evidence.size, stamp, randomUUID());
  db.prepare("INSERT INTO sync_receipt_evidence VALUES(?,?)").run(receiptId, JSON.stringify(evidence));
  const verification = new DownloadCleanupEvidence(database);
  function organized() {
    const taskId = randomUUID(), sourceId = randomUUID(), candidateId = randomUUID(), operationId = randomUUID(), attemptId = randomUUID();
    db.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'隔离识别','custom',?,?,'TV_SHOW','COPY',?)").run(sourceId, sourceGrant.path, targetGrant.path, stamp);
    db.prepare("INSERT INTO ingestion_source VALUES(?,'local',NULL,?,?,1,1)").run(sourceId, JSON.stringify(sourceGrant), targetGrant.id);
    db.prepare("INSERT INTO media_task(id,source_id,source_path,status,target_path,created_at,updated_at) VALUES(?,?,?,'DONE',?,?,?)").run(taskId, sourceId, join(sourceGrant.path, ...sourceSegments), join(targetGrant.path, ...targetSegments), stamp, stamp);
    db.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,snapshot_json,state,task_id,is_current,created_at,updated_at) VALUES(?,?,?,'version',?,'PROCESSED',?,1,?,?)").run(candidateId, sourceId, JSON.stringify(sourceSegments), JSON.stringify({ ...evidence, size: bytes.length }), taskId, stamp, stamp);
    const plan = { source: sourceGrant, target: targetGrant, sourceSegments, targetSegments, snapshot: { size: bytes.length }, taskId, logicalTargetId: targetGrant.id };
    db.prepare("INSERT INTO ingestion_operation(id,candidate_id,task_id,request_key,target_root_id,target_slot,plan_json,attempt_id,phase,evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,'slot',?,?,'RECORDED','{}',?,?)").run(operationId, candidateId, taskId, randomUUID(), targetGrant.id, JSON.stringify(plan), attemptId, stamp, stamp);
    return { taskId, sourceId, candidateId, operationId, attemptId, plan };
  }
  return { folder, database, source, sourceGrant, targetGrant, sourceSegments, targetSegments, receiptId, binding, bytes, verification, organized };
}
