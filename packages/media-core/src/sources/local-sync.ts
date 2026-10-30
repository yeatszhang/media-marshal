import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { DesktopError, CloudError, compileSyncFilters, syncSourceConfigurationSchema, type SyncSourceSnapshot, type VersionEvidence } from "@media-marshal/contracts";
import { localFileEvidenceSchema, type ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { CloudRoots } from "../cloud/roots.js";
import { assertSpaceBudget, sameVolumeRoot } from "../files/index.js";
import { sourceVersion, sameSnapshot, type SourceSnapshot } from "../files/source-root.js";
import { SyncReceipts } from "./sync-receipts.js";
import type { ConfigurationDirectories } from "./configuration-directories.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message: string) => new DesktopError("CONFLICT", message);
export interface LocalSyncFile { segments: string[]; size: number; snapshot: SourceSnapshot; namespace: string; version: VersionEvidence; versionKey: string; targetSegments: string[]; slot: string; receiptId: string | null; state: "READY" | "OBSERVING" | "REUSED" | "REMOVED" | "CONFLICT" | "UNAVAILABLE"; reason: string | null }
interface Preview { id: string; request_key: string; signature: string; snapshot_json: string; files_json: string; force: number; expires_at: number; job_id: string | null }
interface Plan { source: ManagedRootGrant; snapshot: SourceSnapshot; sourceSegments: string[]; targetSegments: string[]; target: ManagedRootGrant; variant: string }
interface Operation { id: string; identity_key: string; source_namespace: string; source_object_key: string; source_version_key: string; version_json: string; target_directory_id: string; target_slot: string; plan_json: string; attempt_id: string; phase: string; evidence_json: string | null }

/** 本地同步与媒体 COPY 分开记账；唯一操作和不可变收据跨来源合并同一文件版本。 */
export class LocalSync {
  private observations = new Map<string, { since: number; last: number; wall: number; version: string }>();
  private active = new Map<string, AbortController>();
  private flight?: Promise<void>;
  private closed = false;
  private observedAt = -Infinity;
  private globallyPaused = false;
  constructor(private readonly database: CoreDatabase, private readonly directories: ConfigurationDirectories, private readonly roots: CloudRoots, private readonly now = Date.now, private readonly monotonic = () => performance.now()) {}
  private stable(key: string, snapshot: SourceSnapshot) {
    const now = this.monotonic(), wall = this.now(), version = sourceVersion(snapshot), old = this.observations.get(key);
    if (!old || old.version !== version || now - old.last > 30000 || Math.abs(wall - old.wall - (now - old.last)) > 5000) { this.observations.set(key, { since: now, last: now, wall, version }); return false; }
    old.last = now; old.wall = wall; return snapshot.size > 0 && now - old.since >= 120000;
  }
  resetObservations() { this.observations.clear(); }
  previewRow(id: string) { return this.database.connection.prepare("SELECT * FROM local_sync_preview WHERE id=?").get(id) as Preview | undefined; }
  preview(id: string) {
    const row = this.previewRow(id); if (!row) throw conflict("本地同步预览不存在，请重新预览");
    const files = (JSON.parse(row.files_json) as LocalSyncFile[]).map((file) => {
      const observation = this.observations.get(file.namespace + JSON.stringify(file.segments)), now = this.monotonic();
      return file.state === "OBSERVING" && observation && observation.version === sourceVersion(file.snapshot) && now - observation.last <= 30000 && now - observation.since >= 120000 && file.snapshot.size > 0 ? { ...file, state: "READY" as const, reason: null } : file;
    });
    return { id: row.id, expiresAt: row.expires_at, applied: !!row.job_id, files };
  }
  async create(snapshot: SyncSourceSnapshot, requestKey: string, force = false) {
    if (this.closed || snapshot.configuration.type !== "local" || !snapshot.inputDirectory) throw conflict("本地同步输入无效或服务正在停止，请刷新配置");
    const signature = hash({ snapshot, force }), db = this.database.connection;
    const repeated = db.prepare("SELECT * FROM local_sync_preview WHERE request_key=?").get(requestKey) as Preview | undefined;
    if (repeated) { if (repeated.signature !== signature) throw conflict("请求标识已用于其他同步预览"); return this.preview(repeated.id); }
    const source = this.directories.reader(snapshot.inputDirectory.id), target = this.roots.files.get(snapshot.targetDirectory.id), includes = compileSyncFilters(snapshot.configuration.filters);
    await source.check(); await target.check();
    const files = await source.discover([], 10000), id = randomUUID(), result: LocalSyncFile[] = [];
    const namespace = hash([source.grant.volume.volumeId, source.grant.volume.rootInode, source.grant.volume.rootBirthtimeNs]);
    const receipts = new SyncReceipts(this.database, this.now);
    for (const segments of files) {
      if (this.closed) throw new DesktopError("INTERRUPTED", "本地同步预览已停止", true);
      if (!includes(segments.join("/")) || /(?:\.(?:part|tmp|temp|aria2|download|downloading|qkdownloading|crdownload)|\.!qB)$/i.test(segments.at(-1)!)) continue;
      let proof: SourceSnapshot;
      try { proof = await source.inspect(segments); } catch { throw new DesktopError("LOCAL_UNAVAILABLE", `本地同步扫描「${segments.join("/").slice(-180)}」失败，请核对原文件、目录读取权限及磁盘；清单尚未完整，未执行复制`, true); }
      const version: VersionEvidence = { kind: "revision", revisionKey: sourceVersion(proof) }, versionKey = hash(version);
      const targetSegments = force ? ["resync-" + id, ...segments] : segments, slot = target.slotKey(targetSegments);
      const receipt = !force ? receipts.find("local", namespace, JSON.stringify(segments), version, target.grant.id, slot) : undefined;
      const file: LocalSyncFile = { segments, size: proof.size, snapshot: proof, namespace, version, versionKey, targetSegments, slot, receiptId: receipt?.id ?? null, state: "OBSERVING", reason: "等待文件连续稳定至少 120 秒；稳定后仍需确认文件完整" };
      if (receipt) {
        const state = await receipts.observe(receipt, target);
        file.state = state === "PRESENT" ? "REUSED" : state === "REMOVED" ? "REMOVED" : state === "CONFLICT" ? "CONFLICT" : "UNAVAILABLE";
        file.reason = state === "REMOVED" ? "已同步，本地已移除；普通执行不会补回，可显式预览重新同步" : state === "PRESENT" ? "已同步，复用成功收据" : state === "CONFLICT" ? "已同步目标的身份或内容已变化，请保留双方文件并核对" : "原目标卷或目录不可用，不认定为删除";
      } else {
        if (this.stable(namespace + JSON.stringify(segments), proof)) { file.state = "READY"; file.reason = null; }
        try { await target.assertVacant(targetSegments); } catch (error) { file.state = error instanceof CloudError && error.code === "CONFLICT" ? "CONFLICT" : "UNAVAILABLE"; file.reason = file.state === "CONFLICT" ? "目标已被其他内容占用，不覆盖；请处理后重新预览" : "目标目录不可用，请恢复原磁盘和授权后重试"; }
      }
      result.push(file);
    }
    target.assertMappings(result.map((file) => file.targetSegments));
    await source.check(); assertSpaceBudget(await target.check(), result.filter((file) => !file.receiptId).reduce((sum, file) => sum + file.size, 0));
    if (this.closed) throw new DesktopError("INTERRUPTED", "本地同步预览已停止", true);
    db.prepare("INSERT INTO local_sync_preview(id,request_key,signature,snapshot_json,files_json,force,expires_at) VALUES(?,?,?,?,?,?,?)").run(id, requestKey, signature, JSON.stringify(snapshot), JSON.stringify(result), Number(force), this.now() + 15 * 60 * 1000);
    return this.preview(id);
  }
  async confirm(previewId: string, jobId: string, filesComplete: boolean) {
    const preview = this.previewRow(previewId); if (!preview) throw conflict("同步预览不存在，请重新预览");
    if (preview.job_id) { if (preview.job_id !== jobId) throw conflict("预览已用于其他作业，请查看原作业"); return; }
    if (!filesComplete || preview.expires_at <= this.now() || this.closed) throw conflict("请重新预览并确认本地文件完整；过期预览不能执行");
    const snapshot = JSON.parse(preview.snapshot_json) as SyncSourceSnapshot, files = this.preview(previewId).files;
    if (files.some((file) => !["READY", "REUSED", "REMOVED"].includes(file.state))) throw conflict("同步预览仍有未就绪、冲突或不可用文件，请逐项处理并重新预览");
    const source = this.directories.reader(snapshot.inputDirectory!.id), target = this.roots.files.get(snapshot.targetDirectory.id), receipts = new SyncReceipts(this.database, this.now);
    for (const file of files) {
      let actual: SourceSnapshot;
      try { actual = await source.inspect(file.segments); } catch { throw new DesktopError("LOCAL_UNAVAILABLE", `来源「${file.segments.join("/").slice(-180)}」无法读取，请恢复原文件、原磁盘和权限后重新预览`, true); }
      if (!sameSnapshot(file.snapshot, actual)) throw conflict(`来源 ${file.segments.join("/").slice(-180)} 已变化，请重新预览`);
      if (file.receiptId) { const receipt = receipts.get(file.receiptId); if (!receipt || !["PRESENT", "REMOVED"].includes(await receipts.observe(receipt, target))) throw conflict(`已同步目标 ${file.targetSegments.join("/")} 已变化，请核对后重新预览`); }
      else if (!this.stable(file.namespace + JSON.stringify(file.segments), file.snapshot)) throw conflict(`来源 ${file.segments.join("/")} 需要重新连续观察至少 120 秒`);
    }
    await source.check(); assertSpaceBudget(await target.check(), files.filter((file) => !file.receiptId).reduce((sum, file) => sum + file.size, 0));
    return () => {
      const db = this.database.connection;
      if (!db.inTransaction) throw new Error("本地同步确认必须与作业在同一事务提交");
      if (this.closed || preview.expires_at <= this.now()) throw conflict("同步预览已过期或服务正在停止，请重新核对");
      const current = this.previewRow(previewId)!; if (current.job_id) { if (current.job_id !== jobId) throw conflict("同步预览已经确认"); return; }
      for (const [ordinal, file] of files.entries()) {
        let operationId: string | null = null;
        if (!file.receiptId) {
          const variant = preview.force ? "resync:" + preview.id : "", identity = hash([file.namespace, file.segments, file.versionKey, snapshot.targetDirectory.id, file.slot, variant]);
          const old = db.prepare("SELECT id FROM local_sync_operation WHERE identity_key=?").get(identity) as { id: string } | undefined;
          operationId = old?.id ?? randomUUID();
          if (!old) {
            const stamp = new Date(this.now()).toISOString(), plan: Plan = { source: source.grant, snapshot: file.snapshot, sourceSegments: file.segments, targetSegments: file.targetSegments, target: target.grant, variant };
            db.prepare("INSERT INTO local_sync_operation(id,identity_key,source_namespace,source_object_key,source_version_key,version_json,target_directory_id,target_slot,plan_json,attempt_id,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'PLANNED',?,?)").run(operationId, identity, file.namespace, JSON.stringify(file.segments), file.versionKey, JSON.stringify(file.version), target.grant.id, file.slot, JSON.stringify(plan), randomUUID(), stamp, stamp);
          }
        }
        const completed = operationId ? new SyncReceipts(this.database, this.now).byResult("local-sync", operationId) : undefined;
        db.prepare("INSERT INTO local_sync_member(job_id,ordinal,relative_path,operation_id,receipt_id,state) VALUES(?,?,?,?,?,?)").run(jobId, ordinal, file.segments.join("/"), operationId, completed?.id ?? file.receiptId, completed ? "DONE" : file.receiptId ? file.state === "REMOVED" ? "REMOVED" : "REUSED" : "PENDING");
      }
      db.prepare("UPDATE local_sync_preview SET job_id=? WHERE id=?").run(jobId, preview.id);
    };
  }
  private needed(id: string) { return !!this.database.connection.prepare("SELECT 1 FROM local_sync_member m JOIN sync_job j ON j.id=m.job_id JOIN sync_source_rule r ON r.id=j.source_id WHERE m.operation_id=? AND j.state IN ('PENDING','RUNNING') AND r.paused=0 AND r.deleted_at IS NULL LIMIT 1").get(id) && !this.database.connection.prepare("SELECT 1 FROM app_setting WHERE key='cloud.downloads.paused' AND value='true'").get(); }
  tick(): Promise<void> { if (this.closed) return Promise.resolve(); return this.flight ??= this.run().finally(() => { this.flight = undefined; }); }
  private async run() {
    const db = this.database.connection;
    if (db.prepare("SELECT 1 FROM app_setting WHERE key='cloud.downloads.paused' AND value='true'").get()) { if (!this.globallyPaused) this.pauseChanged(); this.globallyPaused = true; return; }
    if (this.globallyPaused) { this.globallyPaused = false; this.observedAt = -Infinity; }
    if (this.monotonic() - this.observedAt >= 10000) { this.observedAt = this.monotonic(); await this.observeInputs(); }
    const rows = db.prepare("SELECT o.* FROM local_sync_operation o WHERE o.phase IN ('PLANNED','COPYING','VERIFIED') AND EXISTS(SELECT 1 FROM local_sync_member m JOIN sync_job j ON j.id=m.job_id JOIN sync_source_rule r ON r.id=j.source_id WHERE m.operation_id=o.id AND j.state IN ('PENDING','RUNNING') AND r.paused=0 AND r.deleted_at IS NULL) ORDER BY o.created_at,o.id LIMIT 4").all() as Operation[];
    for (const row of rows) {
      if (this.closed) return;
      if (!this.needed(row.id)) continue;
      const controller = new AbortController(); this.active.set(row.id, controller);
      try { await this.copy(row, controller.signal); }
      catch (error) {
        const paused = controller.signal.aborted || error instanceof DesktopError && error.code === "INTERRUPTED";
        const failure = paused ? "同步已暂停，原计划和文件保留，恢复后重新核对" : error instanceof DesktopError ? error.message : error instanceof CloudError && error.code === "CONFLICT" ? "同步目标被占用或文件证据不一致，请保留双方文件，处理后重试原作业" : "原输入或目标不可用，请恢复原磁盘和目录授权后重试";
        if (!paused) db.transaction(() => { db.prepare("UPDATE local_sync_operation SET phase='NEEDS_ATTENTION',failure=?,updated_at=? WHERE id=?").run(failure, new Date(this.now()).toISOString(), row.id); db.prepare("UPDATE local_sync_member SET state='NEEDS_ATTENTION',failure=? WHERE operation_id=?").run(failure, row.id); })();
      } finally { this.active.delete(row.id); }
    }
    db.prepare("UPDATE sync_job SET state=CASE WHEN EXISTS(SELECT 1 FROM local_sync_member m WHERE m.job_id=sync_job.id AND m.state='NEEDS_ATTENTION') THEN 'NEEDS_ATTENTION' ELSE 'DONE' END,updated_at=? WHERE EXISTS(SELECT 1 FROM local_sync_preview p WHERE p.job_id=sync_job.id) AND state IN ('PENDING','RUNNING','NEEDS_ATTENTION') AND NOT EXISTS(SELECT 1 FROM local_sync_member m WHERE m.job_id=sync_job.id AND m.state='PENDING')").run(new Date(this.now()).toISOString());
  }
  private async observeInputs() {
    const rows = this.database.connection.prepare("SELECT coalesce(json_extract(v.snapshot_json,'$.configuration'),r.draft_json) AS draft_json FROM sync_source_rule r LEFT JOIN sync_source_version v ON v.source_id=r.id AND v.version=r.version WHERE r.deleted_at IS NULL AND (r.paused=0 OR r.version=0) UNION SELECT json_extract(j.snapshot_json,'$.configuration') AS draft_json FROM sync_job j JOIN sync_source_rule r ON r.id=j.source_id WHERE j.state IN ('PENDING','RUNNING') AND r.paused=0 AND r.deleted_at IS NULL LIMIT 2000").all() as { draft_json: string }[];
    const seen = new Set<string>();
    for (const row of rows) {
      const configuration = syncSourceConfigurationSchema.parse(JSON.parse(row.draft_json));
      if (configuration.type !== "local" || seen.has(configuration.inputDirectoryId)) continue;
      seen.add(configuration.inputDirectoryId);
      let namespace: string | undefined;
      try {
        const root = this.directories.reader(configuration.inputDirectoryId);
        namespace = hash([root.grant.volume.volumeId, root.grant.volume.rootInode, root.grant.volume.rootBirthtimeNs]);
        for (const segments of await root.discover()) { if (this.closed) return; this.stable(namespace + JSON.stringify(segments), await root.inspect(segments)); }
      } catch { if (namespace) for (const key of this.observations.keys()) if (key.startsWith(namespace)) this.observations.delete(key); }
    }
  }
  private async copy(row: Operation, signal: AbortSignal) {
    const db = this.database.connection, plan = JSON.parse(row.plan_json) as Plan, target = this.roots.files.get(row.target_directory_id);
    if (target.grant.path !== plan.target.path || !sameVolumeRoot(target.grant.volume, plan.target.volume)) throw conflict("原目标目录或卷身份已变化，请恢复原磁盘，不接管同名替代目录");
    let evidence = row.evidence_json ? localFileEvidenceSchema.parse(JSON.parse(row.evidence_json)) : null;
    if (!evidence) {
      const source = this.directories.reader(plan.source.id);
      if (hash([source.grant.volume.volumeId, source.grant.volume.rootInode, source.grant.volume.rootBirthtimeNs]) !== row.source_namespace) throw conflict("原输入目录或卷身份已变化，请恢复原磁盘后重试");
      if (!sameSnapshot(plan.snapshot, await source.inspect(plan.sourceSegments))) throw conflict("来源文件版本已变化，请重新预览；原计划不会接管新内容");
      if (!this.stable(row.source_namespace + JSON.stringify(plan.sourceSegments), plan.snapshot)) return;
      await target.assertVacant(plan.targetSegments);
      const reserved = (db.prepare("SELECT plan_json FROM local_sync_operation WHERE id!=? AND target_directory_id=? AND phase IN ('PLANNED','COPYING')").all(row.id, row.target_directory_id) as { plan_json: string }[]).reduce((sum, other) => sum + (JSON.parse(other.plan_json) as Plan).snapshot.size, 0);
      assertSpaceBudget(await target.check(), plan.snapshot.size, reserved);
      if (row.phase === "COPYING") { await target.cleanupAttempt(row.attempt_id).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); row.attempt_id = randomUUID(); }
      db.prepare("UPDATE local_sync_operation SET phase='COPYING',attempt_id=?,updated_at=? WHERE id=?").run(row.attempt_id, new Date(this.now()).toISOString(), row.id);
      await target.prepareStage(row.attempt_id); const stage = await target.stageFilePath(row.attempt_id, plan.targetSegments);
      let digest = "";
      await source.read(plan.sourceSegments, plan.snapshot, async (reader) => {
        const writer = await open(stage, "wx", 0o600);
        try { digest = await source.digest(reader, plan.snapshot.size, signal, async (bytes) => { let offset = 0; while (offset < bytes.length) { const result = await writer.write(bytes, offset, bytes.length - offset); if (!result.bytesWritten) throw conflict("暂存写入没有进展，请检查目标磁盘"); offset += result.bytesWritten; } }); await writer.sync(); }
        finally { await writer.close(); }
        if (await source.digest(reader, plan.snapshot.size, signal) !== digest) throw conflict("来源内容在同步时变化，未发布正式文件，请重新预览");
      });
      evidence = await target.verifyStage(row.attempt_id, plan.targetSegments, plan.snapshot.size);
      if (evidence.sha256 !== digest) throw conflict("暂存内容校验失败，未发布正式文件，请核对磁盘后重试");
      db.prepare("UPDATE local_sync_operation SET phase='VERIFIED',evidence_json=?,updated_at=? WHERE id=?").run(JSON.stringify(evidence), new Date(this.now()).toISOString(), row.id);
    }
    if (signal.aborted || this.closed || !this.needed(row.id)) return;
    const committed = await target.commit(row.attempt_id, plan.targetSegments, evidence), stamp = new Date(this.now()).toISOString();
    try { db.transaction(() => {
      const receipt = new SyncReceipts(this.database, this.now).record({ source_kind: "local", source_namespace: row.source_namespace, source_object_key: row.source_object_key, source_version_key: row.source_version_key, version_json: row.version_json, target_directory_id: row.target_directory_id, target_slot: row.target_slot, target_segments_json: JSON.stringify(plan.targetSegments), completed_at: stamp, result_kind: "local-sync", result_id: row.id, request_variant: plan.variant }, committed.evidence);
      db.prepare("UPDATE local_sync_operation SET phase='RECORDED',failure=NULL,updated_at=? WHERE id=?").run(stamp, row.id);
      db.prepare("UPDATE local_sync_member SET state='DONE',receipt_id=?,failure=NULL WHERE operation_id=?").run(receipt.id, row.id);
    })(); } catch { throw new DesktopError("STORAGE_ERROR", "本地同步结果尚未完成记账，已提交文件保留；请重启核心后仅重试原作业，不要删除私有恢复文件", true); }
    await target.cleanupAttempt(row.attempt_id).catch(() => {});
  }
  pauseChanged(inputDirectoryId?: string, sourceId?: string) {
    if (!inputDirectoryId) this.resetObservations();
    else {
      const inputs = new Set([inputDirectoryId]);
      if (sourceId) for (const row of this.database.connection.prepare("SELECT o.plan_json FROM local_sync_operation o JOIN local_sync_member m ON m.operation_id=o.id JOIN sync_job j ON j.id=m.job_id WHERE j.source_id=? AND o.phase!='RECORDED'").all(sourceId) as { plan_json: string }[]) inputs.add((JSON.parse(row.plan_json) as Plan).source.id);
      for (const id of inputs) {
        const another = this.database.connection.prepare("SELECT 1 FROM sync_source_rule r JOIN sync_source_version v ON v.source_id=r.id AND v.version=r.version WHERE r.deleted_at IS NULL AND r.paused=0 AND json_extract(v.snapshot_json,'$.configuration.inputDirectoryId')=? LIMIT 1").get(id);
        if (!another) try { const grant = this.directories.grant(id), namespace = hash([grant.volume.volumeId, grant.volume.rootInode, grant.volume.rootBirthtimeNs]); for (const key of this.observations.keys()) if (key.startsWith(namespace)) this.observations.delete(key); } catch { /* 未授权目录没有可延续的稳定观察。 */ }
      }
    }
    for (const [id, controller] of this.active) if (!this.needed(id)) controller.abort();
  }
  retry(id: string) {
    const db = this.database.connection;
    db.transaction(() => { db.prepare("UPDATE local_sync_operation SET phase=CASE WHEN evidence_json IS NOT NULL THEN 'VERIFIED' WHEN phase='NEEDS_ATTENTION' THEN 'COPYING' ELSE phase END,failure=NULL WHERE id IN (SELECT operation_id FROM local_sync_member WHERE job_id=?) AND phase='NEEDS_ATTENTION'").run(id); db.prepare("UPDATE local_sync_member SET state='PENDING',failure=NULL WHERE job_id=? AND state='NEEDS_ATTENTION'").run(id); db.prepare("UPDATE sync_job SET state='RUNNING',failure=NULL WHERE id=? AND state='NEEDS_ATTENTION'").run(id); })();
  }
  hasActive(sourceId: string) { return (this.database.connection.prepare("SELECT m.operation_id FROM local_sync_member m JOIN sync_job j ON j.id=m.job_id WHERE j.source_id=? AND m.operation_id IS NOT NULL").all(sourceId) as { operation_id: string }[]).some((row) => this.active.has(row.operation_id)); }
  async close() { this.closed = true; for (const controller of this.active.values()) controller.abort(); await this.flight; }
}
