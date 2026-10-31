import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DesktopError,
  downloadCleanupPreviewSchema,
  type CoreInput,
  type DownloadCleanup as CleanupDescription,
} from "@media-marshal/contracts";
import type { NativeRenameApi } from "../files/native-rename.js";
import type { CoreDatabase } from "../infrastructure/database.js";
import { DownloadCleanupEvidence } from "./download-cleanup-evidence.js";
import { DownloadCleanup } from "./download-cleanup.js";
import { downloadCleanupPlanSchema, type DownloadCleanupPlan } from "./download-cleanup-journal.js";
import { OwnedAttemptCleanup, type AttemptOwner } from "../files/owned-attempt-cleanup.js";
import { isLibraryVideo } from "../sources/emby-library-files.js";

interface Intent {
  id: string;
  operation_id: string;
  accessory_id: string | null;
  task_id: string;
  state: string;
  failure: string | null;
  created_at: string;
}
interface Preview {
  id: string;
  request_key: string;
  receipt_ids_json: string;
  state: "PREPARING" | "READY" | "BLOCKED" | "CONFIRMED" | "CANCELLED" | "EXPIRED";
  plans_json: string;
  failure: string | null;
  expires_at: number;
}
interface Prepared {
  receiptId: string;
  taskId: string | null;
  plan: DownloadCleanupPlan;
}
const conflict = (message: string) => new DesktopError("CONFLICT", message);

export class DownloadCleanupService {
  readonly evidence;
  readonly engine;
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private readonly previewReaders = new Map<string, AbortController>();
  private closed = false;
  constructor(
    private readonly database: CoreDatabase,
    native?: NativeRenameApi,
    private readonly now = Date.now,
    caches?: ConstructorParameters<typeof DownloadCleanup>[2],
  ) {
    this.evidence = new DownloadCleanupEvidence(database);
    this.engine = new DownloadCleanup(
      this.evidence,
      native,
      caches ?? ((row) => this.cleanupCaches(row.task_id, row.receipt_id)),
    );
    // 准备尚未改变文件，强杀后可重新读取；领取和删除阶段由各自持久日志恢复。
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 3000);
    this.timer.unref();
    void this.tick();
  }
  tick() {
    if (this.flight) return this.flight;
    if (this.closed) return Promise.resolve();
    return (this.flight = this.work().finally(() => {
      this.flight = undefined;
    }));
  }
  private async work() {
    const db = this.database.connection;
    for (const row of db
      .prepare(
        "SELECT owner_kind,owner_id FROM owned_attempt_cleanup WHERE state='PENDING' LIMIT 20",
      )
      .all() as { owner_kind: AttemptOwner; owner_id: string }[]) {
      if (this.closed) return;
      await new OwnedAttemptCleanup(this.database).run(row.owner_kind, row.owner_id);
    }
    for (const intent of db
      .prepare(
        "SELECT * FROM download_cleanup_intent WHERE state='PENDING' ORDER BY created_at LIMIT 20",
      )
      .all() as Intent[]) {
      if (this.closed) return;
      const table = intent.accessory_id ? "ingestion_accessory" : "ingestion_operation",
        id = intent.accessory_id ?? intent.operation_id;
      const operation = db.prepare(`SELECT phase,plan_json FROM ${table} WHERE id=?`).get(id) as {
        phase: string;
        plan_json: string;
      };
      if (operation.phase !== "RECORDED") continue;
      try {
        const plan = JSON.parse(operation.plan_json),
          parts: string[] = plan.sourceSegments;
        const receipt = db
          .prepare(
            "SELECT id FROM sync_receipt WHERE target_directory_id=? AND target_segments_json=?",
          )
          .get(plan.source.id, JSON.stringify(parts.slice(1))) as { id: string } | undefined;
        if (parts[0] !== "completed" || !receipt)
          throw conflict("此文件没有对应的成功同步收据，保留原件；请核对下载所有权后重试");
        const evidence = await this.prepareEvidence(
          receipt.id,
          intent.task_id,
          "ORGANIZE",
          { id: plan.logicalTargetId ?? plan.target.id, segments: plan.targetSegments },
          this.controller.signal,
        );
        if (this.closed) return;
        const row = this.evidence.journal.create(receipt.id, intent.task_id, evidence);
        db.prepare(
          "UPDATE download_cleanup_intent SET state='READY',cleanup_id=?,failure=NULL WHERE id=?",
        ).run(row.id, intent.id);
      } catch (error) {
        if (this.closed) return;
        if ((error as { code?: string }).code === "LOCAL_UNAVAILABLE") {
          db.prepare("UPDATE download_cleanup_intent SET failure=? WHERE id=?").run(
            error instanceof DesktopError
              ? error.message.slice(0, 500)
              : "等待原卷及目录授权恢复，清理尚未执行",
            intent.id,
          );
          continue;
        }
        db.prepare(
          "UPDATE download_cleanup_intent SET state='NEEDS_ATTENTION',failure=? WHERE id=?",
        ).run(
          error instanceof DesktopError
            ? error.message.slice(0, 500)
            : "清理核验未完成；原件已保留，请恢复原卷及 Emby 目录关联后重试",
          intent.id,
        );
      }
    }
    for (const preview of db
      .prepare(
        "SELECT * FROM download_cleanup_preview WHERE state='PREPARING' ORDER BY created_at LIMIT 1",
      )
      .all() as Preview[])
      await this.preparePreview(preview);
    for (const row of db
      .prepare(
        "SELECT id FROM download_cleanup WHERE phase NOT IN ('DONE','NEEDS_ATTENTION') ORDER BY updated_at LIMIT 20",
      )
      .all() as { id: string }[]) {
      if (this.closed) return;
      await this.engine.run(row.id);
    }
  }
  private async prepareEvidence(
    receiptId: string,
    taskId: string | null,
    authorization: DownloadCleanupPlan["authorization"],
    target: { id: string; segments: string[] } | undefined,
    signal: AbortSignal,
  ) {
    try {
      return await this.evidence.prepare(receiptId, taskId, authorization, target, signal);
    } catch (error) {
      // 已整理的视频可能随后被修正改名；登记清理前可按完整内容找到当前库内副本。
      if (!target || !isLibraryVideo(target.segments.at(-1) ?? "") || signal.aborted) throw error;
      return this.evidence.prepare(receiptId, taskId, authorization, undefined, signal);
    }
  }
  private async cleanupCaches(taskId: string | null, receiptId: string) {
    const rows = this.database.connection
      .prepare(
        "SELECT a.owner_kind,a.owner_id FROM owned_attempt_cleanup a WHERE (a.owner_kind='download_attempt' AND a.attempt_id IN (SELECT c.attempt_id FROM download_commit_intent c JOIN sync_receipt r ON r.result_kind='download-item' AND r.result_id=c.item_id WHERE r.id=?)) OR (a.owner_kind='local_sync_operation' AND a.owner_id IN (SELECT result_id FROM sync_receipt WHERE id=? AND result_kind='local-sync')) OR (a.owner_kind='ingestion_operation' AND a.owner_id IN (SELECT id FROM ingestion_operation WHERE task_id=?)) OR (a.owner_kind='ingestion_accessory' AND a.owner_id IN (SELECT id FROM ingestion_accessory WHERE operation_id IN (SELECT id FROM ingestion_operation WHERE task_id=?)))",
      )
      .all(receiptId, receiptId, taskId, taskId) as {
      owner_kind: AttemptOwner;
      owner_id: string;
    }[];
    const owner = new OwnedAttemptCleanup(this.database);
    for (const row of rows) {
      await owner.run(row.owner_kind, row.owner_id);
      const result = this.database.connection
        .prepare(
          "SELECT state,failure FROM owned_attempt_cleanup WHERE owner_kind=? AND owner_id=?",
        )
        .get(row.owner_kind, row.owner_id) as { state: string; failure: string | null };
      if (result.state !== "DONE")
        throw new DesktopError(
          "LOCAL_UNAVAILABLE",
          result.failure ?? "所属暂存目录尚未回收，请恢复原卷后重试",
          true,
        );
    }
  }
  list(input: CoreInput<"cleanup.list">): CleanupDescription[] {
    const db = this.database.connection,
      result = this.evidence.journal
        .list(input.taskId)
        .map((row) => this.evidence.journal.describe(row));
    for (const intent of db
      .prepare(
        "SELECT * FROM download_cleanup_intent WHERE state!='READY' AND (? IS NULL OR task_id=?) ORDER BY created_at",
      )
      .all(input.taskId ?? null, input.taskId ?? null) as Intent[]) {
      const operation = db
          .prepare(
            `SELECT plan_json FROM ${intent.accessory_id ? "ingestion_accessory" : "ingestion_operation"} WHERE id=?`,
          )
          .get(intent.accessory_id ?? intent.operation_id) as { plan_json: string },
        plan = JSON.parse(operation.plan_json);
      result.push({
        kind: "SOURCE",
        id: intent.id,
        receiptId: null,
        taskId: intent.task_id,
        phase: intent.state === "NEEDS_ATTENTION" ? "NEEDS_ATTENTION" : "PENDING",
        resumePhase: null,
        sourcePath: join(plan.source.path, ...plan.sourceSegments),
        targetPath: join(plan.target.path, ...plan.targetSegments),
        size: plan.snapshot.size,
        freedBytes: 0,
        waitingReason: intent.state === "PENDING" ? "等待文件完成整理及内容核验" : null,
        failure: intent.failure,
        updatedAt: intent.created_at,
      });
    }
    for (const cache of db
      .prepare(
        "SELECT a.*,coalesce(o.task_id,x.task_id) AS task_id FROM owned_attempt_cleanup a LEFT JOIN ingestion_operation o ON a.owner_kind='ingestion_operation' AND o.id=a.owner_id LEFT JOIN ingestion_accessory z ON a.owner_kind='ingestion_accessory' AND z.id=a.owner_id LEFT JOIN ingestion_operation x ON x.id=z.operation_id WHERE a.state!='DONE' AND (? IS NULL OR coalesce(o.task_id,x.task_id)=?)",
      )
      .all(input.taskId ?? null, input.taskId ?? null) as {
      owner_id: string;
      attempt_id: string;
      task_id: string | null;
      state: string;
      failure: string | null;
      grant_json: string;
      updated_at: string;
      retained_bytes: number;
      released_bytes: number;
    }[]) {
      const grant = JSON.parse(cache.grant_json);
      result.push({
        kind: "TEMPORARY",
        id: cache.owner_id,
        receiptId: null,
        taskId: cache.task_id,
        phase: cache.state === "NEEDS_ATTENTION" ? "NEEDS_ATTENTION" : "CACHE_PENDING",
        resumePhase: null,
        sourcePath: join(grant.path, ".media-marshal", "staging", cache.attempt_id),
        targetPath: grant.path,
        size: cache.retained_bytes,
        freedBytes: cache.released_bytes,
        waitingReason: cache.state === "PENDING" ? "等待所属作业释放临时资源" : null,
        failure: cache.failure,
        updatedAt: cache.updated_at,
      });
    }
    return result
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(((input.page ?? 1) - 1) * 100, (input.page ?? 1) * 100);
  }
  scope(input: CoreInput<"cleanup.scope">) {
    const db = this.database.connection;
    const rows = db.prepare(
      "SELECT r.id,r.target_segments_json,r.size,m.canonical_path FROM sync_receipt r JOIN managed_download_root m ON m.id=r.target_directory_id JOIN sync_receipt_evidence e ON e.receipt_id=r.id WHERE NOT EXISTS(SELECT 1 FROM download_cleanup c WHERE c.receipt_id=r.id) ORDER BY r.completed_at,r.id LIMIT 50 OFFSET ?",
    );
    // 按任务查看时只接受该任务已经登记的原件路径；全局范围也仅列有收据的受管文件。
    if (input.taskId) {
      const operation = db
        .prepare("SELECT plan_json FROM ingestion_operation WHERE task_id=? AND phase='RECORDED'")
        .get(input.taskId) as { plan_json: string } | undefined;
      if (!operation) return [];
      const plan = JSON.parse(operation.plan_json);
      const receipt = db
        .prepare(
          "SELECT r.id,r.size,m.canonical_path,r.target_segments_json FROM sync_receipt r JOIN managed_download_root m ON m.id=r.target_directory_id WHERE r.target_directory_id=? AND r.target_segments_json=? AND NOT EXISTS(SELECT 1 FROM download_cleanup c WHERE c.receipt_id=r.id)",
        )
        .get(plan.source.id, JSON.stringify(plan.sourceSegments.slice(1))) as
        | { id: string; size: number; canonical_path: string; target_segments_json: string }
        | undefined;
      return receipt
        ? [
            {
              receiptId: receipt.id,
              sourcePath: join(
                receipt.canonical_path,
                "completed",
                ...JSON.parse(receipt.target_segments_json),
              ),
              size: receipt.size,
            },
          ]
        : [];
    }
    return (
      rows.all(((input.page ?? 1) - 1) * 50) as {
        id: string;
        target_segments_json: string;
        size: number;
        canonical_path: string;
      }[]
    ).map((row) => ({
      receiptId: row.id,
      sourcePath: join(row.canonical_path, "completed", ...JSON.parse(row.target_segments_json)),
      size: row.size,
    }));
  }
  preview(input: CoreInput<"cleanup.preview">) {
    const ids = [...new Set(input.receiptIds)].sort(),
      db = this.database.connection;
    const existing = db
      .prepare("SELECT * FROM download_cleanup_preview WHERE request_key=?")
      .get(input.requestKey) as Preview | undefined;
    if (existing) {
      if (existing.receipt_ids_json !== JSON.stringify(ids))
        throw conflict("此请求已用于另一清理范围，请重新预览");
      return this.getPreview(existing.id);
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO download_cleanup_preview(id,request_key,receipt_ids_json,state,expires_at,created_at) VALUES(?,?,?,'PREPARING',?,?)",
    ).run(
      id,
      input.requestKey,
      JSON.stringify(ids),
      this.now() + 15 * 60 * 1000,
      new Date(this.now()).toISOString(),
    );
    void this.tick();
    return this.getPreview(id);
  }
  private async preparePreview(preview: Preview) {
    const controller = new AbortController(),
      signal = AbortSignal.any([this.controller.signal, controller.signal]);
    this.previewReaders.set(preview.id, controller);
    let currentObject = "所选受管文件";
    try {
      const prepared: Prepared[] = [];
      for (const receiptId of JSON.parse(preview.receipt_ids_json) as string[]) {
        if (this.closed || this.getPreview(preview.id).state !== "PREPARING") return;
        const receipt = this.database.connection
          .prepare("SELECT target_directory_id,target_segments_json FROM sync_receipt WHERE id=?")
          .get(receiptId) as
          { target_directory_id: string; target_segments_json: string } | undefined;
        const root = receipt
          ? (this.database.connection
              .prepare("SELECT canonical_path FROM managed_download_root WHERE id=?")
              .get(receipt.target_directory_id) as { canonical_path: string } | undefined)
          : undefined;
        currentObject =
          receipt && root
            ? join(
                root.canonical_path,
                "completed",
                ...JSON.parse(receipt.target_segments_json),
              ).slice(-200)
            : `成功收据 ${receiptId}`;
        const parts = receipt
          ? JSON.stringify(["completed", ...JSON.parse(receipt.target_segments_json)])
          : "[]";
        const recorded = receipt
          ? (this.database.connection
              .prepare(
                "SELECT plan_json FROM ingestion_operation WHERE phase='RECORDED' AND json_extract(plan_json,'$.source.id')=? AND json_extract(plan_json,'$.sourceSegments')=? UNION ALL SELECT plan_json FROM ingestion_accessory WHERE phase='RECORDED' AND json_extract(plan_json,'$.source.id')=? AND json_extract(plan_json,'$.sourceSegments')=? LIMIT 1",
              )
              .get(receipt.target_directory_id, parts, receipt.target_directory_id, parts) as
              { plan_json: string } | undefined)
          : undefined;
        const delivery = recorded ? JSON.parse(recorded.plan_json) : null;
        const plan = await this.prepareEvidence(
          receiptId,
          null,
          "HISTORICAL_PREVIEW",
          delivery
            ? {
                id: delivery.logicalTargetId ?? delivery.target.id,
                segments: delivery.targetSegments,
              }
            : undefined,
          signal,
        );
        const task = this.database.connection
          .prepare("SELECT id FROM media_task WHERE target_path=? AND status='DONE' LIMIT 1")
          .get(join(plan.target.grant.path, ...plan.target.segments)) as { id: string } | undefined;
        prepared.push({ receiptId, taskId: task?.id ?? null, plan });
        this.database.connection
          .prepare(
            "UPDATE download_cleanup_preview SET plans_json=? WHERE id=? AND state='PREPARING'",
          )
          .run(JSON.stringify(prepared), preview.id);
      }
      if (this.closed) return;
      this.database.connection
        .prepare(
          "UPDATE download_cleanup_preview SET state='READY',plans_json=?,expires_at=? WHERE id=? AND state='PREPARING'",
        )
        .run(JSON.stringify(prepared), this.now() + 15 * 60 * 1000, preview.id);
    } catch (error) {
      if (this.closed) return;
      this.database.connection
        .prepare(
          "UPDATE download_cleanup_preview SET state='BLOCKED',failure=? WHERE id=? AND state='PREPARING'",
        )
        .run(
          `${currentObject}：${error instanceof DesktopError ? error.message : "范围核验未完成；请恢复原卷及媒体库目录后重新预览，文件未删除"}`.slice(
            0,
            500,
          ),
          preview.id,
        );
    } finally {
      if (this.previewReaders.get(preview.id) === controller)
        this.previewReaders.delete(preview.id);
    }
  }
  getPreview(id: string) {
    const row = this.database.connection
      .prepare("SELECT * FROM download_cleanup_preview WHERE id=?")
      .get(id) as Preview | undefined;
    if (!row) throw conflict("清理预览已不存在，请重新选择范围");
    return downloadCleanupPreviewSchema.parse({
      id,
      state: row.state === "READY" && row.expires_at <= this.now() ? "EXPIRED" : row.state,
      items: (JSON.parse(row.plans_json) as Prepared[]).map((item) => ({
        receiptId: item.receiptId,
        sourcePath: join(item.plan.source.grant.path, ...item.plan.source.segments),
        targetPath: join(item.plan.target.grant.path, ...item.plan.target.segments),
        size: item.plan.source.evidence.size,
      })),
      failure: row.failure,
      expiresAt: row.expires_at,
    });
  }
  async confirm(id: string) {
    const preview = this.getPreview(id);
    if (preview.state === "CONFIRMED") return {};
    if (preview.state !== "READY") throw conflict("清理预览未就绪或已过期，请重新预览具体文件范围");
    const row = this.database.connection
      .prepare("SELECT * FROM download_cleanup_preview WHERE id=?")
      .get(id) as Preview;
    this.database.connection.transaction(() => {
      if (this.closed || this.getPreview(id).state !== "READY")
        throw conflict("清理预览状态已变化，请刷新核对");
      // 短事务只核对授权并登记具体意图；完整源／目标重读留给持久执行器，不能占住公开 RPC 数分钟。
      for (const item of JSON.parse(row.plans_json) as Prepared[]) {
        const plan = downloadCleanupPlanSchema.parse(item.plan);
        this.evidence.assertAuthorization(plan);
        this.evidence.journal.create(item.receiptId, item.taskId, plan);
      }
      this.database.connection
        .prepare("UPDATE download_cleanup_preview SET state='CONFIRMED' WHERE id=?")
        .run(id);
    })();
    void this.tick();
    return {};
  }
  cancel(id: string) {
    this.getPreview(id);
    this.database.connection
      .prepare(
        "UPDATE download_cleanup_preview SET state='CANCELLED' WHERE id=? AND state IN ('PREPARING','READY','BLOCKED')",
      )
      .run(id);
    this.previewReaders.get(id)?.abort();
    return {};
  }
  retry(id: string) {
    if (
      this.database.connection
        .prepare("SELECT 1 FROM owned_attempt_cleanup WHERE owner_id=?")
        .get(id)
    ) {
      this.database.connection
        .prepare(
          "UPDATE owned_attempt_cleanup SET state='PENDING',failure=NULL WHERE owner_id=? AND state='NEEDS_ATTENTION'",
        )
        .run(id);
      void this.tick();
      return {};
    }
    const intent = this.database.connection
      .prepare("SELECT id FROM download_cleanup_intent WHERE id=?")
      .get(id);
    if (intent)
      this.database.connection
        .prepare(
          "UPDATE download_cleanup_intent SET state='PENDING',failure=NULL WHERE id=? AND state='NEEDS_ATTENTION'",
        )
        .run(id);
    else this.evidence.journal.retry(id);
    void this.tick();
    return {};
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.engine.close();
    await this.flight;
  }
}
