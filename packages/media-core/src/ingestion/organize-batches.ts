import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { CloudError, DesktopError, type CoreInput, type CoreOutput, type OrganizeBatch, type OrganizePreview } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import { RecognitionError, assertUniqueEpisodes } from "../domain/media.js";
import { MediaNetworkError } from "../infrastructure/json-http.js";
export interface BatchManifest { selection: CoreInput<"ingestion.preview">["selection"]; targets: { rootId: string; segments: string[]; canonical: string[]; path: string }[] }
interface Ports {
  capture(taskId: string, selection: CoreInput<"ingestion.preview">["selection"], revision: number): { sourcePath: string; context: string };
  check(taskId: string, selection: CoreInput<"ingestion.preview">["selection"], context: string): void;
  waiting(taskId: string): string | null;
  available(taskId: string): string | null | Promise<string | null>;
  preview(input: CoreInput<"ingestion.preview">): Promise<OrganizePreview>;
  manifest(previewId: string): BatchManifest;
  confirm(previewId: string, requestKey: string, batchId: string): Promise<{ operationId: string }>;
}
interface Job { id: string; state: "PREVIEWING" | "READY" | "BLOCKED" | "CONFIRMING" | "SUBMITTED" | "CANCELLED"; template: string | null; include_accessories: number; expires_at: number; failure: string | null; created_at: string; updated_at: string }
interface Item { batch_id: string; task_id: string; ordinal: number; source_path: string; request_key: string; confirm_key: string; selection_json: string; context_json: string; state: "PENDING" | "READY" | "BLOCKED" | "SUBMITTED" | "FAILED"; preview_id: string | null; manifest_json: string | null; operation_id: string | null; errors_json: string; waiting_reason: string | null; next_attempt_at: number }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message: string) => new DesktopError("CONFLICT", message);
function reason(error: unknown) { if (error instanceof MediaNetworkError) return { AUTH_REQUIRED: "TMDB 密钥或读取权限不可用，请在设置修复后重新预览", RATE_LIMITED: "TMDB 请求受限，请稍后重新预览", NETWORK_UNAVAILABLE: "TMDB 暂不可达，请检查网络和代理后重新预览", INVALID_RESPONSE: "TMDB 响应无法核实，请稍后重新预览", INTERRUPTED: "预览已中断，请重新预览", TIMEOUT: "TMDB 预览超时，请检查网络和代理后重试" }[error.code]; if (error instanceof DesktopError || error instanceof CloudError || error instanceof RecognitionError) return error.message.slice(0, 500); return "此文件的整理计划未能核实，请检查来源、目标和服务配置后重新预览；原文件保留"; }

/** 确认前只准备原单文件计划；确认后逐项提交，操作收据仍由流水线独占。 */
export class OrganizeBatches {
  private closed = false; private timer?: ReturnType<typeof setInterval>; private flight?: Promise<void>;
  constructor(private readonly database: CoreDatabase, private readonly ports: Ports, private readonly now = Date.now) {}
  private stamp() { return new Date(this.now()).toISOString(); }
  start() { if (!this.closed && !this.timer) this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 500); }
  private job(id: string) { const row = this.database.connection.prepare("SELECT * FROM ingestion_organize_batch WHERE id=?").get(id) as Job | undefined; if (!row) throw conflict("整理批次不存在，请刷新记录"); return row; }
  private rows(id: string) { return this.database.connection.prepare("SELECT * FROM ingestion_organize_batch_item WHERE batch_id=? ORDER BY ordinal").all(id) as Item[]; }
  create(input: CoreInput<"ingestion.preview-organize-batch">): OrganizeBatch {
    if (this.closed) throw conflict("整理服务正在停止，请等待核心恢复");
    const db = this.database.connection, signature = hash(input), prior = db.prepare("SELECT id,signature FROM ingestion_organize_batch WHERE request_key=?").get(input.requestKey) as { id: string; signature: string } | undefined;
    if (prior) { if (prior.signature !== signature) throw conflict("请求标识已用于另一组整理预览"); return this.get(prior.id); }
    if (new Set(input.items.map((item) => item.taskId)).size !== input.items.length) throw conflict("同一文件被重复选择，请取消重复项后预览");
    const members = input.items.map((item) => { try { return { ...item, ...this.ports.capture(item.taskId, item.selection, item.expectedRevision), errors: [] as string[] }; } catch (error) { const task = db.prepare("SELECT source_path FROM media_task WHERE id=?").get(item.taskId) as { source_path: string } | undefined; if (!task) throw conflict("所选任务不存在，请刷新后重新选择"); return { ...item, sourcePath: task.source_path, context: "", errors: [reason(error)] }; } });
    const id = randomUUID(), stamp = this.stamp();
    db.transaction(() => {
      db.prepare("INSERT INTO ingestion_organize_batch VALUES(?,?,?,'PREVIEWING',?,?,?,?,?,?)").run(id, input.requestKey, signature, input.template ?? null, Number(input.includeAccessories ?? true), this.now() + 600000, null, stamp, stamp);
      for (const [ordinal, item] of members.entries()) db.prepare("INSERT INTO ingestion_organize_batch_item(batch_id,task_id,ordinal,request_key,confirm_key,source_path,selection_json,context_json,state,errors_json) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, item.taskId, ordinal, randomUUID(), randomUUID(), item.sourcePath, JSON.stringify(item.selection), item.context, item.errors.length ? "BLOCKED" : "PENDING", JSON.stringify(item.errors));
    })(); return this.get(id);
  }
  private preview(row: Item): OrganizePreview | null { if (!row.preview_id) return null; const preview = this.database.connection.prepare("SELECT * FROM ingestion_preview WHERE id=?").get(row.preview_id) as { plan_json: string; expires_at: number; operation_id: string | null } | undefined; if (!preview) return null; const plan = JSON.parse(preview.plan_json); return { id: row.preview_id, taskId: row.task_id, title: plan.metadata.title, mediaType: plan.metadata.mediaType, sourcePath: row.source_path, targetPath: join(plan.target.path, ...plan.targetSegments), size: plan.snapshot.size, season: plan.selection.season, episode: plan.selection.episode, episodeEnd: plan.selection.episodeEnd, expiresAt: preview.expires_at, operationId: preview.operation_id, accessories: (plan.accessories ?? []).map((asset: { sourceSegments: string[]; targetSegments: string[]; snapshot: { size: number } }) => ({ sourcePath: join(plan.source.path, ...asset.sourceSegments), targetPath: join(plan.target.path, ...asset.targetSegments), size: asset.snapshot.size })) }; }
  private errors(job: Job, rows: Item[]) {
    const errors = new Map<string, string[]>(), add = (row: Item, message: string) => { const list = errors.get(row.task_id) ?? []; if (list.length < 20 && !list.includes(message)) list.push(message.slice(0, 500)); errors.set(row.task_id, list); };
    for (const row of rows) {
      for (const error of JSON.parse(row.errors_json) as string[]) add(row, error);
      if (row.state !== "READY") continue;
      const preview = this.preview(row); if (!preview || job.expires_at <= this.now() || preview.expiresAt <= this.now()) add(row, "整理预览已过期，请重新预览后确认");
      try { this.ports.check(row.task_id, JSON.parse(row.selection_json), row.context_json); } catch (error) { if (error instanceof DesktopError && error.code === "LOCAL_UNAVAILABLE") throw error; add(row, reason(error)); }
    }
    const manifests = rows.filter((row) => row.manifest_json).map((row) => ({ row, manifest: JSON.parse(row.manifest_json!) as BatchManifest }));
    for (let a = 0; a < manifests.length; a++) for (let b = a + 1; b < manifests.length; b++) {
      const first = manifests[a]!, second = manifests[b]!, x = first.manifest.selection, y = second.manifest.selection;
      if (x.mediaType !== "TV_SHOW" || y.mediaType !== "TV_SHOW" || x.tmdbId !== y.tmdbId || x.season !== y.season) continue;
      try { assertUniqueEpisodes([{ tmdbId: x.tmdbId, season: x.season!, episode: x.episode!, episodeEnd: x.episodeEnd ?? null }, { tmdbId: y.tmdbId, season: y.season!, episode: y.episode!, episodeEnd: y.episodeEnd ?? null }]); } catch {
        const start = Math.max(x.episode!, y.episode!), end = Math.min(x.episodeEnd ?? x.episode!, y.episodeEnd ?? y.episode!), message = `「${basename(first.row.source_path).slice(0, 100)}」与「${basename(second.row.source_path).slice(0, 100)}」重复或重叠：S${x.season} E${start}${end > start ? `–${end}` : ""}；请修改季集或取消重复文件后重新预览`;
        add(first.row, message); add(second.row, message);
      }
    }
    const files = new Map<string, Item[]>(), directories = new Map<string, Item[]>(), exact = new Map<string, { value: string; row: Item }>();
    const collision = (a: Item, b: Item, path: string) => { if (a.task_id === b.task_id) return; const message = `「${basename(a.source_path).slice(0, 100)}」与「${basename(b.source_path).slice(0, 100)}」目标冲突：${path.slice(-180)}；请修改模板或取消冲突文件`; add(a, message); add(b, message); };
    for (const { row, manifest } of manifests) for (const target of manifest.targets) {
      const key = target.rootId + JSON.stringify(target.canonical); for (const other of files.get(key) ?? []) collision(row, other, target.path); for (const other of directories.get(key) ?? []) collision(row, other, target.path);
      for (let depth = 1; depth <= target.canonical.length; depth++) {
        const prefix = target.rootId + JSON.stringify(target.canonical.slice(0, depth)), value = JSON.stringify(target.segments.slice(0, depth)), prior = exact.get(prefix);
        if (prior && prior.value !== value) collision(row, prior.row, target.path); else exact.set(prefix, { value, row });
        if (depth < target.canonical.length) { for (const other of files.get(prefix) ?? []) collision(row, other, target.path); const owners = directories.get(prefix) ?? []; if (!owners.some((owner) => owner.task_id === row.task_id)) owners.push(row); directories.set(prefix, owners); }
      }
      const owners = files.get(key) ?? []; owners.push(row); files.set(key, owners);
    }
    return errors;
  }
  private operation(row: Item) { if (!row.operation_id) return null; const db = this.database.connection, op = db.prepare("SELECT phase,failure_code FROM ingestion_operation WHERE id=?").get(row.operation_id) as { phase: string; failure_code: string | null } | undefined; if (!op) return null; const assets = db.prepare("SELECT phase FROM ingestion_accessory WHERE operation_id=?").all(row.operation_id) as { phase: string }[]; return { state: op.phase, done: op.phase === "RECORDED" && assets.every((asset) => asset.phase === "RECORDED"), failed: op.phase === "NEEDS_ATTENTION" || assets.some((asset) => asset.phase === "NEEDS_ATTENTION") }; }
  get(id: string): OrganizeBatch {
    const job = this.job(id), rows = this.rows(id), errors = job.state === "READY" ? this.errors(job, rows) : new Map<string, string[]>(), submitted = rows.filter((row) => row.operation_id).length, states = rows.map((row) => this.operation(row)), done = states.filter((op) => op?.done).length, failed = rows.filter((row, index) => row.state === "FAILED" || states[index]?.failed).length, blocked = rows.filter((row) => row.state === "BLOCKED" || errors.has(row.task_id)).length;
    const state = job.state === "READY" && errors.size ? job.expires_at <= this.now() ? "EXPIRED" : "BLOCKED" : job.state === "SUBMITTED" ? failed ? "PARTIAL_FAILED" : done === rows.length ? "DONE" : "SUBMITTED" : job.state;
    return { id, state, total: rows.length, previewed: rows.filter((row) => row.preview_id).length, submitted, done, failed, blocked, expiresAt: job.expires_at, failure: job.failure ?? (errors.size ? "成员、识别信息或预览已变化，请查看逐项原因并重新预览" : null), createdAt: job.created_at, updatedAt: job.updated_at };
  }
  list(input: CoreInput<"ingestion.organize-batches">) { const db = this.database.connection; return { items: (db.prepare("SELECT id FROM ingestion_organize_batch ORDER BY created_at DESC,id LIMIT 25 OFFSET ?").all(((input.page ?? 1) - 1) * 25) as { id: string }[]).map((row) => this.get(row.id)), total: (db.prepare("SELECT count(*) AS n FROM ingestion_organize_batch").get() as { n: number }).n }; }
  details(input: CoreInput<"ingestion.organize-batch">): CoreOutput<"ingestion.organize-batch"> {
    const job = this.job(input.id), all = this.rows(input.id), errors = job.state === "READY" ? this.errors(job, all) : new Map<string, string[]>(), page = input.page ?? 1;
    return { batch: this.get(input.id), page, items: all.slice((page - 1) * 25, page * 25).map((row) => { const preview = this.preview(row), assets = preview?.accessories ?? [], op = this.operation(row); return { taskId: row.task_id, sourcePath: row.source_path, selection: row.manifest_json ? (JSON.parse(row.manifest_json) as BatchManifest).selection : JSON.parse(row.selection_json), state: row.state, preview: preview ? { ...preview, accessories: [] } : null, accessoryCount: assets.length, operationId: row.operation_id, operationState: op?.state ?? null, errors: errors.get(row.task_id) ?? JSON.parse(row.errors_json), waitingReason: row.waiting_reason ?? (op?.failed ? "文件或附属文件整理需处理，请打开原任务查看原因并重试；本批次不会新建 COPY" : null) }; }) };
  }
  assets(input: CoreInput<"ingestion.organize-batch-assets">) { const row = this.rows(input.id).find((item) => item.task_id === input.taskId); if (!row) throw conflict("此文件不属于该批次"); return { items: this.preview(row)?.accessories ?? [] }; }
  confirm(input: CoreInput<"ingestion.confirm-organize-batch">) {
    if (this.closed) throw conflict("整理服务正在停止"); const db = this.database.connection;
    const old = db.prepare("SELECT batch_id FROM ingestion_organize_batch_confirmation WHERE request_key=?").get(input.requestKey) as { batch_id: string } | undefined;
    if (old) { if (old.batch_id !== input.id) throw conflict("请求标识已用于另一批次确认"); return this.get(input.id); }
    db.transaction(() => {
      const job = this.job(input.id); if (["CONFIRMING", "SUBMITTED"].includes(job.state)) { db.prepare("INSERT INTO ingestion_organize_batch_confirmation VALUES(?,?,?)").run(input.requestKey, input.id, this.stamp()); return; }
      if (job.state !== "READY") throw conflict("此批次尚未完整预览或已有阻断项，请重新预览");
      const errors = this.errors(job, this.rows(input.id));
      if (errors.size) { for (const [task, messages] of errors) db.prepare("UPDATE ingestion_organize_batch_item SET state='BLOCKED',errors_json=? WHERE batch_id=? AND task_id=?").run(JSON.stringify(messages), input.id, task); db.prepare("UPDATE ingestion_organize_batch SET state='BLOCKED',failure='确认前成员或计划已变化，请重新预览',updated_at=? WHERE id=?").run(this.stamp(), input.id); return; }
      db.prepare("UPDATE ingestion_organize_batch SET state='CONFIRMING',updated_at=? WHERE id=?").run(this.stamp(), input.id); db.prepare("INSERT INTO ingestion_organize_batch_confirmation VALUES(?,?,?)").run(input.requestKey, input.id, this.stamp());
    })(); return this.get(input.id);
  }
  cancel(id: string) { if (this.closed) throw conflict("整理服务正在停止"); this.job(id); this.database.connection.prepare("UPDATE ingestion_organize_batch SET state='CANCELLED',updated_at=? WHERE id=?").run(this.stamp(), id); return this.get(id); }
  tick(): Promise<void> { if (this.closed) return Promise.resolve(); return this.flight ??= this.run().finally(() => { this.flight = undefined; }); }
  private async run() {
    const db = this.database.connection, jobs = db.prepare("SELECT * FROM ingestion_organize_batch WHERE state IN ('PREVIEWING','CONFIRMING') AND (NOT EXISTS(SELECT 1 FROM ingestion_organize_batch_item i WHERE i.batch_id=ingestion_organize_batch.id AND i.state=CASE WHEN ingestion_organize_batch.state='PREVIEWING' THEN 'PENDING' ELSE 'READY' END) OR EXISTS(SELECT 1 FROM ingestion_organize_batch_item i WHERE i.batch_id=ingestion_organize_batch.id AND i.state=CASE WHEN ingestion_organize_batch.state='PREVIEWING' THEN 'PENDING' ELSE 'READY' END AND i.next_attempt_at<=?)) ORDER BY updated_at,id LIMIT 25").all(this.now()) as Job[]; let attempted = 0;
    for (const job of jobs) {
      const rows = this.rows(job.id);
      for (const row of rows) {
        if (this.closed) return; if (this.job(job.id).state !== job.state) break;
        if (job.state === "PREVIEWING" ? row.state !== "PENDING" : row.state !== "READY") continue; if (row.next_attempt_at > this.now()) continue;
        try {
          const received = row.preview_id ? (db.prepare("SELECT operation_id FROM ingestion_preview WHERE id=?").get(row.preview_id) as { operation_id: string | null })?.operation_id : null;
          if (!received) { if (job.expires_at <= this.now()) throw conflict("整理预览已过期，请重新预览后确认"); const wait = await this.ports.available(row.task_id); if (wait) { db.prepare("UPDATE ingestion_organize_batch_item SET waiting_reason=?,next_attempt_at=? WHERE batch_id=? AND task_id=?").run(wait, this.now() + 5000, job.id, row.task_id); continue; } this.ports.check(row.task_id, JSON.parse(row.selection_json), row.context_json); }
          if (this.closed) return;
          if (this.job(job.id).state !== job.state) break;
          if (++attempted > 4) return;
          if (job.state === "PREVIEWING") {
            const preview = await this.ports.preview({ taskId: row.task_id, requestKey: row.request_key, selection: JSON.parse(row.selection_json), includeAccessories: !!job.include_accessories, ...(job.template ? { template: job.template } : {}) }), manifest = this.ports.manifest(preview.id);
            this.ports.check(row.task_id, JSON.parse(row.selection_json), row.context_json);
            if (["PREVIEWING", "CANCELLED"].includes(this.job(job.id).state)) db.prepare("UPDATE ingestion_organize_batch_item SET state='READY',preview_id=?,manifest_json=?,waiting_reason=NULL WHERE batch_id=? AND task_id=?").run(preview.id, JSON.stringify(manifest), job.id, row.task_id);
          } else {
            const operation = received ? { operationId: received } : await this.ports.confirm(row.preview_id!, row.confirm_key, job.id);
            db.prepare("UPDATE ingestion_organize_batch_item SET state='SUBMITTED',operation_id=?,waiting_reason=NULL WHERE batch_id=? AND task_id=?").run(operation.operationId, job.id, row.task_id);
          }
        } catch (error) {
          const received = row.preview_id ? (db.prepare("SELECT operation_id FROM ingestion_preview WHERE id=?").get(row.preview_id) as { operation_id: string | null })?.operation_id : null;
          if (!received && this.closed) { db.prepare("UPDATE ingestion_organize_batch_item SET waiting_reason='核心已停止，重启后继续核对原预览与确认意图',next_attempt_at=0 WHERE batch_id=? AND task_id=?").run(job.id, row.task_id); return; }
          if (received) db.prepare("UPDATE ingestion_organize_batch_item SET operation_id=?,waiting_reason='原操作已提交，等待批次补记；不会重复复制',next_attempt_at=? WHERE batch_id=? AND task_id=?").run(received, this.now() + 5000, job.id, row.task_id);
          else if (this.ports.waiting(row.task_id) || (error instanceof DesktopError || error instanceof CloudError) && error.code === "LOCAL_UNAVAILABLE") db.prepare("UPDATE ingestion_organize_batch_item SET waiting_reason=?,next_attempt_at=? WHERE batch_id=? AND task_id=?").run(this.ports.waiting(row.task_id) ?? "来源或目标暂不可用，请核对原磁盘、权限和可用空间；恢复后继续", this.now() + 5000, job.id, row.task_id);
          else db.prepare("UPDATE ingestion_organize_batch_item SET state=?,errors_json=?,waiting_reason=NULL WHERE batch_id=? AND task_id=?").run(job.state === "PREVIEWING" ? "BLOCKED" : "FAILED", JSON.stringify([reason(error)]), job.id, row.task_id);
        }
      }
      if (this.job(job.id).state !== job.state) continue;
      const latest = this.rows(job.id);
      if (job.state === "PREVIEWING" && latest.every((row) => row.state !== "PENDING")) {
        const errors = this.errors(job, latest); db.transaction(() => { for (const [task, messages] of errors) db.prepare("UPDATE ingestion_organize_batch_item SET state='BLOCKED',errors_json=? WHERE batch_id=? AND task_id=?").run(JSON.stringify(messages), job.id, task); db.prepare("UPDATE ingestion_organize_batch SET state=?,failure=?,updated_at=? WHERE id=?").run(errors.size ? "BLOCKED" : "READY", errors.size ? "部分文件的计划无法确认，请查看逐项原因" : null, this.stamp(), job.id); })();
      } else if (job.state === "CONFIRMING" && latest.every((row) => row.state !== "READY")) db.prepare("UPDATE ingestion_organize_batch SET state='SUBMITTED',updated_at=? WHERE id=?").run(this.stamp(), job.id);
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.flight?.catch(() => {}); }
}
