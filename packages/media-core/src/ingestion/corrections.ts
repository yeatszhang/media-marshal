import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { DesktopError, publicError, correctionActions, selectionSchema, type CoreInput, type CoreOutput, type CorrectionOperation } from "@media-marshal/contracts";
import { localFileEvidenceSchema, managedRootGrantSchema } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { MediaConnections } from "../application/media-connections.js";
import { reconcileEpisodes, assertUniqueEpisodes } from "../domain/media.js";
import { templatePath } from "../domain/template.js";
import { titleInitial } from "../domain/title-initial.js";
import { ManagedRoot, assertSpaceBudget, sameVolumeRoot } from "../files/index.js";
import { FileRelocations, type RelocationRow } from "../files/relocations.js";
import type { NativeRenameApi } from "../files/native-rename.js";
import type { IngestionPipeline } from "./pipeline.js";
import { assertMediaCoordinates } from "./coordinates.js";
import { previewFailure } from "./preview-errors.js";
import { CorrectionBatches, type BatchConfirmationMember } from "./correction-batches.js";
import { CorrectionPreparations, type PreparationProgress } from "./correction-preparations.js";
import { correctionConflict, correctionHash, correctionManifest, correctionReceipt, correctionTask, collectCorrectionAssets, assertCorrectionTarget, type CorrectionPlan, type CorrectionAsset } from "./correction-assets.js";

interface PreviewRow { id: string; request_key: string; task_id: string; input_hash: string; plan_json: string; expires_at: number; operation_id: string | null }
interface OperationRow { id: string; original_task_id: string; new_task_id: string; plan_json: string; phase: CorrectionOperation["state"]; evidence_json: string | null; failure: string | null; cleanup_pending: number; cleanup_due: number; created_at: string; updated_at: string; job_id: string }
const operationQuery = "SELECT o.*,i.job_id FROM media_correction_operation o JOIN correction_item i ON i.id=o.id";
const timestamp = (now: () => number) => new Date(now()).toISOString();
/** 普通视频的修正编排；SQL 只记意图和历史，实际 IO 由持久文件执行器推进。 */
export class Corrections {
  readonly files: FileRelocations | undefined;
  readonly preparations: CorrectionPreparations;
  readonly batches: CorrectionBatches;
  private readonly previewGeneration = randomUUID();
  private readonly lifetime = new AbortController();
  private readonly previews = new Map<string, { hash: string; flight: Promise<CoreOutput<"corrections.get-preview">> }>();
  private timer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private closed = false;
  constructor(private readonly database: CoreDatabase, private readonly ingestion: IngestionPipeline, private readonly connections: MediaConnections, native?: NativeRenameApi, private readonly now = Date.now) {
    if (native) this.files = new FileRelocations(database, ingestion.targets, native, now, () => !ingestion.pauseStatus().paused);
    this.preparations = new CorrectionPreparations(database, {
      taskId: (kind, input) => {
        this.executor();
        if (kind === "PREVIEW") return correctionTask(database, correctionActions["corrections.preview"].input.parse(input).taskId).id;
        const preview = this.getPreview(correctionActions["corrections.confirm"].input.parse(input).previewId);
        if (preview.state === "EXPIRED") throw correctionConflict("修正预览已过期，请重新预览后确认"); return preview.taskId;
      },
      run: async (kind, input, signal, progress, acceptedAt) => kind === "PREVIEW"
        ? { previewId: (await this.preview(correctionActions["corrections.preview"].input.parse(input), signal, progress)).id }
        : { operationId: (await this.confirm(correctionActions["corrections.confirm"].input.parse(input), signal, progress, acceptedAt)).id },
      recover: (kind, input) => {
        if (kind === "PREVIEW") {
          const parsed = correctionActions["corrections.preview"].input.parse(input), row = database.connection.prepare("SELECT id,input_hash FROM media_correction_preview WHERE request_key=?").get(parsed.requestKey) as { id: string; input_hash: string } | undefined;
          return row?.input_hash === correctionHash(parsed) ? { previewId: row.id } : null;
        }
        const parsed = correctionActions["corrections.confirm"].input.parse(input), row = database.connection.prepare("SELECT operation_id FROM media_correction_confirmation WHERE request_key=? AND preview_id=?").get(parsed.requestKey, parsed.previewId) as { operation_id: string } | undefined;
        return row ? { operationId: row.operation_id } : null;
      },
    }, now);
    this.batches = new CorrectionBatches(database, {
      available: () => { this.executor(); },
      preview: (input, signal, progress) => this.preview(input, signal, progress),
      previewMappings: (ids) => this.checkBatchMappings(ids),
      confirm: (...args) => this.acceptBatch(...args),
      operation: (id) => this.dto(this.row(id)),
    }, now);
  }
  preparePreview(input: CoreInput<"corrections.preview">) { this.writable(); return this.preparations.enqueue("PREVIEW", correctionActions["corrections.preview"].input.parse(input)); }
  prepareConfirmation(input: CoreInput<"corrections.confirm">) { this.writable(); return this.preparations.enqueue("CONFIRM", correctionActions["corrections.confirm"].input.parse(input)); }
  private writable() { if (this.closed) throw new DesktopError("INTERRUPTED", "修正服务正在停止，请查询原作业后重试", true); }
  private executor() { this.writable(); if (!this.files) throw new DesktopError("COMPONENT_UNAVAILABLE", "安全修正文件组件不可用，请使用组件完整且匹配当前架构的客户端"); return this.files; }
  private active(taskId: string) { return this.database.connection.prepare(operationQuery + " WHERE (o.original_task_id=? OR o.new_task_id=?) AND (o.phase!='RECORDED' OR EXISTS(SELECT 1 FROM app_setting s WHERE s.key='correction.restore.audit.'||o.id))").get(taskId, taskId) as OperationRow | undefined; }
  private storedFiles(id: string) { return this.database.connection.prepare("SELECT * FROM media_file_relocation WHERE item_id=? ORDER BY ordinal,id").all(id) as RelocationRow[]; }
  private row(id: string) { const row = this.database.connection.prepare(operationQuery + " WHERE o.id=?").get(id) as OperationRow | undefined; if (!row) throw correctionConflict("修正作业不存在，请刷新作业列表"); return row; }
  private target(id: string, original?: CorrectionPlan["target"]) {
    const stored = this.database.connection.prepare("SELECT grant_json,available FROM media_target_root WHERE id=?").get(id) as { grant_json: string; available: number } | undefined;
    if (!stored?.available) throw new DesktopError("LOCAL_UNAVAILABLE", "修正媒体目标尚未恢复授权，请连接原磁盘并核对目录", true);
    const grant = managedRootGrantSchema.parse(JSON.parse(stored.grant_json)), root = this.ingestion.targets.get(id);
    if (root.grant.path !== grant.path || !sameVolumeRoot(root.grant.volume, grant.volume) || original && (original.path !== grant.path || !sameVolumeRoot(original.volume, grant.volume))) throw new DesktopError("LOCAL_UNAVAILABLE", "修正媒体目标的原磁盘或目录已变化，请恢复原授权后重试", true); return root;
  }
  describe(input: CoreInput<"corrections.task">): CoreOutput<"corrections.task"> {
    const task = correctionTask(this.database, input.taskId), active = this.active(task.id), selected = task.confirmed_json ? selectionSchema.safeParse(JSON.parse(task.confirmed_json)) : null;
    const latest = this.database.connection.prepare(operationQuery + " WHERE o.original_task_id=? OR o.new_task_id=? ORDER BY (o.original_task_id=?) DESC,o.created_at DESC,o.id DESC LIMIT 1").get(task.id, task.id, task.id) as OperationRow | undefined;
    return { taskId: task.id, status: task.status, targetPath: task.target_path, selection: selected?.success ? selected.data : null, previousTaskId: task.corrected_from_id, nextTaskId: task.corrected_to_id, active: active ? this.dto(active) : null, latestOperation: latest ? this.dto(latest) : null, preparation: this.preparations.forTask(task.id), targets: (this.database.connection.prepare("SELECT id,grant_json,available FROM media_target_root ORDER BY id").all() as { id: string; grant_json: string; available: number }[]).map((row) => ({ id: row.id, path: managedRootGrantSchema.parse(JSON.parse(row.grant_json)).path, available: !!row.available })), available: !!this.files };
  }
  private dto(row: OperationRow): CorrectionOperation {
    const files = this.storedFiles(row.id);
    const plan = JSON.parse(row.plan_json) as CorrectionPlan, verificationPending = !!this.database.connection.prepare("SELECT 1 FROM app_setting WHERE key=?").get("correction.restore.audit." + row.id);
    return { id: row.id, jobId: row.job_id, originalTaskId: row.original_task_id, newTaskId: row.new_task_id, state: row.phase, title: plan.metadata.title, total: files.length, done: files.filter((file) => file.phase === "DONE").length, failed: files.filter((file) => file.phase === "NEEDS_ATTENTION").length, waitingReason: verificationPending ? "恢复备份后正在核对媒体目标，请等待原卷授权和文件核验；不会重做已记账文件" : !this.files && row.phase !== "RECORDED" ? "安全修正文件组件不可用，请使用匹配当前架构且组件完整的客户端恢复原作业" : this.ingestion.pauseStatus().paused && row.phase !== "RECORDED" ? "全局整理已暂停，恢复后继续原修正计划" : files.find((file) => file.waiting_reason)?.waiting_reason ?? null, failure: row.failure, cleanupPending: !!row.cleanup_pending, verificationPending, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list(input: CoreInput<"corrections.list">): CoreOutput<"corrections.list"> { const total = (this.database.connection.prepare("SELECT count(*) AS n FROM media_correction_operation").get() as { n: number }).n, rows = this.database.connection.prepare(operationQuery + " ORDER BY o.created_at DESC,o.id LIMIT 25 OFFSET ?").all(((input.page ?? 1) - 1) * 25) as OperationRow[]; return { total, items: rows.map((row) => this.dto(row)) }; }
  private assetDto(asset: CorrectionAsset, state?: RelocationRow) { return { id: asset.id, kind: asset.kind, fromPath: join(asset.from.grant.path, ...asset.from.segments), toPath: join(asset.to.grant.path, ...asset.to.segments), recoveryPath: state && asset.action !== "NONE" && asset.action !== "KEEP" ? join(asset.from.grant.path, ".media-marshal", "relocations", asset.id, "source") : null, stagingPath: state?.attempt_id && asset.action === "COPY" ? join(asset.to.grant.path, ".media-marshal", "staging", state.attempt_id, ...asset.to.segments) : null, size: asset.expected?.size ?? 0, action: asset.action, phase: state?.phase ?? null, reason: state?.failure ?? state?.waiting_reason ?? asset.reason }; }
  details(input: CoreInput<"corrections.get">): CoreOutput<"corrections.get"> { const row = this.row(input.id), plan = JSON.parse(row.plan_json) as CorrectionPlan, files = new Map(this.storedFiles(row.id).map((file) => [file.id, file])); return { operation: this.dto(row), warnings: plan.warnings, files: plan.files.map((asset) => this.assetDto(asset, files.get(asset.id))) }; }
  getPreview(id: string): CoreOutput<"corrections.get-preview"> {
    const row = this.database.connection.prepare("SELECT * FROM media_correction_preview WHERE id=?").get(id) as PreviewRow | undefined; if (!row) throw correctionConflict("修正预览不存在，请重新预览");
    const plan = JSON.parse(row.plan_json) as CorrectionPlan; return { id: row.id, taskId: row.task_id, title: plan.metadata.title, selection: plan.selection, targetId: plan.target.id, targetPath: join(plan.target.path, ...plan.targetSegments), template: plan.template ?? null, includeAccessories: plan.includeAccessories, expiresAt: row.expires_at, state: row.operation_id ? "CONFIRMED" : row.expires_at <= this.now() || plan.previewGeneration !== this.previewGeneration ? "EXPIRED" : "READY", operationId: row.operation_id, files: plan.files.map((asset) => this.assetDto(asset)), warnings: plan.warnings };
  }
  async preview(input: CoreInput<"corrections.preview">, signal?: AbortSignal, progress?: (value: PreparationProgress) => void): Promise<CoreOutput<"corrections.get-preview">> {
    signal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]); signal.throwIfAborted();
    input = correctionActions["corrections.preview"].input.parse(input); this.executor(); const hash = correctionHash(input), previous = this.previews.get(input.requestKey); if (previous) { if (previous.hash !== hash) throw correctionConflict("预览请求键已用于不同修正内容"); return previous.flight; }
    const flight = this.buildPreview(input, hash, signal, progress).catch((error) => { throw previewFailure(error); }).finally(() => { if (this.previews.get(input.requestKey)?.flight === flight) this.previews.delete(input.requestKey); }); this.previews.set(input.requestKey, { hash, flight }); return flight;
  }
  private async buildPreview(input: CoreInput<"corrections.preview">, hash: string, signal: AbortSignal, progress?: (value: PreparationProgress) => void) {
    const db = this.database.connection, previous = db.prepare("SELECT id,input_hash FROM media_correction_preview WHERE request_key=?").get(input.requestKey) as { id: string; input_hash: string } | undefined;
    if (previous) { if (previous.input_hash !== hash) throw correctionConflict("预览请求键已用于不同修正内容"); return this.getPreview(previous.id); }
    return this.ingestion.withCorrectionLease(input.taskId, async () => {
      if (this.active(input.taskId)) throw correctionConflict("此文件已有活动修正，请查看原作业，不重复创建计划");
      const receipt = correctionReceipt(this.database, this.ingestion.targets, input.taskId), connectionVersion = this.connections.version, target = this.target(input.targetId ?? receipt.root.grant.id), selection = selectionSchema.parse(input.selection);
      const metadata = await this.connections.tmdb.detail(selection.tmdbId, selection.mediaType, signal); let episodeTitle: string | null = null;
      if (selection.mediaType === "TV_SHOW") { if (selection.season === null || selection.episode === null) throw correctionConflict("剧集修正需要明确季号和集号"); const checked = await reconcileEpisodes({ season: selection.season, episode: selection.episode, episodeEnd: selection.episodeEnd }, metadata.seasons, (season) => this.connections.tmdb.episodes(selection.tmdbId, season, signal)); Object.assign(selection, { season: checked.season, episode: checked.episode, episodeEnd: checked.episodeEnd }); episodeTitle = checked.episodeTitle; } else Object.assign(selection, { season: null, episode: null, episodeEnd: null });
      assertMediaCoordinates(this.database, selection, input.taskId, receipt.plan.targetSegments.at(-1)!);
      const parsed = receipt.plan.parsed, variables = { title: metadata.title, original_title: metadata.originalTitle, year: metadata.year, tmdb_id: metadata.tmdbId, media_type: metadata.mediaType, season: selection.season, episode: selection.episode === null ? null : { start: selection.episode, end: selection.episodeEnd }, episode_title: episodeTitle, title_initial: titleInitial(metadata.title), genre_1: metadata.genres?.[0] ?? null, genre_2: metadata.genres?.[1] ?? null, genre_3: metadata.genres?.[2] ?? null, genre_4: metadata.genres?.[3] ?? null, country: metadata.country ?? null, resolution: parsed.screenSize, codec: parsed.videoCodec, release_group: parsed.releaseGroup, ext: extname(receipt.plan.targetSegments.at(-1)!).slice(1) };
      const template = input.template ?? (selection.mediaType === "MOVIE" ? "{title}[[ ({year})]] [tmdb-{tmdb_id}]/{title}[[ ({year})]].{ext}" : "{title} [tmdb-{tmdb_id}]/Season {season:02d}/{title} - S{season:02d}E{episode:02d}.{ext}"), segments = templatePath(template, variables, process.platform === "win32" ? "win32" : "darwin"); target.segments(segments);
      const assets = await collectCorrectionAssets(receipt, target, segments, input.includeAccessories !== false, signal, progress), plan: CorrectionPlan = { taskId: input.taskId, originalContext: receipt.context, previewGeneration: this.previewGeneration, connectionVersion, target: target.grant, targetSegments: segments, template, selection, metadata, parsed, includeAccessories: input.includeAccessories !== false, ...assets };
      await this.checkFiles(plan, target); signal.throwIfAborted(); this.checkContext(plan); const id = randomUUID(); db.prepare("INSERT INTO media_correction_preview(id,request_key,task_id,input_hash,plan_json,expires_at) VALUES(?,?,?,?,?,?)").run(id, input.requestKey, input.taskId, hash, JSON.stringify(plan), this.now() + 600000); return this.getPreview(id);
    });
  }
  private checkContext(plan: CorrectionPlan) { this.writable(); if (plan.previewGeneration !== this.previewGeneration || this.connections.version !== plan.connectionVersion || correctionReceipt(this.database, this.ingestion.targets, plan.taskId).context !== plan.originalContext) throw correctionConflict("任务、文件收据、连接或核心已变化，请重新预览修正"); assertMediaCoordinates(this.database, plan.selection, plan.taskId, plan.files[0]!.from.segments.at(-1)!); }
  private async checkFiles(plan: CorrectionPlan, target: ManagedRoot) {
    let bytes = 0;
    for (const file of plan.files) {
      if (file.action === "KEEP") continue; assertCorrectionTarget(this.database, target, file.to.segments, plan.taskId);
      const alias = file.from.grant.id === file.to.grant.id && target.slotKey(file.from.segments) === target.slotKey(file.to.segments);
      if (file.action !== "NONE" && !alias) await target.assertVacant(file.to.segments); if (file.action === "COPY") bytes += file.expected!.size;
    }
    const reserved = (this.database.connection.prepare("SELECT plan_json FROM media_file_relocation WHERE to_root_id=? AND recorded=0 AND phase IN ('PENDING','COPYING')").all(target.grant.id) as { plan_json: string }[]).reduce((total, row) => { const plan = JSON.parse(row.plan_json); return total + (plan.mode === "COPY" ? plan.expected.size : 0); }, 0); assertSpaceBudget(await target.check(), bytes, reserved);
  }
  private bindConfirmation(requestKey: string, previewId: string, operationId: string) { this.database.connection.prepare("INSERT INTO media_correction_confirmation VALUES(?,?,?)").run(requestKey, previewId, operationId); return this.dto(this.row(operationId)); }
  private previewRow(id: string, ownerBatchId?: string) {
    const db = this.database.connection, receipt = db.prepare("SELECT * FROM media_correction_preview WHERE id=?").get(id) as PreviewRow | undefined;
    if (!receipt) throw correctionConflict("修正预览不存在，请重新预览");
    const owner = db.prepare("SELECT batch_id FROM media_correction_batch_member WHERE preview_key=?").get(receipt.request_key) as { batch_id: string } | undefined;
    if (owner && owner.batch_id !== ownerBatchId) throw correctionConflict("此预览属于批量修正，请从原批次确认完整范围"); return receipt;
  }
  private async validateConfirmation(receipt: PreviewRow, acceptedAt: number, signal: AbortSignal, progress?: (value: PreparationProgress) => void) {
    const plan = JSON.parse(receipt.plan_json) as CorrectionPlan;
    if (receipt.operation_id || receipt.expires_at <= acceptedAt || this.active(plan.taskId)) throw correctionConflict("预览已过期或此文件已有活动修正，请查看原作业或重新预览"); this.checkContext(plan);
    const source = correctionReceipt(this.database, this.ingestion.targets, plan.taskId), target = this.target(plan.target.id, plan.target), current = await collectCorrectionAssets(source, target, plan.targetSegments, plan.includeAccessories, signal, progress);
    if (correctionManifest(current.files) !== correctionManifest(plan.files)) throw correctionConflict("主视频或附属文件范围、内容已经变化，请重新预览并确认完整文件清单"); await this.checkFiles(plan, target); signal.throwIfAborted();
    return { receipt, plan, source, target };
  }
  private commitConfirmation(value: Awaited<ReturnType<Corrections["validateConfirmation"]>>, requestKey: string, acceptedAt: number) {
    const { receipt, plan, source, target } = value, executor = this.executor(), db = this.database.connection;
    this.checkContext(plan); if (receipt.expires_at <= acceptedAt || this.active(plan.taskId)) throw correctionConflict("修正预览已过期或任务已有计划，请重新读取"); for (const file of plan.files) if (file.action !== "KEEP") assertCorrectionTarget(this.database, target, file.to.segments, plan.taskId);
    const id = randomUUID(), jobId = randomUUID(), newTask = randomUUID(), time = timestamp(this.now);
    db.prepare("INSERT INTO desktop_job VALUES(?,'correction','PLANNED',?,?)").run(jobId, receipt.plan_json, time); db.prepare("INSERT INTO correction_item VALUES(?,?,?,'PENDING',?)").run(id, jobId, plan.taskId, receipt.plan_json);
    db.prepare("INSERT INTO media_task(id,source_id,source_path,title,status,parsed_json,metadata_json,confirmed_json,corrected_from_id,created_at,updated_at) VALUES(?,?,?,?,'PROCESSING',?,?,?,?,?,?)").run(newTask, source.task.source_id, source.task.source_path, plan.metadata.title, JSON.stringify(plan.parsed), JSON.stringify(plan.metadata), JSON.stringify(plan.selection), plan.taskId, time, time);
    db.prepare("INSERT INTO media_correction_operation(id,preview_id,request_key,original_task_id,new_task_id,target_root_id,target_slot,plan_json,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'PLANNED',?,?)").run(id, receipt.id, requestKey, plan.taskId, newTask, plan.target.id, "pending:" + id, receipt.plan_json, time, time);
    for (const [ordinal, file] of plan.files.entries()) if (file.action !== "KEEP") executor.plan({ id: file.id, itemId: id, ordinal, from: file.from, to: file.to, expected: file.expected! });
    db.prepare("UPDATE media_correction_preview SET operation_id=? WHERE id=?").run(id, receipt.id); return this.bindConfirmation(requestKey, receipt.id, id);
  }
  async confirm(input: CoreInput<"corrections.confirm">, signal?: AbortSignal, progress?: (value: PreparationProgress) => void, acceptedAt = this.now()): Promise<CorrectionOperation> {
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]); combined.throwIfAborted(); input = correctionActions["corrections.confirm"].input.parse(input); this.executor();
    const db = this.database.connection, receipt = this.previewRow(input.previewId), prior = db.prepare("SELECT preview_id,operation_id FROM media_correction_confirmation WHERE request_key=?").get(input.requestKey) as { preview_id: string; operation_id: string } | undefined;
    if (prior) { if (prior.preview_id !== input.previewId) throw correctionConflict("确认请求键已用于另一个预览"); return this.dto(this.row(prior.operation_id)); }
    if (receipt.operation_id) return this.bindConfirmation(input.requestKey, receipt.id, receipt.operation_id);
    return this.ingestion.withCorrectionLease(receipt.task_id, async () => {
      const value = await this.validateConfirmation(receipt, acceptedAt, combined, progress), result = db.transaction(() => this.commitConfirmation(value, input.requestKey, acceptedAt))();
      if (this.timer) void this.tick().catch(() => {}); return result;
    });
  }
  private checkBatchMappings(previewIds: string[]) {
    const roots = new Map<string, { root: ManagedRoot; paths: string[][]; copyBytes: number }>(), plans: CorrectionPlan[] = [];
    for (const id of previewIds) {
      const row = this.database.connection.prepare("SELECT plan_json FROM media_correction_preview WHERE id=?").get(id) as { plan_json: string } | undefined; if (!row) throw correctionConflict("批量成员缺少预览，请重新核验完整范围");
      const plan = JSON.parse(row.plan_json) as CorrectionPlan, value = roots.get(plan.target.id) ?? { root: this.target(plan.target.id, plan.target), paths: [], copyBytes: 0 };
      plans.push(plan); for (const file of plan.files) if (file.action !== "KEEP") { value.paths.push(file.to.segments); if (file.action === "COPY") value.copyBytes += file.expected!.size; } roots.set(plan.target.id, value);
    }
    // 不同旧季在真实分集映射后可能落到同一坐标，即使扩展名不同也必须在预览时阻断。
    const episodes = plans.filter((plan) => plan.selection.mediaType === "TV_SHOW").sort((a, b) => a.selection.tmdbId - b.selection.tmdbId || a.selection.season! - b.selection.season! || a.selection.episode! - b.selection.episode!);
    for (let index = 1; index < episodes.length; index++) {
      const a = episodes[index - 1]!, b = episodes[index]!;
      try { assertUniqueEpisodes([a, b].map(({ selection }) => ({ tmdbId: selection.tmdbId, season: selection.season!, episode: selection.episode!, episodeEnd: selection.episodeEnd }))); }
      catch { throw correctionConflict(`批量成员「${a.files[0]!.from.segments.join("/").slice(-120)}」与「${b.files[0]!.from.segments.join("/").slice(-120)}」修正后存在重复或重叠季集：TMDB ${b.selection.tmdbId} S${b.selection.season} E${b.selection.episode}；请核对季集或排除冲突成员后重新预览`); }
    }
    for (const { root, paths } of roots.values()) try { root.assertMappings(paths); } catch {
      // 只在冲突分支定位首对对象，避免把整个批次路径塞入错误或日志。
      let pair = paths.slice(0, 2);
      outer: for (let a = 0; a < paths.length; a++) for (let b = a + 1; b < paths.length; b++) {
        const x = root.mappingIdentity(paths[a]!), y = root.mappingIdentity(paths[b]!), depth = Math.min(x.length, y.length);
        for (let index = 0; index < depth && x[index] === y[index]; index++) if (index === depth - 1 || paths[a]![index] !== paths[b]![index]) { pair = [paths[a]!, paths[b]!]; break outer; }
      }
      throw correctionConflict(`批量成员的目标路径重复、大小写冲突或互相包含：${pair.map((path) => `「${join(root.grant.path, ...path).slice(-140)}」`).join("与")}；请修改模板或排除对应成员后重新预览`);
    }
    return roots;
  }
  private async acceptBatch(id: string, members: BatchConfirmationMember[], acceptedAt: number, signal: AbortSignal, progress: (taskId: string, value: PreparationProgress) => void, guard: () => void, record: (operations: CorrectionOperation[]) => void) {
    const combined = AbortSignal.any([this.lifetime.signal, signal]);
    await this.ingestion.withCorrectionLeases(members.map((member) => member.taskId), async () => {
      const values: Awaited<ReturnType<Corrections["validateConfirmation"]>>[] = [];
      for (const member of members) {
        guard(); const receipt = this.previewRow(member.previewId, id); if (receipt.task_id !== member.taskId) throw correctionConflict("批次预览与成员不符，请重新预览完整范围");
        try { values.push(await this.validateConfirmation(receipt, acceptedAt, combined, (value) => progress(member.taskId, value))); }
        catch (error) {
          if (combined.aborted || this.closed) throw error;
          const failure = publicError(previewFailure(error)), plan = JSON.parse(receipt.plan_json) as CorrectionPlan, message = `成员「${plan.files[0]!.from.segments.join("/").slice(-120)}」复核失败：${failure.message.slice(0, 340)}`, result = new DesktopError(failure.code, message, failure.retryable);
          this.database.connection.prepare("UPDATE media_correction_batch_member SET failure_json=? WHERE batch_id=? AND task_id=? AND EXISTS(SELECT 1 FROM media_correction_batch WHERE id=? AND state='CONFIRMING')").run(JSON.stringify({ code: failure.code, message, retryable: failure.retryable }), id, member.taskId, id); throw result;
        }
      }
      const roots = this.checkBatchMappings(members.map((member) => member.previewId));
      for (const { root, copyBytes } of roots.values()) {
        const reserved = (this.database.connection.prepare("SELECT plan_json FROM media_file_relocation WHERE to_root_id=? AND recorded=0 AND phase IN ('PENDING','COPYING')").all(root.grant.id) as { plan_json: string }[]).reduce((sum, row) => { const plan = JSON.parse(row.plan_json); return sum + (plan.mode === "COPY" ? plan.expected.size : 0); }, 0);
        assertSpaceBudget(await root.check(), copyBytes, reserved);
      }
      guard(); combined.throwIfAborted();
      // 这里只原子登记全部执行意图；文件系统仍由逐项日志恢复，不是整批事务。
      this.database.connection.transaction(() => { guard(); const operations = values.map((value, index) => this.commitConfirmation(value, members[index]!.confirmKey, acceptedAt)); record(operations); })();
    });
  }
  retry(input: CoreInput<"corrections.retry">) { this.writable(); const row = this.row(input.id), db = this.database.connection; if (row.phase === "RECORDED") { db.prepare("UPDATE app_setting SET value='0' WHERE key=?").run("correction.restore.audit." + row.id); db.prepare("UPDATE media_correction_operation SET cleanup_due=0 WHERE id=?").run(row.id); if (this.timer) void this.tick().catch(() => {}); return this.dto(row); } const executor = this.executor(); for (const file of executor.list(row.id)) executor.retry(file.id); db.transaction(() => { db.prepare("UPDATE media_correction_operation SET phase='RUNNING',failure=NULL,updated_at=? WHERE id=?").run(timestamp(this.now), row.id); db.prepare("UPDATE correction_item SET state='RUNNING' WHERE id=?").run(row.id); db.prepare("UPDATE media_task SET status='PROCESSING',updated_at=? WHERE id=?").run(timestamp(this.now), row.new_task_id); db.prepare("UPDATE desktop_job SET state='RUNNING',updated_at=? WHERE id=?").run(timestamp(this.now), row.job_id); })(); if (this.timer) void this.tick().catch(() => {}); return this.dto(this.row(row.id)); }
  start() { if (!this.closed && !this.timer) { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 10000); void this.tick().catch(() => {}); } }
  interrupt() { this.files?.interrupt(); }
  tick(): Promise<void> { if (this.closed) return Promise.resolve(); return this.flight ??= this.run().finally(() => { this.flight = undefined; }); }
  reconcileRestored() { const db = this.database.connection; db.transaction(() => { db.prepare("INSERT OR IGNORE INTO app_setting(key,value) SELECT 'correction.restore.audit.'||o.id,'0' FROM media_correction_operation o JOIN media_task t ON t.id=o.new_task_id WHERE o.phase='RECORDED' AND t.status='DONE' AND NOT EXISTS(SELECT 1 FROM correction_item ci WHERE ci.task_id=t.id AND ci.state IN ('PENDING','RUNNING','NEEDS_ATTENTION'))").run(); db.prepare("UPDATE media_task SET status='PROCESSING',delivery_status='NOT_READY',updated_at=? WHERE id IN (SELECT o.new_task_id FROM media_correction_operation o JOIN app_setting s ON s.key='correction.restore.audit.'||o.id) AND status='DONE'").run(timestamp(this.now)); })(); }
  private async auditRestored() {
    const db = this.database.connection, rows = db.prepare(operationQuery + " JOIN app_setting s ON s.key='correction.restore.audit.'||o.id WHERE o.phase='RECORDED' AND CAST(s.value AS INTEGER)<=? ORDER BY CAST(s.value AS INTEGER),o.id LIMIT 4").all(this.now()) as OperationRow[];
    for (const row of rows) {
      if (this.closed) return;
      const task = correctionTask(this.database, row.new_task_id); if (task.status === "CORRECTED" || db.prepare("SELECT 1 FROM correction_item WHERE task_id=? AND state IN ('PENDING','RUNNING','NEEDS_ATTENTION')").get(row.new_task_id)) { db.prepare("DELETE FROM app_setting WHERE key=?").run("correction.restore.audit." + row.id); continue; }
      try {
        const confirmed = JSON.parse(row.plan_json) as CorrectionPlan, files = this.storedFiles(row.id), expectedIds = new Set(confirmed.files.filter((file) => file.action !== "KEEP").map((file) => file.id));
        if (files.length !== expectedIds.size || files.some((file) => !expectedIds.has(file.id))) throw correctionConflict("恢复后的文件日志与确认清单不符");
        for (const file of files) { const plan = JSON.parse(file.plan_json), root = this.target(plan.to.grant.id, plan.to.grant), expected = localFileEvidenceSchema.parse(JSON.parse(file.evidence_json!)), actual = (await root.inspectForRelocation(plan.to.segments, this.lifetime.signal)).evidence; if (correctionHash(actual) !== correctionHash(expected)) throw correctionConflict("恢复后目标证据不符"); }
        if (this.closed) return; db.transaction(() => { db.prepare("UPDATE media_task SET status='DONE',delivery_status='REFRESH_PENDING',updated_at=? WHERE id=? AND status!='CORRECTED'").run(timestamp(this.now), row.new_task_id); db.prepare("UPDATE media_correction_operation SET failure=NULL WHERE id=?").run(row.id); db.prepare("UPDATE emby_delivery SET state='REFRESH_PENDING',next_attempt_at=max(next_attempt_at,?),check_started_at=NULL,emby_item_id=NULL,updated_at=? WHERE task_id=?").run(this.now() + 30000, timestamp(this.now), row.new_task_id); db.prepare("DELETE FROM app_setting WHERE key=?").run("correction.restore.audit." + row.id); })();
      } catch (error) {
        if (this.closed) return; const unavailable = ["LOCAL_UNAVAILABLE", "EACCES", "EPERM", "EROFS", "EIO", "ENODEV", "ENXIO", "ESTALE"].includes((error as { code?: string }).code ?? ""), failure = unavailable ? "恢复备份后原媒体目标暂不可用，请恢复原卷与权限；不会重做修正文件操作" : "恢复备份后媒体目标证据不符，现存文件已保留；请核对原文件与任务收据，恢复匹配文件或一致备份后重试，不读取下载来源";
        db.transaction(() => { db.prepare("UPDATE media_correction_operation SET failure=? WHERE id=?").run(failure, row.id); db.prepare("UPDATE media_task SET status=?,delivery_status='NEEDS_ATTENTION',updated_at=? WHERE id=? AND status!='CORRECTED'").run(unavailable ? "PROCESSING" : "FAILED", timestamp(this.now), row.new_task_id); db.prepare("UPDATE emby_delivery SET state='NEEDS_ATTENTION',last_failure='TARGET_CHANGED',emby_item_id=NULL,updated_at=? WHERE task_id=?").run(timestamp(this.now), row.new_task_id); db.prepare("UPDATE app_setting SET value=? WHERE key=?").run(String(this.now() + 30000), "correction.restore.audit." + row.id); })();
      }
    }
  }
  private async run() {
    const db = this.database.connection;
    void this.batches.tick().catch(() => {}); await this.auditRestored(); if (!this.files || this.closed) return;
    if (!this.ingestion.pauseStatus().paused) for (const row of db.prepare(operationQuery + " WHERE o.phase IN ('PLANNED','RUNNING') ORDER BY o.created_at,o.id LIMIT 4").all() as OperationRow[]) {
      if (this.closed) break; try {
        db.prepare("UPDATE desktop_job SET state='RUNNING',updated_at=? WHERE id=?").run(timestamp(this.now), row.job_id); db.prepare("UPDATE correction_item SET state='RUNNING' WHERE id=?").run(row.id); db.prepare("UPDATE media_correction_operation SET phase='RUNNING',updated_at=? WHERE id=?").run(timestamp(this.now), row.id);
        for (const file of this.files!.list(row.id).filter((file) => file.phase !== "DONE").slice(0, 4)) { if (this.closed || this.ingestion.pauseStatus().paused) break; await this.files!.run(file.id); }
        const files = this.files!.list(row.id); if (files.some((file) => file.phase === "NEEDS_ATTENTION")) throw correctionConflict("修正存在文件冲突，请展开逐项结果，修复原位置或目标后重试原作业");
        if (files.every((file) => file.phase === "DONE")) await this.record(row);
      } catch { if (this.closed) break; const files = this.storedFiles(row.id), failed = files.find((file) => file.phase === "NEEDS_ATTENTION"), failure = failed?.failure ?? (files.length && files.every((file) => file.phase === "DONE") ? "文件已完成，历史记账尚未成功；现存文件已保留，重试会核对现有文件并补记历史与交付意图" : "修正尚未完成，现存文件已保留；请查看逐项原因，修复原位置或目标后重试原作业"); db.transaction(() => { db.prepare("UPDATE media_correction_operation SET phase='NEEDS_ATTENTION',failure=?,updated_at=? WHERE id=?").run(failure, timestamp(this.now), row.id); db.prepare("UPDATE correction_item SET state='NEEDS_ATTENTION' WHERE id=?").run(row.id); db.prepare("UPDATE media_task SET status='FAILED',updated_at=? WHERE id=?").run(timestamp(this.now), row.new_task_id); db.prepare("UPDATE desktop_job SET state='PARTIAL_FAILED',updated_at=? WHERE id=?").run(timestamp(this.now), row.job_id); })(); }
    }
    for (const row of db.prepare(operationQuery + " WHERE o.phase='RECORDED' AND o.cleanup_pending=1 AND o.cleanup_due<=? AND NOT EXISTS(SELECT 1 FROM app_setting s WHERE s.key='correction.restore.audit.'||o.id) ORDER BY o.updated_at,o.id LIMIT 4").all(this.now()) as OperationRow[]) {
      if (this.closed) break; try { for (const file of this.files!.list(row.id)) await this.files!.cleanupRecorded(file.id, this.lifetime.signal); db.prepare("UPDATE media_correction_operation SET cleanup_pending=0,failure=NULL WHERE id=?").run(row.id); }
      catch { if (this.closed) break; db.prepare("UPDATE media_correction_operation SET cleanup_due=?,failure='媒体与历史已完成，私有暂存尚未回收；请恢复原目标和权限，现存文件已保留' WHERE id=?").run(this.now() + 30000, row.id); }
    }
  }
  private async record(row: OperationRow) {
    const executor = this.files!, plan = JSON.parse(row.plan_json) as CorrectionPlan, expectedIds = new Set(plan.files.filter((file) => file.action !== "KEEP").map((file) => file.id)), stored = executor.list(row.id);
    if (stored.length !== expectedIds.size || stored.some((file) => !expectedIds.has(file.id))) throw correctionConflict("修正文件日志与已确认的完整清单不符，请保留文件并核对原作业");
    for (const file of stored) { const result = await executor.run(file.id); if (result.phase === "NEEDS_ATTENTION") throw correctionConflict("文件证据已变化，请核对逐项结果后重试原作业"); if (result.phase !== "DONE") return; }
    const main = executor.get(plan.files[0]!.id), evidence = localFileEvidenceSchema.parse(JSON.parse(main.evidence_json!)), db = this.database.connection, time = timestamp(this.now);
    db.transaction(() => {
      const current = this.row(row.id); if (current.phase === "RECORDED") return; const task = correctionTask(this.database, row.original_task_id); if (task.status !== "DONE" || task.corrected_to_id) throw correctionConflict("原任务历史已变化，保留现存文件并等待核对");
      if (executor.list(row.id).some((file) => file.phase !== "DONE")) throw correctionConflict("修正文件尚未全部完成，不能提交历史");
      db.prepare("UPDATE media_task SET status='CORRECTED',corrected_to_id=?,updated_at=? WHERE id=?").run(row.new_task_id, time, row.original_task_id); db.prepare("UPDATE media_task SET status='DONE',target_path=?,delivery_status='REFRESH_PENDING',updated_at=? WHERE id=?").run(join(plan.target.path, ...plan.targetSegments), time, row.new_task_id);
      db.prepare("UPDATE ingestion_operation SET target_slot='history:'||id WHERE task_id=?").run(row.original_task_id); db.prepare("UPDATE media_correction_operation SET target_slot='history:'||id WHERE new_task_id=?").run(row.original_task_id);
      db.prepare("UPDATE media_correction_operation SET phase='RECORDED',target_slot=?,evidence_json=?,failure=NULL,updated_at=? WHERE id=?").run(this.ingestion.targets.get(plan.target.id).slotKey(plan.targetSegments), JSON.stringify(evidence), time, row.id); db.prepare("UPDATE correction_item SET state='RECORDED' WHERE id=?").run(row.id); executor.releaseRecorded(row.id); db.prepare("UPDATE desktop_job SET state='DONE',updated_at=? WHERE id=?").run(time, row.job_id);
      const connection = db.prepare("SELECT id,version FROM emby_connection ORDER BY verified_at DESC,id LIMIT 1").get() as { id: string; version: number } | undefined;
      db.prepare("INSERT INTO emby_delivery(task_id,correction_id,connection_id,connection_version,state,next_attempt_at,updated_at) VALUES(?,?,?,?,'REFRESH_PENDING',?,?)").run(row.new_task_id, row.id, connection?.id ?? null, connection?.version ?? null, this.now() + 30000, time);
    })();
  }
  async close() { this.closed = true; this.lifetime.abort(); clearInterval(this.timer); this.interrupt(); await this.batches.close(); await this.preparations.close(); await Promise.allSettled([...this.previews.values()].map((value) => value.flight)); await this.flight?.catch(() => {}); await this.files?.close(); }
}
