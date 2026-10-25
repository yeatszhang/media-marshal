import { randomUUID } from "node:crypto";
import { DesktopError, type OrganizePreview, type Recognition } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import { selectAutomaticWork } from "./automatic-selection.js";
import type { MediaSelection } from "./coordinates.js";
import { previewFailure } from "./preview-errors.js";

export type AutomaticAvailability = { state: "READY" } | { state: "WAITING" | "MANUAL"; reason: string };
interface AutomaticRow {
  id: string; candidate_id: string; source_id: string; context: string;
  state: "PENDING" | "RECOGNIZING" | "PREVIEWING" | "CONFIRMING" | "SUBMITTED" | "NEEDS_REVIEW";
  task_id: string | null; preview_id: string | null; operation_id: string | null; selection_json: string | null;
  recognition_key: string; preview_key: string; confirmation_key: string; failure: string | null;
}
export interface AutomaticHooks {
  check(candidateId: string, sourceId: string, context: string): AutomaticAvailability;
  available(candidateId: string): Promise<AutomaticAvailability>;
  recognize(candidateId: string, requestKey: string): Promise<{ taskId: string }>;
  task(taskId: string): Recognition;
  preview(taskId: string, requestKey: string, selection: MediaSelection): Promise<OrganizePreview>;
  confirm(previewId: string, requestKey: string, check: () => void): Promise<{ operationId: string }>;
  receipt(requestKey: string): { operationId: string } | null;
}

/** 只推进已授权的持久意图；页面等待和 Core 重启均不生成新的执行键。 */
export class AutomaticIngestion {
  private closed = false;
  private flight?: Promise<void>;
  constructor(private readonly database: CoreDatabase, private readonly hooks: AutomaticHooks, private readonly now = Date.now) {}
  enqueue(input: { candidateId: string; sourceId: string; context: string }) {
    if (this.closed) return;
    const db = this.database.connection;
    if (db.prepare("SELECT 1 FROM ingestion_automatic WHERE candidate_id=?").get(input.candidateId)) return;
    const availability = this.hooks.check(input.candidateId, input.sourceId, input.context);
    const stamp = new Date(this.now()).toISOString();
    db.prepare("INSERT INTO ingestion_automatic(id,candidate_id,source_id,context,state,recognition_key,preview_key,confirmation_key,failure,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(), input.candidateId, input.sourceId, input.context, availability.state === "MANUAL" ? "NEEDS_REVIEW" : "PENDING", randomUUID(), randomUUID(), randomUUID(), availability.state === "READY" ? null : availability.reason, stamp, stamp);
  }
  status(candidateId: string) {
    const row = this.database.connection.prepare("SELECT * FROM ingestion_automatic WHERE candidate_id=?").get(candidateId) as AutomaticRow | undefined;
    return row ? { id: row.id, state: row.state, reason: row.failure, operationId: row.operation_id } : null;
  }
  private update(row: AutomaticRow, patch: Partial<Pick<AutomaticRow, "state" | "task_id" | "preview_id" | "operation_id" | "selection_json" | "failure">>) {
    Object.assign(row, patch);
    this.database.connection.prepare("UPDATE ingestion_automatic SET state=?,task_id=?,preview_id=?,operation_id=?,selection_json=?,failure=?,updated_at=? WHERE id=?")
      .run(row.state, row.task_id, row.preview_id, row.operation_id, row.selection_json, row.failure, new Date(this.now()).toISOString(), row.id);
  }
  private check(row: AutomaticRow): AutomaticAvailability {
    if (this.closed) return { state: "WAITING", reason: "整理服务正在停止，原自动意图保留" };
    const availability = this.hooks.check(row.candidate_id, row.source_id, row.context);
    if (availability.state !== "READY" || !row.task_id) return availability;
    const task = this.hooks.task(row.task_id);
    if ((task.revision ?? 0) > 0 || task.matchesStale) return { state: "MANUAL", reason: "识别信息已被人工编辑，请重新预览并确认整理" };
    if (["PREVIEWING", "CONFIRMING"].includes(row.state) && task.state !== "AWAITING_CONFIRMATION") return { state: "MANUAL", reason: "识别状态已经变化，请核对原任务后人工重新预览" };
    return availability;
  }
  private canContinue(row: AutomaticRow) {
    const state = this.check(row);
    if (state.state === "READY") return true;
    this.update(row, { ...(state.state === "MANUAL" ? { state: "NEEDS_REVIEW" as const } : {}), failure: state.reason });
    return false;
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.flight ??= this.run().finally(() => { this.flight = undefined; });
  }
  private async run() {
    const rows = this.database.connection.prepare("SELECT * FROM ingestion_automatic WHERE state NOT IN ('SUBMITTED','NEEDS_REVIEW') ORDER BY updated_at,id LIMIT 10").all() as AutomaticRow[];
    for (const row of rows) {
      if (this.closed) return;
      // 确认事务可能已提交而回执未落到自动意图；先读取原收据，不因新配置隐藏既有文件计划。
      const receipt = this.hooks.receipt(row.confirmation_key);
      if (receipt) { this.update(row, { state: "SUBMITTED", operation_id: receipt.operationId, failure: null }); continue; }
      if (!this.canContinue(row)) continue;
      try {
        const available = await this.hooks.available(row.candidate_id);
        if (!this.canContinue(row)) continue;
        if (available.state !== "READY") { this.update(row, { ...(available.state === "MANUAL" ? { state: "NEEDS_REVIEW" as const } : {}), failure: available.reason }); continue; }
        if (row.state === "PENDING") {
          const task = await this.hooks.recognize(row.candidate_id, row.recognition_key);
          this.update(row, { task_id: task.taskId, state: "RECOGNIZING", failure: null });
          continue;
        }
        if (row.state === "RECOGNIZING") {
          const task = this.hooks.task(row.task_id!);
          if (["PENDING", "PROCESSING"].includes(task.state)) { this.update(row, { failure: "等待后台识别完成" }); continue; }
          const choice = selectAutomaticWork(task);
          if ("reason" in choice) { this.update(row, { state: "NEEDS_REVIEW", failure: choice.reason }); continue; }
          this.update(row, { state: "PREVIEWING", selection_json: JSON.stringify(choice.selection), failure: null });
        }
        if (row.state === "PREVIEWING") {
          const preview = await this.hooks.preview(row.task_id!, row.preview_key, JSON.parse(row.selection_json!));
          if (!this.canContinue(row)) continue;
          this.update(row, { state: "CONFIRMING", preview_id: preview.id, failure: null });
        }
        if (row.state === "CONFIRMING") {
          const submitted = await this.hooks.confirm(row.preview_id!, row.confirmation_key, () => {
            if (this.check(row).state !== "READY") throw new DesktopError("CONFLICT", "自动整理授权、来源或配置已变化，请人工重新预览");
          });
          this.update(row, { state: "SUBMITTED", operation_id: submitted.operationId, failure: null });
        }
      } catch (error) {
        const receipt = this.hooks.receipt(row.confirmation_key);
        if (receipt) { this.update(row, { state: "SUBMITTED", operation_id: receipt.operationId, failure: null }); continue; }
        if (!this.canContinue(row)) continue;
        const failure = previewFailure(error);
        this.update(row, { state: "NEEDS_REVIEW", failure: failure instanceof DesktopError ? failure.message.slice(0, 500) : "自动整理未完成，请在待处理核对原任务并重新预览" });
      }
    }
  }
  async close() { this.closed = true; await this.flight?.catch(() => {}); }
}
