import type { ScanResult } from "../sources/scans.js";
import { createHash, randomUUID } from "node:crypto";
import { access, open } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { constants, watch, type FSWatcher } from "node:fs";
import { DesktopError, sourceConfigurationSchema, type CoreInput, type CoreOutput, type LocalDirectoryHealth, type SourceConfiguration, type RecognitionRuleSnapshot, type EmbyTargetBinding } from "@media-marshal/contracts";
import type { ConfigurationDirectories } from "../sources/configuration-directories.js";
import { recognitionOwner, recognitionSnapshot, recognitionRoute, recognitionCandidateContext, recognitionEmbyBinding } from "./recognition-routing.js";
import { localFileEvidenceSchema, managedRootGrantSchema, type LocalFileEvidence, type ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { PrivateCoreInput, PrivateCoreOutput } from "@media-marshal/contracts/internal/core";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { NameParser } from "../infrastructure/parser-process.js";
import { SourceRoot, sameSnapshot, sourceSnapshotSchema, sourceVersion, type SourceSnapshot } from "../files/source-root.js";
import { ManagedRoot, ManagedRoots, pathsOverlap, sameVolumeRoot, assertSpaceBudget } from "../files/index.js";
import type { ManagedIngestionSink } from "../cloud/outbox.js";
import type { MediaConnections } from "../application/media-connections.js";
import { mergeParentEvidence, parentContext, searchMatches, type MediaMatch, type MetadataWork } from "../domain/matching.js";
import { resolveSeason, RecognitionError, type ParsedMedia } from "../domain/media.js";
import { MediaNetworkError } from "../infrastructure/json-http.js";
import { templatePath } from "../domain/template.js";
import { titleInitial } from "../domain/title-initial.js";
import { discoveryIgnore, sampleVideos } from "../domain/discovery.js";
import { resolveManagedOrganization, type ManagedOrganization, type OrganizationConfiguration } from "../sources/organization.js";
import { ContentReviews } from "./content-reviews.js";
import { RecognitionEdits } from "./recognition-edits.js";
import { IngestionSeasons } from "./seasons.js";
import { IngestionDirectories } from "./directories.js";
import { RecognitionBatches, type BatchAvailability } from "./recognition-batches.js";
import { OrganizeBatches, type BatchManifest } from "./organize-batches.js";
import { assertMediaCoordinates } from "./coordinates.js";
import { assertCorrectionTarget } from "./correction-assets.js";
import { previewFailure } from "./preview-errors.js";
import { AutomaticIngestion } from "./automatic.js";
import { AutomaticPolicies } from "./automatic-policy.js";
import { validateMediaSelection } from "./selection-validation.js";

type Authorization = PrivateCoreInput<"media.sources.authorize">;
interface SourceRow { source_id: string; mode: "local" | "managed"; download_root_id: string | null; source_grant_json: string; target_root_id: string; source_version: number; available: number; paused: number; version: number; source_path: string; target_path: string; media_type: "AUTO" | "MOVIE" | "TV_SHOW"; policy_key?: string }
interface CandidateRow { id: string; source_id: string; relative_json: string; version_key: string; attribute_key: string; is_current: number; snapshot_json: string; expected_sha256: string | null; managed_item_id: string | null; managed_version_key: string | null; state: CoreOutput<"ingestion.candidates">["items"][number]["state"]; task_id: string | null; reason: string | null; created_at: string; updated_at: string }
interface Accessory { sourceSegments: string[]; targetSegments: string[]; snapshot: SourceSnapshot; expectedSha256: string | null }
interface Plan { recognitionSnapshot?: RecognitionRuleSnapshot; recognitionContext?: ReturnType<typeof recognitionCandidateContext>; logicalTargetId?: string; embyBinding?: EmbyTargetBinding | null; taskId: string; candidateId: string; sourceId: string; sourceVersion: number; recognitionRevision?: number; sourceLifecycles?: { id: string; revision: number }[]; connectionVersion: number; source: ManagedRootGrant; target: ManagedRootGrant; sourceSegments: string[]; targetSegments: string[]; snapshot: SourceSnapshot; expectedSha256: string | null; parsed: ParsedMedia; metadata: MetadataWork; selection: { tmdbId: number; mediaType: "MOVIE" | "TV_SHOW"; season: number | null; episode: number | null; episodeEnd: number | null }; episodeTitle: string | null; accessories?: Accessory[] }
interface PreviewRow { id: string; request_key: string; task_id: string; input_hash: string; plan_json: string; expires_at: number; operation_id: string | null }
interface OperationRow { id: string; task_id: string; candidate_id: string; target_root_id: string; plan_json: string; attempt_id: string; phase: string; evidence_json: string | null }
interface Observation { since: number; last: number; wall: number; version: string }
const sourceQuery = "SELECT i.*,s.paused,s.version,s.source_path,s.target_path,s.media_type FROM ingestion_source i JOIN desktop_source s ON s.id=i.source_id";
const timestamp = (now: () => number) => new Date(now()).toISOString();
const conflict = (message = "内容或配置已变化，请刷新并重新预览") => new DesktopError("CONFLICT", message);
function recognitionFailure(error: unknown): string {
  if (error instanceof MediaNetworkError) return {
    AUTH_REQUIRED: "TMDB 密钥无效或缺少读取权限，请在设置重新保存密钥后重试",
    RATE_LIMITED: "TMDB 请求受到限制，请稍后重试识别",
    NETWORK_UNAVAILABLE: "无法连接 TMDB，请检查网络和代理后重试识别",
    INVALID_RESPONSE: "TMDB 响应不完整或格式不受支持，请稍后重试识别",
    INTERRUPTED: "识别已停止等待，请刷新当前任务后重试",
    TIMEOUT: "TMDB 请求超时，请检查网络和代理后重试识别",
  }[error.code];
  if (error instanceof RecognitionError) return error.code === "PARSE_INVALID" ? "名称解析结果无效，请核对文件名后重试识别" : "识别或季集证据不完整，请核对后重试";
  if (error instanceof DesktopError) {
    if (error.code === "COMPONENT_UNAVAILABLE") return "离线名称解析器不可用，请重启核心后重试识别";
    if (error.code === "TIMEOUT") return "离线名称解析器超时，请重启核心后重试识别";
    if (error.code === "CONFLICT") return "文件或连接配置已变化，请刷新后重试识别";
  }
  return "识别未完成，请检查解析器、TMDB 配置或网络后重试";
}
const video = /\.(?:mkv|mp4|avi|mov|m4v|ts|m2ts|wmv|flv|webm|mpg|mpeg|rmvb)$/i;
const temporary = /(?:\.(?:part|tmp|temp|aria2|download|downloading|qkdownloading|crdownload)|\.!qB)$/i;
const unsupported = /\.(?:mp3|flac|wav|m4a|aac|ogg|iso)$/i;
const associated = /\.(?:srt|ass|ssa|sub|idx|nfo|jpg|jpeg|png|webp|md5|vtt)$/i;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
class SourceWorkInterrupted extends DesktopError {
  constructor() { super("INTERRUPTED", "所属来源已暂停或配置变化，等待恢复并重新观察", true); }
}

/** SQLite 持有所有业务事实；内存只记录本次进程的稳定观察时钟和可取消的执行。 */
export class IngestionPipeline implements ManagedIngestionSink {
  readonly targets = new ManagedRoots("direct");
  readonly contentReviews: ContentReviews;
  readonly recognitionEdits: RecognitionEdits;
  readonly directories: IngestionDirectories;
  readonly seasons: IngestionSeasons;
  readonly recognitionBatches: RecognitionBatches;
  readonly organizeBatches: OrganizeBatches;
  readonly automatic: AutomaticIngestion;
  private readonly automaticPolicies: AutomaticPolicies;
  private readonly sources = new Map<string, SourceRoot>();
  private readonly observations = new Map<string, Observation>();
  private readonly accessoryObservations = new Map<string, Observation>();
  private readonly ignorePolicies = new Map<string, { version: number; ignored: ReturnType<typeof discoveryIgnore> }>();
  private readonly correctionLeases = new Set<string>();
  private readonly activeWork = new Map<AbortController, { sourceId: string; candidateId: string }>();
  private timer?: ReturnType<typeof setInterval>; private flight?: Promise<void>; private closed = false; private controller?: AbortController;
  private configurationQueue: Promise<unknown> = Promise.resolve();
  private readonly scans = new Map<string, Promise<ScanResult>>();
  private readonly scanControllers = new Map<string, AbortController>();
  private readonly watches = new Map<string, { watcher: FSWatcher; timer?: ReturnType<typeof setTimeout> }>();
  constructor(private readonly database: CoreDatabase, private readonly parser: () => NameParser | undefined, private readonly connections: MediaConnections, private readonly now = Date.now, private readonly monotonic = () => performance.now(), private readonly watchFiles: typeof watch = watch) {
    const db = database.connection;
    this.seasons = new IngestionSeasons(database, (id) => this.describeCandidate(id), (id) => this.task(id));
    this.directories = new IngestionDirectories(database, (id) => this.describeCandidate(id), (id) => this.task(id));
    this.recognitionBatches = new RecognitionBatches(database, { capture: (id) => ({ relativePath: JSON.parse(this.candidate(id).relative_json).join("/"), context: JSON.stringify(this.recognitionContext(id)) }), availability: (id, context) => this.batchAvailability(id, context), recognize: (id, requestKey) => this.recognize({ candidateId: id, requestKey }) }, now);
    this.organizeBatches = new OrganizeBatches(database, {
      capture: (id, selection, revision) => { if (this.recognitionEdits.revision(id) !== revision) throw conflict("识别版本已变化，请重新读取任务后预览"); return { sourcePath: (db.prepare("SELECT source_path FROM media_task WHERE id=?").get(id) as { source_path: string }).source_path, context: this.organizeContext(id, selection) }; },
      check: (id, selection, context) => { if (!this.connections.installed) throw new DesktopError("LOCAL_UNAVAILABLE", "等待核心恢复服务凭据后核对批次，请稍后刷新"); if (this.organizeContext(id, selection) !== context) throw conflict("文件、来源、目标、连接或识别信息已变化，请重新预览此文件"); },
      waiting: (id) => this.organizeWaiting(id),
      available: async (id) => {
        const waiting = this.organizeWaiting(id); if (waiting) return waiting;
        const row = db.prepare(sourceQuery + " WHERE i.source_id=(SELECT source_id FROM media_task WHERE id=?)").get(id) as SourceRow | undefined, candidate = db.prepare("SELECT * FROM ingestion_candidate WHERE task_id=?").get(id) as CandidateRow;
        if (this.pauseStatus().paused || row?.paused) return "来源或全局整理已暂停，恢复后继续此批次";
        if (!row?.available || !this.sources.has(row.source_id)) return "等待原磁盘和目录授权恢复，不接管同名替代卷";
        if (!this.managedCandidateEnabled(candidate)) { const policy = candidate.managed_item_id && candidate.managed_version_key ? resolveManagedOrganization(database, candidate.managed_item_id, candidate.managed_version_key) : null; if (policy?.state === "PAUSED") return "所属整理来源已暂停，恢复后继续"; throw conflict("整理归属已经变化或待核对，请重新预览"); }
        return await this.observe(candidate) ? null : "等待文件重新稳定至少 120 秒，恢复不会跳过观察";
      },
      preview: (input) => this.preview(input), manifest: (id) => this.organizeManifest(id), confirm: (id, requestKey, batchId) => this.confirm({ previewId: id, requestKey }, batchId),
    }, now);
    this.recognitionEdits = new RecognitionEdits(database, (id) => {
      if (this.closed) throw new DesktopError("INTERRUPTED", "识别服务正在停止，请等待核心恢复");
      const candidate = this.candidate(id); this.assertCandidateCurrent(candidate);
      if (!candidate.managed_item_id && db.prepare("SELECT 1 FROM source_rule WHERE local_source_id=? AND deleted_at IS NOT NULL").get(candidate.source_id)) throw conflict("所属来源已删除，请先恢复来源再编辑识别信息");
      if (candidate.managed_item_id && candidate.managed_version_key) { const policy = resolveManagedOrganization(database, candidate.managed_item_id, candidate.managed_version_key); if (!["ENABLED", "PAUSED", "LEGACY"].includes(policy.state)) throw conflict("下载项的整理归属已变化，请先核对所属来源"); }
    }, now);
    db.prepare("UPDATE media_target_root SET available=0").run(); db.prepare("UPDATE ingestion_source SET available=0").run();
    db.prepare("UPDATE desktop_source SET health='unverified' WHERE id IN (SELECT source_id FROM ingestion_source)").run();
    this.resetObservations();
    db.prepare("UPDATE media_task SET status='PENDING' WHERE status='PROCESSING' AND id IN (SELECT task_id FROM ingestion_candidate) AND id NOT IN (SELECT task_id FROM ingestion_operation)").run();
    this.contentReviews = new ContentReviews(database, {
      check: (id, version) => this.checkContentReview(id, version),
      available: async (id) => { await this.sources.get(id)!.check(); },
      discover: async (id) => {
        const row = this.source(id), ignored = this.ignored(row), files = await this.sources.get(id)!.discover([], 10000, ignored), samples = sampleVideos(files, (name) => video.test(name));
        const known = db.prepare("SELECT relative_json FROM ingestion_candidate WHERE source_id=? AND is_current=1 AND state!='SKIPPED' LIMIT 10001").all(id) as { relative_json: string }[];
        const paths = new Map<string, string[]>();
        for (const path of [...files, ...known.map((entry) => JSON.parse(entry.relative_json) as string[])]) {
          if (!ignored(path) && video.test(path.at(-1)!) && !temporary.test(path.at(-1)!) && !samples.has(JSON.stringify(path)) && !path.some((part) => /^(?:BDMV|VIDEO_TS)$/i.test(part))) paths.set(JSON.stringify(path), path);
        }
        if (paths.size > 10000 || known.length > 10000) throw conflict("本次内容复核超过一万项，请选择更小的来源目录");
        return [...paths.values()];
      },
      prepare: (id, version, path, signal) => this.prepareContentReview(id, version, path, signal),
    }, now);
    this.automaticPolicies = new AutomaticPolicies(database);
    this.automatic = new AutomaticIngestion(database, {
      check: (id, sourceId, context) => this.automaticPolicies.check(id, sourceId, context),
      available: async (id) => {
        const row = this.candidate(id);
        if (this.closed || this.pauseStatus().paused || this.contentReviews.active(row.source_id) || !this.connections.installed) return { state: "WAITING", reason: "等待整理服务、凭据或内容复核恢复后重新观察" };
        return await this.observe(row) ? { state: "READY" } : { state: "WAITING", reason: "等待文件重新稳定至少 120 秒" };
      },
      recognize: (candidateId, requestKey) => this.recognize({ candidateId, requestKey }, requestKey),
      task: (id) => this.task(id),
      preview: (taskId, requestKey, selection) => this.withSourceWork(this.task(taskId).candidateId, this.controller?.signal ?? new AbortController().signal, (signal) => this.preview({ taskId, requestKey, selection }, signal)),
      confirm: (previewId, requestKey, check) => {
        const row = db.prepare("SELECT c.id FROM ingestion_candidate c JOIN ingestion_preview p ON p.task_id=c.task_id WHERE p.id=?").get(previewId) as { id: string };
        return this.withSourceWork(row.id, this.controller?.signal ?? new AbortController().signal, (signal) => this.confirm({ previewId, requestKey }, undefined, () => { signal.throwIfAborted(); check(); }));
      },
      receipt: (key) => { const row = db.prepare("SELECT id FROM ingestion_operation WHERE request_key=?").get(key) as { id: string } | undefined; return row ? { operationId: row.id } : null; },
    }, now);
  }
  assertRecognitionChangeSafe(ruleId: string) {
    const sources = new Set((this.database.connection.prepare("SELECT source_id FROM recognition_input WHERE rule_id=?").all(ruleId) as { source_id: string }[]).map((row) => row.source_id));
    if ([...this.activeWork.values()].some((work) => sources.has(work.sourceId))) throw conflict("识别规则仍有活动文件操作，请先暂停并等待当前步骤安全点，再修改或删除；原文件和计划保留");
  }
  recognitionRuleChanged(ruleId: string) { for (const row of this.database.connection.prepare("SELECT source_id FROM recognition_input WHERE rule_id=?").all(ruleId) as { source_id: string }[]) this.sourceChanged(row.source_id); }
  async authorizeRecognitionTarget(grant: ManagedRootGrant) {
    const previous = this.database.connection.prepare("SELECT grant_json FROM media_target_root WHERE id=?").get(grant.id) as { grant_json: string } | undefined;
    if (previous && !sameVolumeRoot(JSON.parse(previous.grant_json).volume, grant.volume)) throw conflict("媒体目录原卷身份不一致，请恢复原磁盘后重试");
    await this.targets.install(grant); this.database.connection.prepare("INSERT INTO media_target_root VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET grant_json=excluded.grant_json,available=1").run(grant.id, JSON.stringify(grant));
  }
  async prepareRecognitionInput(snapshot: RecognitionRuleSnapshot, grant: ManagedRootGrant) {
    if (this.closed || grant.id !== snapshot.inputDirectory.id || grant.path !== snapshot.inputDirectory.path) throw conflict("识别输入授权与预览不一致，请重新选择原目录");
    const db = this.database.connection, sourcePath = snapshot.inputMode === "managed-completed" ? join(grant.path, "completed") : grant.path;
    const existing = db.prepare("SELECT d.*,i.target_root_id,i.mode,i.download_root_id FROM desktop_source d LEFT JOIN ingestion_source i ON i.source_id=d.id WHERE d.source_path=?").get(sourcePath) as { id: string; version: number; target_root_id: string | null; mode: "local" | "managed" | null; download_root_id: string | null } | undefined;
    const sourceId = existing?.id ?? randomUUID(), owner = recognitionOwner(this.database, sourceId);
    if ([...this.activeWork.values()].some((work) => work.sourceId === sourceId)) throw conflict("原输入仍有活动文件步骤，请先暂停并等待安全点后确认接管");
    if (owner && owner.rule_id !== snapshot.ruleId && db.prepare("SELECT 1 FROM ingestion_operation WHERE candidate_id IN (SELECT id FROM ingestion_candidate WHERE source_id=?) AND phase!='RECORDED' LIMIT 1").get(sourceId)) throw conflict("此输入仍有其他识别规则的原文件计划，请先处理原任务再转交，避免替换恢复归属");
    const source = await SourceRoot.open(grant), version = (existing?.version ?? 0) + 1;
    try {
      for (const target of snapshot.targets) {
        const row = db.prepare("SELECT grant_json FROM configuration_directory WHERE id=? AND kind='media'").get(target.directory.id) as { grant_json: string | null } | undefined;
        if (!row?.grant_json) throw conflict("媒体目录授权尚未恢复，请核验原目录"); await this.authorizeRecognitionTarget(managedRootGrantSchema.parse(JSON.parse(row.grant_json)));
      }
    } catch (error) { await source.close(); throw error; }
    let activated = false;
    return { sourceId,
      commit: (paused: boolean) => {
        if (!db.inTransaction) throw new Error("识别输入与规则快照必须在同一事务保存");
        if (this.closed) throw new DesktopError("INTERRUPTED", "识别服务正在停止", true);
        if ([...this.activeWork.values()].some((work) => work.sourceId === sourceId)) throw conflict("原输入仍有在途操作，请等待安全点后重新预览");
        if (existing) db.prepare("UPDATE desktop_source SET name=?,version=?,paused=?,health='available' WHERE id=?").run(snapshot.configuration.name, version, Number(paused), sourceId);
        else db.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,version,paused,health,created_at) VALUES(?,?,?,?,'','AUTO','COPY',?,?,'available',?)").run(sourceId, snapshot.configuration.name, snapshot.configuration.client, sourcePath, version, Number(paused), timestamp(this.now));
        db.prepare("INSERT INTO ingestion_source VALUES(?,?,?,?,?,?,1) ON CONFLICT(source_id) DO UPDATE SET source_grant_json=excluded.source_grant_json,source_version=excluded.source_version,available=1").run(sourceId, existing?.mode ?? "local", existing?.download_root_id ?? null, JSON.stringify(grant), existing?.target_root_id ?? null, version);
        db.prepare("UPDATE recognition_input SET active=0 WHERE rule_id=?").run(snapshot.ruleId);
        db.prepare("INSERT INTO recognition_input VALUES(?,?,?,?,1) ON CONFLICT(source_id) DO UPDATE SET rule_id=excluded.rule_id,directory_id=excluded.directory_id,mode=excluded.mode,active=1").run(sourceId, snapshot.ruleId, grant.id, snapshot.inputMode);
        db.prepare("UPDATE desktop_source SET paused=? WHERE id IN (SELECT source_id FROM recognition_input WHERE rule_id=?)").run(Number(paused), snapshot.ruleId);
      },
      activate: async () => { if (activated) return; activated = true; const previous = this.sources.get(sourceId); this.sources.set(sourceId, source); await previous?.close(); this.sourceChanged(sourceId); },
      close: async () => { if (!activated) await source.close(); },
    };
  }
  async restoreRecognitionInputs(directories: ConfigurationDirectories) {
    for (const row of this.database.connection.prepare("SELECT i.source_id,i.directory_id FROM recognition_input i ORDER BY i.source_id LIMIT 1000").all() as { source_id: string; directory_id: string }[]) {
      if (this.closed) return;
      try {
        const grant = directories.grant(row.directory_id), previous = this.database.connection.prepare("SELECT source_grant_json FROM ingestion_source WHERE source_id=?").get(row.source_id) as { source_grant_json: string };
        if (!sameVolumeRoot(JSON.parse(previous.source_grant_json).volume, grant.volume)) throw conflict("原输入卷身份已变化");
        await directories.reader(row.directory_id).check(); const source = await SourceRoot.open(grant), old = this.sources.get(row.source_id); this.sources.set(row.source_id, source); await old?.close();
        this.database.connection.prepare("UPDATE ingestion_source SET source_grant_json=?,available=1 WHERE source_id=?").run(JSON.stringify(grant), row.source_id); this.sourceChanged(row.source_id);
      } catch { this.database.connection.prepare("UPDATE ingestion_source SET available=0 WHERE source_id=?").run(row.source_id); }
    }
  }
  taskTargets(taskId: string): CoreOutput<"recognition.task-targets"> { const row = this.database.connection.prepare("SELECT source_id FROM media_task WHERE id=?").get(taskId) as { source_id: string } | undefined, snapshot = row ? recognitionSnapshot(this.database, row.source_id) : null; return { ...(snapshot && row ? { scopeToken: fingerprint({ context: recognitionCandidateContext(this.database, row.source_id), bindings: snapshot.targets.map((target) => recognitionEmbyBinding(this.database, target.targetId)) }) } : {}), ruleId: snapshot?.ruleId ?? null, ruleVersion: snapshot?.ruleVersion ?? 0, automatic: snapshot?.configuration.automatic ?? false, targets: snapshot?.configuration.targets ?? [] }; }
  assertRecognitionAutomaticSample(snapshot: RecognitionRuleSnapshot, id: string) {
    const row = this.database.connection.prepare("SELECT p.plan_json,p.expires_at FROM ingestion_preview p WHERE p.id=?").get(id) as { plan_json: string; expires_at: number } | undefined;
    const plan = row ? JSON.parse(row.plan_json) as Plan : null;
    if (!plan?.recognitionSnapshot || row!.expires_at <= this.now() || fingerprint(plan.recognitionSnapshot) !== fingerprint(snapshot) || !snapshot.configuration.targets.some((target) => target.id === plan.logicalTargetId)) throw conflict("首次样本预览与当前识别规则不一致或已过期，请核对目标、命名和文件完整性后重新预览授权");
    this.assertRecognitionPlanCurrent(plan);
  }
  private assertRecognitionPlanCurrent(plan: Plan) {
    if (!plan.recognitionSnapshot) return;
    const current = recognitionSnapshot(this.database, plan.sourceId);
    if (!current || fingerprint(current) !== fingerprint(plan.recognitionSnapshot) || fingerprint(recognitionCandidateContext(this.database, plan.sourceId)) !== fingerprint(plan.recognitionContext) || JSON.stringify(recognitionEmbyBinding(this.database, plan.logicalTargetId!)) !== JSON.stringify(plan.embyBinding ?? null)) throw conflict("识别规则、默认设置或 Emby 关联已变化，请重新预览；未提交旧计划不改用新目标");
  }
  start() { if (!this.timer && !this.closed) { this.recognitionBatches.start(); this.organizeBatches.start(); this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 10000); void this.tick().catch(() => {}); } }
  private organizeWaiting(taskId: string) {
    if (!this.connections.installed) return "等待核心恢复服务凭据，不重放确认";
    const db = this.database.connection, candidate = db.prepare("SELECT * FROM ingestion_candidate WHERE task_id=?").get(taskId) as CandidateRow | undefined;
    if (!candidate) return null;
    if (this.pauseStatus().paused || (db.prepare("SELECT paused FROM desktop_source WHERE id=?").get(candidate.source_id) as { paused: number } | undefined)?.paused) return "来源或全局整理已暂停，恢复后继续此批次";
    if (this.contentReviews.active(candidate.source_id)) return "来源正在复核内容，完成后重新核对原批次";
    if (candidate.managed_item_id && candidate.managed_version_key && resolveManagedOrganization(this.database, candidate.managed_item_id, candidate.managed_version_key).state === "PAUSED") return "所属整理来源已暂停，恢复后继续";
    return null;
  }
  private organizeContext(taskId: string, selection: CoreInput<"ingestion.preview">["selection"]) {
    const db = this.database.connection, task = db.prepare("SELECT * FROM media_task WHERE id=?").get(taskId) as { source_id: string; status: string; parsed_json: string | null } | undefined, row = db.prepare("SELECT * FROM ingestion_candidate WHERE task_id=?").get(taskId) as CandidateRow | undefined;
    if (!task || !row || task.status !== "AWAITING_CONFIRMATION" || db.prepare("SELECT 1 FROM ingestion_operation WHERE task_id=?").get(taskId)) throw conflict("此文件不在待确认状态或已有整理计划，请查看原任务");
    this.assertCandidateCurrent(row);
    if (!recognitionOwner(this.database, row.source_id) && !row.managed_item_id && db.prepare("SELECT 1 FROM source_rule WHERE local_source_id=? AND deleted_at IS NOT NULL").get(row.source_id)) throw conflict("所属来源已删除，请先恢复来源再预览整理");
    const source = db.prepare(sourceQuery + " WHERE i.source_id=?").get(row.source_id) as SourceRow | undefined;
    if (!source) throw conflict("来源尚未取得整理授权，请在来源页核对目录");
    const policy = this.candidatePolicy(row), configured = !!policy || !!db.prepare("SELECT 1 FROM source_rule WHERE local_source_id=?").get(row.source_id), route = !configured ? db.prepare("SELECT target_root_id FROM media_library_route WHERE media_type=?").get(selection.mediaType) as { target_root_id: string } | undefined : undefined;
    const independent = recognitionRoute(this.database, source.source_id, selection.mediaType, selection.targetId);
    const targetId = independent?.target.directory.id ?? policy?.target_root_id ?? route?.target_root_id ?? source.target_root_id, target = db.prepare("SELECT grant_json FROM media_target_root WHERE id=?").get(targetId) as { grant_json: string } | undefined;
    if (!target) throw conflict("媒体目标授权已不存在，请重新选择并预览");
    const stableGrant = (value: string) => { const grant = managedRootGrantSchema.parse(JSON.parse(value)), { observedDevice: _device, ...volume } = grant.volume; return { id: grant.id, path: grant.path, volume }; };
    return fingerprint({ candidateId: row.id, version: row.version_key, snapshot: row.snapshot_json, sha256: row.expected_sha256, source: this.recognitionContext(row.id), logicalTargetId: independent?.configuration.id, binding: independent?.binding, sourceGrant: stableGrant(source.source_grant_json), target: stableGrant(target.grant_json), parsed: task.parsed_json, recognition: this.recognitionEdits.revision(taskId), connection: this.connections.version });
  }
  private organizeManifest(previewId: string): BatchManifest {
    const row = this.database.connection.prepare("SELECT plan_json FROM ingestion_preview WHERE id=?").get(previewId) as { plan_json: string }, plan = JSON.parse(row.plan_json) as Plan, target = this.targets.get(plan.target.id);
    return { selection: plan.selection, targets: [plan.targetSegments, ...(plan.accessories ?? []).map((asset) => asset.targetSegments)].map((segments) => ({ rootId: plan.target.id, segments, canonical: target.mappingIdentity(segments), path: join(plan.target.path, ...segments) })) };
  }
  private recognitionContext(id: string) {
    const row = this.candidate(id), db = this.database.connection, source = db.prepare("SELECT version FROM desktop_source WHERE id=?").get(row.source_id) as { version: number };
    const independent = recognitionCandidateContext(this.database, row.source_id);
    if (independent) {
      if (independent.deleted || !independent.active) throw conflict("此候选的识别规则已删除或输入已切换，请核对原任务");
      return { sourceVersion: source.version, rules: [{ id: independent.ruleId, version: independent.version, lifecycle_revision: independent.lifecycle, deleted_at: null }], policy: fingerprint(independent) };
    }
    const rules = db.prepare("SELECT DISTINCT s.id,s.version,s.lifecycle_revision,s.deleted_at FROM source_rule s LEFT JOIN download_source_demand d ON d.source_id=s.id LEFT JOIN download_job_item ji ON ji.job_id=d.job_id WHERE s.local_source_id=? OR (ji.item_id=? AND d.source_version=s.version AND EXISTS(SELECT 1 FROM source_rule_version v WHERE v.source_id=s.id AND v.version=d.source_version AND json_extract(v.configuration_json,'$.organization') IS NOT NULL)) ORDER BY s.id").all(row.source_id, row.managed_item_id) as { id: string; version: number; lifecycle_revision: number; deleted_at: string | null }[];
    if (rules.length && rules.every((rule) => rule.deleted_at)) throw conflict("所属来源已删除，请先恢复来源再重新选择候选");
    return { sourceVersion: source.version, rules: rules.filter((rule) => !rule.deleted_at), policy: this.candidatePolicy(row)?.policy_key ?? null };
  }
  private batchAvailability(id: string, serialized: string): BatchAvailability {
    const row = this.candidate(id); if (row.task_id) return { state: "READY" };
    const old = JSON.parse(serialized) as ReturnType<IngestionPipeline["recognitionContext"]>, current = this.recognitionContext(id);
    if (old.sourceVersion !== current.sourceVersion || old.policy !== current.policy || old.rules.length && !old.rules.some((rule) => current.rules.some((latest) => latest.id === rule.id && latest.version === rule.version && latest.lifecycle_revision === rule.lifecycle_revision))) return { state: "FAILED", reason: "所属来源或整理策略已变化，请按当前来源重新选择候选；原批次不会改用新配置" };
    if (row.state === "SUPERSEDED" || !row.managed_item_id && !row.is_current || row.state === "SKIPPED") return { state: "FAILED", reason: "此候选已被新版本替代或不受支持，请在待处理列表选择当前普通视频" };
    const source = this.database.connection.prepare(sourceQuery + " WHERE i.source_id=?").get(row.source_id) as SourceRow | undefined;
    if (this.pauseStatus().paused || source?.paused || this.contentReviews.active(row.source_id)) return { state: "WAIT", reason: "来源、全局整理已暂停或正在复核内容；恢复后继续本批次，不解除其他暂停" };
    if (!source || !source.available || !this.sources.has(row.source_id)) return { state: "WAIT", reason: "等待原磁盘、目录授权与稳定观察恢复，不接管同名替代磁盘" };
    if (!this.managedCandidateEnabled(row)) {
      const resolution = row.managed_item_id && row.managed_version_key ? resolveManagedOrganization(this.database, row.managed_item_id, row.managed_version_key) : null;
      return resolution?.state === "PAUSED" ? { state: "WAIT", reason: "此下载项所属的整理来源已暂停，恢复后重新观察并继续" } : { state: "FAILED", reason: "此下载项的整理归属已改变或待核对，请按当前来源重新选择；原批次不改用其他策略" };
    }
    return row.state === "READY" ? { state: "READY" } : { state: "WAIT", reason: "等待文件重新完成至少 120 秒稳定观察；批量识别不会跳过就绪检查" };
  }
  /** 恢复旧业务库后重新核对已有成果，只读目标，不重放 COPY。队列随数据库持久化。 */
  reconcileRestored() {
    const db = this.database.connection;
    db.transaction(() => {
      db.prepare("DELETE FROM app_setting WHERE key IN (SELECT 'ingestion.restore.audit.'||o.id FROM ingestion_operation o JOIN media_task t ON t.id=o.task_id WHERE t.status='CORRECTED' OR EXISTS(SELECT 1 FROM correction_item ci WHERE ci.task_id=t.id AND ci.state IN ('PENDING','RUNNING','NEEDS_ATTENTION')))").run();
      db.prepare("INSERT OR IGNORE INTO app_setting(key,value) SELECT 'ingestion.restore.audit.'||o.id,'0' FROM ingestion_operation o JOIN media_task t ON t.id=o.task_id WHERE o.phase='RECORDED' AND t.status='DONE' AND NOT EXISTS(SELECT 1 FROM correction_item ci WHERE ci.task_id=t.id AND ci.state IN ('PENDING','RUNNING','NEEDS_ATTENTION'))").run();
      db.prepare("UPDATE media_task SET status='PROCESSING',delivery_status='NOT_READY',updated_at=? WHERE id IN (SELECT o.task_id FROM ingestion_operation o JOIN app_setting s ON s.key='ingestion.restore.audit.'||o.id)").run(timestamp(this.now));
      db.prepare("UPDATE ingestion_candidate SET reason='恢复备份后等待核对现存目标，不会重新复制' WHERE id IN (SELECT o.candidate_id FROM ingestion_operation o JOIN app_setting s ON s.key='ingestion.restore.audit.'||o.id)").run();
    })();
  }
  private async auditRestored() {
    const db = this.database.connection;
    const rows = db.prepare("SELECT o.* FROM ingestion_operation o JOIN app_setting s ON s.key='ingestion.restore.audit.'||o.id JOIN media_task t ON t.id=o.task_id WHERE o.phase='RECORDED' AND t.status IN ('DONE','PROCESSING') AND NOT EXISTS(SELECT 1 FROM correction_item ci WHERE ci.task_id=t.id AND ci.state IN ('PENDING','RUNNING','NEEDS_ATTENTION')) ORDER BY CAST(s.value AS INTEGER),o.id LIMIT 4").all() as OperationRow[];
    const unavailable = (error: unknown) => ["LOCAL_UNAVAILABLE", "EACCES", "EPERM", "EROFS", "EIO", "ENXIO", "ESTALE", "EBADF"].includes((error as { code?: string }).code ?? "");
    const verify = async (row: OperationRow) => {
      const plan = JSON.parse(row.plan_json) as Plan, expected = localFileEvidenceSchema.parse(JSON.parse(row.evidence_json!)), root = this.targets.get(plan.target.id);
      if (!sameVolumeRoot(root.grant.volume, plan.target.volume)) throw conflict();
      const actual = await root.inspectCompleted(plan.targetSegments);
      if ((["volumeId", "inode", "birthtimeNs", "modifiedNs", "size", "sha256"] as const).some((field) => actual[field] !== expected[field])) throw conflict();
    };
    for (const row of rows) {
      if (this.closed) return;
      let primaryChanged = false, deferred = false;
      const changedAccessories: string[] = [];
      try { await verify(row); } catch (error) { if (unavailable(error)) deferred = true; else primaryChanged = true; }
      if (!primaryChanged && !deferred) for (const asset of db.prepare("SELECT * FROM ingestion_accessory WHERE operation_id=? AND phase='RECORDED'").all(row.id) as OperationRow[]) {
        if (this.closed) return;
        try { await verify(asset); } catch (error) { if (unavailable(error)) { deferred = true; break; } changedAccessories.push(asset.id); }
      }
      if (this.closed) return;
      if (db.prepare("SELECT 1 FROM media_task t WHERE t.id=? AND (t.status='CORRECTED' OR EXISTS(SELECT 1 FROM correction_item ci WHERE ci.task_id=t.id AND ci.state IN ('PENDING','RUNNING','NEEDS_ATTENTION')))").get(row.task_id)) { db.prepare("DELETE FROM app_setting WHERE key=?").run("ingestion.restore.audit." + row.id); continue; }
      if (deferred) {
        db.prepare("UPDATE app_setting SET value=? WHERE key=?").run(String(this.now()), "ingestion.restore.audit." + row.id);
        db.prepare("UPDATE ingestion_candidate SET reason='恢复备份后目标暂不可访问，等待原卷及权限恢复；不会重建或覆盖文件' WHERE id=?").run(row.candidate_id); continue;
      }
      db.transaction(() => {
        if (db.prepare("SELECT 1 FROM media_task t WHERE t.id=? AND (t.status='CORRECTED' OR EXISTS(SELECT 1 FROM correction_item ci WHERE ci.task_id=t.id AND ci.state IN ('PENDING','RUNNING','NEEDS_ATTENTION')))").get(row.task_id)) { db.prepare("DELETE FROM app_setting WHERE key=?").run("ingestion.restore.audit." + row.id); return; }
        if (!db.prepare("SELECT 1 FROM app_setting s JOIN ingestion_operation o ON s.key='ingestion.restore.audit.'||o.id WHERE o.id=? AND o.phase='RECORDED'").get(row.id)) return;
        const stamp = timestamp(this.now);
        if (primaryChanged) db.prepare("UPDATE ingestion_operation SET phase='NEEDS_ATTENTION',failure_code='CONFLICT',updated_at=? WHERE id=?").run(stamp, row.id);
        for (const id of changedAccessories) db.prepare("UPDATE ingestion_accessory SET phase='NEEDS_ATTENTION',failure_code='CONFLICT',updated_at=? WHERE id=? AND phase='RECORDED'").run(stamp, id);
        db.prepare("UPDATE media_task SET status=?,delivery_status=?,updated_at=? WHERE id=?").run(primaryChanged ? "FAILED" : "DONE", primaryChanged ? "NEEDS_ATTENTION" : "REFRESH_PENDING", stamp, row.task_id);
        db.prepare("UPDATE ingestion_candidate SET reason=? WHERE id=?").run(primaryChanged ? "恢复备份后目标证据不符，已保留现存文件；请核对后处理" : changedAccessories.length ? "恢复备份后部分附属文件证据不符，已保留现存文件；请核对后处理" : null, row.candidate_id);
        if (primaryChanged) db.prepare("UPDATE emby_delivery SET state='NEEDS_ATTENTION',last_failure='TARGET_CHANGED',emby_item_id=NULL,updated_at=? WHERE task_id=?").run(stamp, row.task_id);
        else db.prepare("UPDATE emby_delivery SET state='REFRESH_PENDING',next_attempt_at=max(next_attempt_at,?),check_started_at=NULL,emby_item_id=NULL,updated_at=? WHERE task_id=?").run(this.now() + 30000, stamp, row.task_id);
        if (primaryChanged) db.prepare("UPDATE desktop_job SET state='NEEDS_ATTENTION',updated_at=? WHERE id=?").run(stamp, row.id); else this.accessoryJobState(row.id);
        db.prepare("DELETE FROM app_setting WHERE key=?").run("ingestion.restore.audit." + row.id);
      })();
    }
  }
  pauseStatus() { return { paused: (this.database.connection.prepare("SELECT value FROM app_setting WHERE key='ingestion.paused'").get() as { value: string } | undefined)?.value === "true" }; }
  setPaused(input: CoreInput<"ingestion.set-paused">) {
    if (this.closed) throw new DesktopError("INTERRUPTED", "整理正在停止", true);
    const db = this.database.connection, key = `ingestion.pause.command.${input.requestKey}`, old = db.prepare("SELECT value FROM app_setting WHERE key=?").get(key) as { value: string } | undefined;
    if (old) { if (old.value !== String(input.paused)) throw conflict("请求标识已用于其他整理控制"); return this.pauseStatus(); }
    db.transaction(() => {
      db.prepare("INSERT INTO app_setting(key,value) VALUES('ingestion.paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(input.paused));
      db.prepare("INSERT INTO app_setting VALUES(?,?)").run(key, String(input.paused));
      if (!input.paused) db.prepare("UPDATE ingestion_outbox SET delivery_attempts=0,next_attempt_at=NULL WHERE state='PENDING'").run();
    })();
    if (input.paused) { this.controller?.abort(); this.contentReviews.interrupt(); for (const controller of this.scanControllers.values()) controller.abort(); } this.resetObservations(); for (const id of this.sources.keys()) this.syncSourceWatcher(id); return this.pauseStatus();
  }
  resetObservations() {
    this.observations.clear();
    this.accessoryObservations.clear();
    this.database.connection.prepare("UPDATE ingestion_candidate SET state='OBSERVING',reason='重新观察文件稳定性' WHERE state IN ('READY','UNAVAILABLE')").run();
  }
  private observeWindow(observations: Map<string, Observation>, key: string, version: string) {
    const now = this.monotonic(), wall = this.now(), previous = observations.get(key);
    // 部分平台的单调时钟不计入休眠；任一时钟出现长间隔都重新观察。
    const reset = !previous || previous.version !== version || now < previous.last || now - previous.last > 30000 || wall < previous.wall || wall - previous.wall > 30000;
    const current = reset ? { since: now, last: now, wall, version } : { ...previous, last: now, wall };
    observations.set(key, current); return { now, current };
  }
  sourceChanged(id: string) {
    this.scanControllers.get(id)?.abort();
    for (const [controller, work] of this.activeWork) if (work.sourceId === id) controller.abort();
    this.contentReviews.interrupt(id);
    for (const row of this.database.connection.prepare("SELECT id FROM ingestion_candidate WHERE source_id=?").all(id) as { id: string }[]) this.observations.delete(row.id);
    for (const key of this.accessoryObservations.keys()) if (key.startsWith(id + ":")) this.accessoryObservations.delete(key);
    this.database.connection.prepare("UPDATE ingestion_candidate SET state='OBSERVING',reason='来源配置或暂停状态已变化，请重新观察' WHERE source_id=? AND state='READY'").run(id);
    this.syncSourceWatcher(id);
  }
  sourceRuleChanged(id: string) {
    const rows = this.database.connection.prepare("SELECT * FROM ingestion_candidate WHERE source_id=?").all(id) as CandidateRow[];
    const affected = rows.filter((row) => !this.managedCandidateEnabled(row));
    // 已完成主视频的字幕仍可能在写入，取消范围不能只看未完成候选列表。
    for (const [controller, work] of this.activeWork) if (work.sourceId === id && !this.managedCandidateEnabled(this.candidate(work.candidateId))) controller.abort();
    for (const row of affected) {
      this.observations.delete(row.id);
      const relative: string[] = JSON.parse(row.relative_json);
      if (associated.test(relative.at(-1)!)) this.accessoryObservations.delete(`${id}:${this.candidatePolicy(row)?.policy_key ?? "local"}:${row.relative_json}`);
      this.database.connection.prepare("UPDATE ingestion_candidate SET state=CASE WHEN state='READY' THEN 'OBSERVING' ELSE state END,reason='所属来源暂停或配置变化，请核对整理需求' WHERE id=? AND state NOT IN ('PROCESSED','SKIPPED','SUPERSEDED')").run(row.id);
    }
    this.syncSourceWatcher(id);
  }
  /** 只检查当前写入者；停止在暂存阶段的持久计划保留，恢复后仍沿原计划处理。 */
  assertRuleRemovalSafe(ruleId: string, sourceId: string) {
    const db = this.database.connection;
    const legacy = db.prepare("SELECT o.id FROM ingestion_operation o JOIN ingestion_candidate c ON c.id=o.candidate_id WHERE c.source_id=? AND c.managed_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ingestion_candidate_policy p WHERE p.candidate_id=c.id) AND (o.phase NOT IN ('RECORDED','NEEDS_ATTENTION') OR EXISTS(SELECT 1 FROM ingestion_accessory a WHERE a.operation_id=o.id AND a.phase NOT IN ('RECORDED','NEEDS_ATTENTION'))) LIMIT 1").get(sourceId) as { id: string } | undefined;
    if (legacy) throw conflict(`共享目录中的历史整理计划 ${legacy.id} 归属尚未确定，请先处理原任务再删除来源`);
    for (const work of this.activeWork.values()) {
      if (work.sourceId !== sourceId) continue;
      const candidate = this.candidate(work.candidateId);
      if (candidate.managed_item_id && candidate.managed_version_key) {
        const owner = db.prepare("SELECT 1 FROM download_job_item ji JOIN download_source_demand d ON d.job_id=ji.job_id WHERE ji.item_id=? AND d.source_id=? LIMIT 1").get(candidate.managed_item_id, ruleId);
        if (!owner) continue;
        const policy = this.candidatePolicy(candidate), remaining = resolveManagedOrganization(this.database, candidate.managed_item_id, candidate.managed_version_key, ruleId);
        if (policy && remaining.state === "ENABLED" && remaining.policy.key === policy.policy_key) continue;
      }
      throw conflict(`来源还有活动整理任务 ${candidate.task_id ?? candidate.id}，请先暂停并等待当前文件到达安全点后删除`);
    }
  }
  assertRuleRestoreSafe(sourceId: string) {
    const row = this.database.connection.prepare(sourceQuery + " WHERE i.source_id=?").get(sourceId) as SourceRow | undefined;
    if (!row || row.mode !== "local") return;
    const target = this.database.connection.prepare("SELECT grant_json FROM media_target_root WHERE id=?").get(row.target_root_id) as { grant_json: string };
    this.checkConfiguration({ sourceId, sourceVersion: row.source_version, mode: "local", downloadRootId: null, source: JSON.parse(row.source_grant_json), target: JSON.parse(target.grant_json) });
  }
  async localDirectoryHealth(id: string): Promise<{ input: LocalDirectoryHealth; target: LocalDirectoryHealth }> {
    const row = this.database.connection.prepare(sourceQuery + " WHERE i.source_id=?").get(id) as SourceRow | undefined;
    const pending = { state: "UNVERIFIED" as const, reason: "WAITING_AUTHORIZATION" as const };
    if (!row || row.mode !== "local") return { input: pending, target: pending };
    const source = this.sources.get(id); let target: ReturnType<ManagedRoots["get"]> | undefined;
    try { target = this.targets.get(row.target_root_id); } catch { /* 没有当前有效授权，不将其解释成原目录已消失。 */ }
    const check = async (root: { grant: ManagedRootGrant; check(): Promise<number> } | undefined, writable = false): Promise<LocalDirectoryHealth> => {
      if (!root) return pending;
      try { await root.check(); await access(root.grant.path, constants.R_OK | constants.X_OK | (writable ? constants.W_OK : 0)); await root.check(); return { state: "AVAILABLE" }; }
      catch (error) { const code = error && typeof error === "object" && "code" in error ? String(error.code) : "", issue = error && typeof error === "object" && "directoryIssue" in error ? error.directoryIssue as { reason?: string } | undefined : undefined; return { state: "UNAVAILABLE", reason: issue?.reason === "PERMISSION_DENIED" || ["EACCES", "EPERM", "EROFS"].includes(code) ? "PERMISSION_DENIED" : "ORIGINAL_DIRECTORY_UNAVAILABLE" }; }
    };
    const [inputHealth, targetHealth] = await Promise.all([check(source), check(target, true)]);
    let currentTarget: typeof target; try { currentTarget = this.targets.get(row.target_root_id); } catch { /* 原授权仍未恢复。 */ }
    const updated = this.database.connection.prepare(sourceQuery + " WHERE i.source_id=?").get(id) as SourceRow | undefined;
    if (this.closed || !updated || updated.version !== row.version || updated.target_root_id !== row.target_root_id || this.sources.get(id) !== source || currentTarget !== target) {
      const changed = { state: "UNVERIFIED" as const, reason: "RECHECK_REQUIRED" as const }; return { input: changed, target: changed };
    }
    return { input: inputHealth, target: targetHealth };
  }
  syncSourceWatcher(id: string) {
    const row = this.database.connection.prepare(sourceQuery + " WHERE i.source_id=?").get(id) as SourceRow | undefined, source = this.sources.get(id);
    if (!this.closed && row?.available && !row.paused && source && !this.pauseStatus().paused) { if (!this.watches.has(id)) this.watchSource(id, source.grant.path); return; }
    const owned = this.watches.get(id); if (owned) { clearTimeout(owned.timer); owned.watcher.close(); this.watches.delete(id); }
  }
  bootstrap(): PrivateCoreOutput<"media.sources.bootstrap"> {
    return (this.database.connection.prepare("SELECT i.*,t.grant_json FROM ingestion_source i JOIN media_target_root t ON t.id=i.target_root_id WHERE NOT EXISTS(SELECT 1 FROM recognition_input ri WHERE ri.source_id=i.source_id) ORDER BY i.source_id LIMIT 1000").all() as (SourceRow & { grant_json: string })[])
      .map((row) => ({ sourceId: row.source_id, sourceVersion: row.source_version, mode: row.mode, downloadRootId: row.download_root_id, source: managedRootGrantSchema.parse(JSON.parse(row.source_grant_json)), target: managedRootGrantSchema.parse(JSON.parse(row.grant_json)) }));
  }
  libraryBootstrap(): PrivateCoreOutput<"media.library.bootstrap"> {
    return (this.database.connection.prepare("SELECT r.media_type,t.grant_json FROM media_library_route r JOIN media_target_root t ON t.id=r.target_root_id ORDER BY r.media_type").all() as { media_type: "MOVIE" | "TV_SHOW"; grant_json: string }[]).map((row) => ({ mediaType: row.media_type, target: managedRootGrantSchema.parse(JSON.parse(row.grant_json)) }));
  }
  targetGrant(path: string): ManagedRootGrant | null {
    const rows = this.database.connection.prepare("SELECT grant_json FROM media_target_root WHERE json_extract(grant_json,'$.path')=? LIMIT 2").all(path) as { grant_json: string }[];
    if (rows.length > 1) throw conflict("目标存在多个历史授权，请核对原配置");
    return rows[0] ? managedRootGrantSchema.parse(JSON.parse(rows[0].grant_json)) : null;
  }
  targetBootstrap() { return (this.database.connection.prepare("SELECT grant_json FROM media_target_root ORDER BY id LIMIT 10000").all() as { grant_json: string }[]).map((row) => managedRootGrantSchema.parse(JSON.parse(row.grant_json))); }
  authorizeTarget(grant: ManagedRootGrant) { return this.serialize(async () => {
    const existing = this.targetGrant(grant.path);
    if (!existing || existing.id !== grant.id || !sameVolumeRoot(existing.volume, grant.volume)) throw new DesktopError("LOCAL_UNAVAILABLE", "媒体目标原卷身份不一致", true);
    await this.targets.install(grant);
    this.database.connection.prepare("UPDATE media_target_root SET grant_json=?,available=1 WHERE id=?").run(JSON.stringify(grant), grant.id); return {};
  }); }
  authorizeManagedSource(input: PrivateCoreInput<"media.sources.authorize-managed">) { return this.serialize(async () => {
    const db = this.database.connection;
    const check = () => {
      const row = db.prepare(sourceQuery + " WHERE i.source_id=?").get(input.sourceId) as SourceRow | undefined;
      if (this.closed || !row || row.mode !== "managed" || row.source_version !== input.sourceVersion || row.version !== input.sourceVersion) throw conflict();
      const previous = managedRootGrantSchema.parse(JSON.parse(row.source_grant_json));
      const root = db.prepare("SELECT canonical_path,volume_identity FROM managed_download_root WHERE id=? AND state='AVAILABLE'").get(row.download_root_id) as { canonical_path: string; volume_identity: string } | undefined;
      if (!root || previous.id !== input.source.id || previous.path !== input.source.path || root.canonical_path !== input.source.path || !sameVolumeRoot(previous.volume, input.source.volume) || !sameVolumeRoot(JSON.parse(root.volume_identity), input.source.volume)) throw new DesktopError("LOCAL_UNAVAILABLE", "受管来源原卷尚未恢复", true);
    };
    check(); const source = await SourceRoot.open(input.source);
    try { check(); db.prepare("UPDATE ingestion_source SET source_grant_json=?,available=1 WHERE source_id=?").run(JSON.stringify(input.source), input.sourceId); db.prepare("UPDATE desktop_source SET health='available' WHERE id=?").run(input.sourceId); }
    catch (error) { await source.close(); throw error; }
    const previous = this.sources.get(input.sourceId); this.sources.set(input.sourceId, source); this.sourceChanged(input.sourceId); this.watchSource(input.sourceId, input.source.path); await previous?.close(); return {};
  }); }
  authorizeLibrary(input: PrivateCoreInput<"media.library.authorize">) { return this.serialize(async () => {
    const db = this.database.connection, targets = db.prepare("SELECT id,grant_json FROM media_target_root").all() as { id: string; grant_json: string }[];
    const previous = targets.find((row) => row.id === input.target.id);
    if (previous && (JSON.parse(previous.grant_json).path !== input.target.path || !sameVolumeRoot(JSON.parse(previous.grant_json).volume, input.target.volume))) throw new DesktopError("LOCAL_UNAVAILABLE", "目标原卷身份不一致", true);
    const overlaps = () => {
      const roots = db.prepare("SELECT canonical_path FROM managed_download_root").all() as { canonical_path: string }[];
      const sources = db.prepare("SELECT source_path FROM desktop_source d WHERE NOT EXISTS(SELECT 1 FROM source_rule s WHERE s.local_source_id=d.id AND s.deleted_at IS NOT NULL)").all() as { source_path: string }[];
      if ([...roots.map((row) => row.canonical_path), ...sources.map((row) => row.source_path)].some((path) => pathsOverlap(path, input.target.path, input.target.volume)) || targets.some((row) => row.id !== input.target.id && pathsOverlap(JSON.parse(row.grant_json).path, input.target.path, input.target.volume))) throw new DesktopError("UNSAFE_PATH", "媒体目标与其他来源或目标重叠");
    }; overlaps(); await this.targets.install(input.target); overlaps();
    db.transaction(() => { db.prepare("INSERT INTO media_target_root VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET grant_json=excluded.grant_json,available=1").run(input.target.id, JSON.stringify(input.target)); db.prepare("INSERT INTO media_library_route VALUES(?,?) ON CONFLICT(media_type) DO UPDATE SET target_root_id=excluded.target_root_id").run(input.mediaType, input.target.id); })();
    return {};
  }); }
  libraries(): CoreOutput<"media.libraries"> {
    const rows = this.database.connection.prepare("SELECT t.id,t.grant_json,t.available,r.media_type FROM media_library_route r JOIN media_target_root t ON t.id=r.target_root_id UNION ALL SELECT t.id,t.grant_json,t.available,json_extract(v.configuration_json,'$.organization.mediaType') AS media_type FROM source_rule s JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version JOIN media_target_root t ON t.id=v.target_root_id WHERE s.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM legacy_configuration_owner lo WHERE lo.source_id=s.id AND lo.recognition_claimed=1) AND json_extract(v.configuration_json,'$.organization') IS NOT NULL UNION ALL SELECT t.id,t.grant_json,t.available,json_extract(o.plan_json,'$.selection.mediaType') AS media_type FROM emby_delivery d JOIN ingestion_operation o ON o.id=d.operation_id JOIN media_target_root t ON t.id=o.target_root_id WHERE d.state!='COLLECTED' AND json_extract(o.plan_json,'$.logicalTargetId') IS NULL UNION ALL SELECT t.id,t.grant_json,t.available,json_extract(o.plan_json,'$.selection.mediaType') AS media_type FROM media_correction_operation o JOIN media_task mt ON mt.id=o.new_task_id JOIN media_target_root t ON t.id=o.target_root_id WHERE o.phase='RECORDED' AND mt.status='DONE' AND json_extract(o.plan_json,'$.logicalTargetId') IS NULL LIMIT 2000").all() as { id: string; grant_json: string; available: number; media_type: "AUTO" | "MOVIE" | "TV_SHOW" }[];
    const targets = new Map<string, CoreOutput<"media.libraries">[number]>();
    for (const row of rows) { const previous = targets.get(row.id); targets.set(row.id, { targetId: row.id, mediaType: previous && previous.mediaType !== row.media_type ? "AUTO" : row.media_type, path: managedRootGrantSchema.parse(JSON.parse(row.grant_json)).path, available: !!row.available }); }
    const logical = this.database.connection.prepare("SELECT x.id,x.directory_id,x.media_type,x.name,d.version,d.path,t.available FROM recognition_target_identity x JOIN configuration_directory d ON d.id=x.directory_id LEFT JOIN media_target_root t ON t.id=d.id WHERE EXISTS(SELECT 1 FROM recognition_rule r JOIN recognition_rule_version v ON v.rule_id=r.id AND v.version=r.version,json_each(v.snapshot_json,'$.configuration.targets') j WHERE r.deleted_at IS NULL AND json_extract(j.value,'$.id')=x.id) OR EXISTS(SELECT 1 FROM ingestion_operation o WHERE json_extract(o.plan_json,'$.logicalTargetId')=x.id) OR EXISTS(SELECT 1 FROM media_correction_operation o WHERE json_extract(o.plan_json,'$.logicalTargetId')=x.id) ORDER BY x.id LIMIT 2000").all() as { id: string; directory_id: string; media_type: "MOVIE" | "TV_SHOW"; name: string; version: number; path: string; available: number | null }[];
    for (const target of logical) targets.set(target.id, { targetId: target.id, directoryId: target.directory_id, directoryVersion: target.version, name: target.name, mediaType: target.media_type, path: target.path, available: !!target.available });
    return [...targets.values()];
  }
  private targetFor(source: SourceRow, type: "MOVIE" | "TV_SHOW", targetId?: string) {
    const independent = recognitionRoute(this.database, source.source_id, type, targetId);
    if (independent) return this.targets.get(independent.target.directory.id);
    const configured = !!source.policy_key || !!this.database.connection.prepare("SELECT 1 FROM source_rule WHERE local_source_id=?").get(source.source_id);
    const route = !configured ? this.database.connection.prepare("SELECT target_root_id FROM media_library_route WHERE media_type=?").get(type) as { target_root_id: string } | undefined : undefined;
    return this.targets.get(route?.target_root_id ?? source.target_root_id);
  }
  private serialize<T>(work: () => Promise<T>) { const promise = this.configurationQueue.catch(() => {}).then(work); this.configurationQueue = promise; return promise; }
  private checkConfiguration(input: Authorization, draft?: { version: number; source_path: string; target_path: string }) {
    if (this.closed) throw new DesktopError("INTERRUPTED", "整理服务正在停止", true);
    const db = this.database.connection, source = draft ?? db.prepare("SELECT * FROM desktop_source WHERE id=?").get(input.sourceId) as { version: number; source_path: string; target_path: string } | undefined;
    const sourcePath = input.mode === "managed" ? join(input.source.path, "completed") : input.source.path;
    if (!source || source.version !== input.sourceVersion || source.source_path !== sourcePath || source.target_path !== input.target.path) throw conflict();
    if (pathsOverlap(input.source.path, input.target.path, input.target.volume)) throw new DesktopError("UNSAFE_PATH", "来源和目标不能相互包含");
    const others = db.prepare("SELECT id,name,source_path,target_path FROM desktop_source d WHERE id!=? AND NOT EXISTS(SELECT 1 FROM source_rule r WHERE r.local_source_id=d.id AND r.deleted_at IS NOT NULL)").all(input.sourceId) as { id: string; name: string; source_path: string; target_path: string }[];
    const overlap = others.find((row) => pathsOverlap(row.source_path, input.source.path, input.target.volume) || pathsOverlap(row.source_path, input.target.path, input.target.volume) || pathsOverlap(row.target_path, input.source.path, input.target.volume) || (row.target_path !== input.target.path && pathsOverlap(row.target_path, input.target.path, input.target.volume)));
    if (overlap) {
      const sourceOverlap = pathsOverlap(overlap.source_path, input.source.path, input.target.volume) || pathsOverlap(overlap.source_path, input.target.path, input.target.volume);
      throw new DesktopError("UNSAFE_PATH", `所选目录与来源「${overlap.name.slice(0, 100)}」的${sourceOverlap ? "输入目录" : "媒体目标"}重叠，请修改对应来源或选择独立目录（关联来源：${overlap.id}）`, false, undefined, { reason: sourceOverlap ? "SOURCE_OVERLAP" : "TARGET_OVERLAP", conflict: { kind: "source", id: overlap.id } });
    }
    const roots = db.prepare("SELECT id,canonical_path FROM managed_download_root").all() as { id: string; canonical_path: string }[];
    const downloadOverlap = roots.find((root) => pathsOverlap(root.canonical_path, input.target.path, input.target.volume) || (root.id !== input.downloadRootId && pathsOverlap(root.canonical_path, input.source.path, input.source.volume)));
    if (downloadOverlap) throw new DesktopError("UNSAFE_PATH", `所选目录与受管下载目录重叠，请在对应网盘来源配置整理或选择独立目录（关联下载目录：${downloadOverlap.id}）`, false, undefined, { reason: "DOWNLOAD_ROOT_OVERLAP", conflict: { kind: "download-root", id: downloadOverlap.id } });
    if (input.mode === "managed") {
      const root = db.prepare("SELECT * FROM managed_download_root WHERE id=? AND state='AVAILABLE'").get(input.downloadRootId) as { canonical_path: string; volume_identity: string } | undefined;
      if (!root || root.canonical_path !== input.source.path || !sameVolumeRoot(JSON.parse(root.volume_identity), input.source.volume)) throw new DesktopError("LOCAL_UNAVAILABLE", "受管下载原卷尚未就绪", true);
    } else if (input.downloadRootId) throw conflict();
    const previous = db.prepare("SELECT * FROM ingestion_source WHERE source_id=?").get(input.sourceId) as SourceRow | undefined;
    if (previous && (previous.mode !== input.mode || (JSON.parse(previous.source_grant_json).path === input.source.path && !sameVolumeRoot(JSON.parse(previous.source_grant_json).volume, input.source.volume)))) throw new DesktopError("LOCAL_UNAVAILABLE", "原卷身份不一致，请重新选择来源", true);
    const existing = db.prepare("SELECT grant_json FROM media_target_root WHERE id=?").get(input.target.id) as { grant_json: string } | undefined;
    if (existing && (JSON.parse(existing.grant_json).path !== input.target.path || !sameVolumeRoot(JSON.parse(existing.grant_json).volume, input.target.volume))) throw new DesktopError("LOCAL_UNAVAILABLE", "目标原卷身份不一致", true);
    const storedTargets = db.prepare("SELECT id,grant_json FROM media_target_root WHERE id!=?").all(input.target.id) as { id: string; grant_json: string }[];
    const sourceOverlap = storedTargets.find((row) => pathsOverlap(JSON.parse(row.grant_json).path, input.source.path, input.source.volume));
    if (sourceOverlap) throw new DesktopError("UNSAFE_PATH", `来源与历史媒体目标重叠，请选择独立输入目录（关联目标：${sourceOverlap.id}）`, false, undefined, { reason: "TARGET_OVERLAP", conflict: { kind: "media-target", id: sourceOverlap.id } });
    const targetOverlap = storedTargets.find((row) => pathsOverlap(JSON.parse(row.grant_json).path, input.target.path, input.target.volume));
    if (targetOverlap) throw new DesktopError("CONFLICT", `目标与历史操作保留的目录重叠，请使用原有目标授权或独立目录（关联目标：${targetOverlap.id}）`, false, undefined, { reason: "TARGET_OVERLAP", conflict: { kind: "media-target", id: targetOverlap.id } });
  }
  authorize(input: Authorization): Promise<{}> { return this.serialize(() => this.install(input)); }
  /** 异步取得资源后再提交配置；调用者在同一事务中写来源版本和执行关联。 */
  async prepareRuleSource(input: { id: string; name: string; client: Extract<SourceConfiguration, { type: "local" }>["client"]; mediaType: "AUTO" | "MOVIE" | "TV_SHOW"; source: ManagedRootGrant; target: ManagedRootGrant; downloadRootId: string | null }) {
    const db = this.database.connection;
    const original = db.prepare("SELECT version FROM desktop_source WHERE id=?").get(input.id) as { version: number } | undefined;
    const preserveManaged = !!input.downloadRootId && !!original;
    const nextVersion = preserveManaged ? original!.version : (original?.version ?? 0) + 1, mode = input.downloadRootId ? "managed" : "local";
    const sourcePath = mode === "managed" ? join(input.source.path, "completed") : input.source.path;
    const authorization: Authorization = { sourceId: input.id, sourceVersion: nextVersion, mode, downloadRootId: input.downloadRootId, source: input.source, target: input.target };
    const check = () => {
      const current = db.prepare("SELECT version FROM desktop_source WHERE id=?").get(input.id) as { version: number } | undefined;
      if (current?.version !== original?.version) throw conflict();
      if (db.prepare("SELECT 1 FROM ingestion_operation WHERE task_id IN (SELECT id FROM media_task WHERE source_id=?) AND phase NOT IN ('RECORDED','NEEDS_ATTENTION') LIMIT 1").get(input.id)) throw conflict("来源仍有活动整理，请等待当前文件到达安全点后重新确认");
      if (db.prepare("SELECT 1 FROM ingestion_accessory a JOIN ingestion_operation o ON o.id=a.operation_id JOIN media_task t ON t.id=o.task_id WHERE t.source_id=? AND a.phase NOT IN ('RECORDED','NEEDS_ATTENTION') LIMIT 1").get(input.id)) throw conflict("来源仍有附属文件整理，请等待安全点后重新确认");
      this.checkConfiguration(authorization, { version: nextVersion, source_path: sourcePath, target_path: input.target.path });
    };
    check();
    const source = await SourceRoot.open(input.source);
    try {
      // 原生授权独立于业务启用：先验证真实目录并登记未启用的授权，避免事务失败后遗留无主标记。
      const target = await ManagedRoot.open(input.target, "direct"); await target.close(); check();
      db.prepare("INSERT INTO media_target_root(id,grant_json,available) VALUES(?,?,0) ON CONFLICT(id) DO NOTHING").run(input.target.id, JSON.stringify(input.target));
      await this.targets.install(input.target); check();
    }
    catch (error) { await source.close(); throw error; }
    let committed = false;
    return {
      commit: () => {
        if (!db.inTransaction) throw new Error("来源配置必须在事务中提交");
        check();
        if (!preserveManaged) db.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,version,paused,health,created_at) VALUES(?,?,?,?,?,?,'COPY',?,0,'available',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,source_path=excluded.source_path,target_path=excluded.target_path,media_type=excluded.media_type,version=excluded.version,paused=0,health='available'")
          .run(input.id, input.name, input.client, sourcePath, input.target.path, input.mediaType, nextVersion, timestamp(this.now));
        db.prepare("INSERT INTO media_target_root(id,grant_json,available) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET grant_json=excluded.grant_json,available=1").run(input.target.id, JSON.stringify(input.target));
        if (!preserveManaged) db.prepare("INSERT INTO ingestion_source(source_id,mode,download_root_id,source_grant_json,target_root_id,source_version,available) VALUES(?,?,?,?,?,?,1) ON CONFLICT(source_id) DO UPDATE SET mode=excluded.mode,download_root_id=excluded.download_root_id,source_grant_json=excluded.source_grant_json,target_root_id=excluded.target_root_id,source_version=excluded.source_version,available=1")
          .run(input.id, mode, input.downloadRootId, JSON.stringify(input.source), input.target.id, nextVersion);
        else { db.prepare("UPDATE ingestion_source SET source_grant_json=?,available=1 WHERE source_id=?").run(JSON.stringify(input.source), input.id); db.prepare("UPDATE desktop_source SET paused=0,health='available' WHERE id=?").run(input.id); }
        committed = true;
        return { sourceId: input.id, targetRootId: input.target.id };
      },
      activate: async () => {
        if (!committed) throw new Error("来源配置尚未提交");
        const previous = this.sources.get(input.id); this.sources.set(input.id, source); this.scanControllers.get(input.id)?.abort();
        if (preserveManaged) this.sourceRuleChanged(input.id); else this.sourceChanged(input.id);
        this.watchSource(input.id, input.source.path);
        await previous?.close();
      },
      discard: () => source.close(),
    };
  }
  private async install(input: Authorization) {
    this.checkConfiguration(input);
    const source = await SourceRoot.open(input.source);
    try {
      await this.targets.install(input.target); this.checkConfiguration(input);
      this.database.connection.transaction(() => {
        this.database.connection.prepare("INSERT INTO media_target_root(id,grant_json,available) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET grant_json=excluded.grant_json,available=1").run(input.target.id, JSON.stringify(input.target));
        this.database.connection.prepare("INSERT INTO ingestion_source(source_id,mode,download_root_id,source_grant_json,target_root_id,source_version,available) VALUES(?,?,?,?,?,?,1) ON CONFLICT(source_id) DO UPDATE SET mode=excluded.mode,download_root_id=excluded.download_root_id,source_grant_json=excluded.source_grant_json,target_root_id=excluded.target_root_id,source_version=excluded.source_version,available=1").run(input.sourceId, input.mode, input.downloadRootId, JSON.stringify(input.source), input.target.id, input.sourceVersion);
        this.database.connection.prepare("UPDATE desktop_source SET health='available' WHERE id=?").run(input.sourceId);
      })();
      const previous = this.sources.get(input.sourceId); this.sources.set(input.sourceId, source); await previous?.close();
      this.watchSource(input.sourceId, input.source.path);
      for (const row of this.database.connection.prepare("SELECT id FROM ingestion_candidate WHERE source_id=?").all(input.sourceId) as { id: string }[]) this.observations.delete(row.id);
      return {};
    } catch (error) { await source.close(); throw error; }
  }
  configureManaged(input: PrivateCoreInput<"media.sources.configure-managed">): Promise<string> { return this.serialize(async () => {
    const db = this.database.connection, existing = db.prepare(sourceQuery + " WHERE i.download_root_id=?").get(input.downloadRootId) as SourceRow | undefined;
    if (existing && db.prepare("SELECT 1 FROM source_rule_version WHERE ingestion_source_id=? LIMIT 1").get(existing.source_id)) throw conflict("请通过统一来源配置修改整理绑定");
    const sourceId = existing?.source_id ?? randomUUID(), current = timestamp(this.now), sourcePath = join(input.source.path, "completed");
    const version = existing ? existing.version + 1 : 1, authorization: Authorization = { sourceId, sourceVersion: version, mode: "managed", downloadRootId: input.downloadRootId, source: input.source, target: input.target };
    this.checkConfiguration(authorization, { version, source_path: sourcePath, target_path: input.target.path });
    const original = db.prepare("SELECT name,target_path,media_type,version,health FROM desktop_source WHERE id=?").get(sourceId) as { name: string; target_path: string; media_type: string; version: number; health: string } | undefined;
    // 配置失败的草稿保持未授权，不会自动扫描或复制。
    if (existing) db.prepare("UPDATE desktop_source SET name=?,target_path=?,media_type=?,version=version+1,health='unverified' WHERE id=?").run(input.name, input.target.path, input.mediaType, sourceId);
    else db.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,?,'custom',?,?,?,'COPY',?)").run(sourceId, input.name, sourcePath, input.target.path, input.mediaType, current);
    try { await this.install(authorization); }
    catch (error) {
      if (original) db.prepare("UPDATE desktop_source SET name=?,target_path=?,media_type=?,version=?,health=? WHERE id=? AND version=?").run(original.name, original.target_path, original.media_type, original.version, original.health, sourceId, version);
      else if (!db.prepare("SELECT 1 FROM ingestion_source WHERE source_id=?").get(sourceId)) db.prepare("DELETE FROM desktop_source WHERE id=? AND version=?").run(sourceId, version);
      throw error;
    }
    db.prepare("UPDATE ingestion_outbox SET delivery_attempts=0,next_attempt_at=NULL WHERE state='PENDING' AND item_id IN (SELECT id FROM download_item WHERE target_root_id=?)").run(input.downloadRootId);
    return sourceId;
  }); }
  private source(id: string) {
    if (this.pauseStatus().paused) throw conflict("全部整理已暂停，请先恢复整理");
    const row = this.database.connection.prepare(sourceQuery + " WHERE i.source_id=?").get(id) as SourceRow | undefined;
    if (!row || !row.available || row.source_version !== row.version || !this.sources.has(id)) throw new DesktopError("LOCAL_UNAVAILABLE", "来源需重新授权或原卷尚未就绪", true);
    const owner = recognitionOwner(this.database, id);
    if (row.paused || owner?.paused || owner?.deleted_at || !owner && this.database.connection.prepare("SELECT 1 FROM source_rule WHERE local_source_id=? AND deleted_at IS NOT NULL").get(id)) throw conflict("识别输入已暂停或已删除，请恢复对应识别规则"); return row;
  }
  private checkContentReview(id: string, version: number) {
    if (this.closed) throw new DesktopError("INTERRUPTED", "内容复核正在停止", true);
    const row = this.database.connection.prepare(sourceQuery + " WHERE i.source_id=?").get(id) as SourceRow | undefined;
    const owner = recognitionOwner(this.database, id);
    if (!row || row.mode !== "local" || owner?.mode === "managed-completed") throw conflict("全量内容复核仅用于普通已有目录；受管输入请补扫正式成功收据，不将外部文件当作同步成果");
    if (owner && (!owner.active || owner.deleted_at)) throw conflict("识别输入已切换或规则已删除，请先核对当前配置");
    if (!owner && this.database.connection.prepare("SELECT 1 FROM source_rule WHERE local_source_id=? AND review_required=1").get(id)) throw conflict("来源归属待核对，请先在来源配置重新预览确认");
    if (row.version !== version || row.source_version !== version) throw conflict("来源配置已变化，本次复核已停止；请按新配置重新发起");
    if (row.paused || this.pauseStatus().paused) throw new DesktopError("LOCAL_UNAVAILABLE", "来源或全部整理已暂停；恢复后继续只读复核", true);
    if (!row.available || !this.sources.has(id)) throw new DesktopError("LOCAL_UNAVAILABLE", "来源原磁盘尚未恢复；请连接原盘并核对权限后继续复核", true);
    const db = this.database.connection;
    if (db.prepare("SELECT 1 FROM ingestion_operation o JOIN ingestion_candidate c ON c.id=o.candidate_id WHERE c.source_id=? AND (o.phase NOT IN ('RECORDED','NEEDS_ATTENTION') OR EXISTS(SELECT 1 FROM ingestion_accessory a WHERE a.operation_id=o.id AND a.phase NOT IN ('RECORDED','NEEDS_ATTENTION'))) LIMIT 1").get(id)) throw conflict("来源仍有活动整理，请等待当前文件及附属文件到达安全点后复核内容");
  }
  reviewContent(input: CoreInput<"ingestion.review-content">) {
    const row = this.database.connection.prepare(sourceQuery + " WHERE i.source_id=?").get(input.sourceId) as SourceRow | undefined;
    if (!row) throw conflict("本地整理来源不存在，请检查来源配置");
    return this.contentReviews.enqueue(row.source_id, row.version, input.requestKey);
  }
  private assertCandidateCurrent(row: CandidateRow) {
    if (this.contentReviews.active(row.source_id)) throw conflict("该来源正在全量复核内容，请等待完成或取消后重新预览");
    const current = this.candidate(row.id);
    if (!current.managed_item_id && !current.is_current) throw conflict("该资产已有新版本，请选择新候选重新观察和预览");
  }
  private newLocalVersion(sourceId: string, relative: string[], snapshot: SourceSnapshot, sha256: string | null, skipReason?: string) {
    const db = this.database.connection, id = randomUUID(), path = JSON.stringify(relative), stamp = timestamp(this.now), attributes = sourceVersion(snapshot);
    // 历史任务与已执行计划保留；未执行的旧候选失去领取权，返回旧内容也生成新一代版本。
    db.prepare("UPDATE media_task SET status='SKIPPED',updated_at=? WHERE id IN (SELECT c.task_id FROM ingestion_candidate c WHERE c.source_id=? AND c.relative_json=? AND c.is_current=1 AND NOT EXISTS(SELECT 1 FROM ingestion_operation o WHERE o.candidate_id=c.id)) AND status!='DONE'").run(stamp, sourceId, path);
    db.prepare("UPDATE ingestion_candidate SET is_current=0,state=CASE WHEN state IN ('PROCESSED','SKIPPED') OR EXISTS(SELECT 1 FROM ingestion_operation o WHERE o.candidate_id=ingestion_candidate.id) THEN state ELSE 'SUPERSEDED' END,reason=CASE WHEN state='PROCESSED' THEN reason ELSE '已发现新资产版本，旧版本不再领取' END,updated_at=? WHERE source_id=? AND relative_json=? AND is_current=1").run(stamp, sourceId, path);
    const skip = !!skipReason || (!video.test(relative.at(-1)!) && !temporary.test(relative.at(-1)!)) || relative.some((part) => /^(?:BDMV|VIDEO_TS)$/i.test(part));
    db.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,attribute_key,is_current,snapshot_json,expected_sha256,state,reason,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)").run(id, sourceId, path, fingerprint([attributes, sha256, id]), attributes, JSON.stringify(snapshot), sha256, skip ? "SKIPPED" : "OBSERVING", skipReason ?? (skip ? "此项不能作为普通视频识别；音乐、ISO 和蓝光目录首版不支持" : "等待文件稳定至少 120 秒"), stamp, stamp);
    return this.candidate(id);
  }
  private async prepareContentReview(id: string, version: number, relative: string[], signal: AbortSignal) {
    this.checkContentReview(id, version);
    const source = this.sources.get(id)!, sourceRow = this.source(id);
    if (this.ignored(sourceRow)(relative)) throw conflict("文件已不在当前扫描范围，请按新配置重新复核");
    const snapshot = await source.inspect(relative);
    if (!snapshot.size) throw conflict("文件为零字节，等待写入完成后重新复核");
    const observed = this.database.connection.prepare("SELECT id FROM ingestion_candidate WHERE source_id=? AND relative_json=? AND is_current=1 AND managed_item_id IS NULL").get(id, JSON.stringify(relative)) as { id: string } | undefined;
    let sha256 = "";
    await source.read(relative, snapshot, async (handle) => { sha256 = await source.digest(handle, snapshot.size, signal); if (sha256 !== await source.digest(handle, snapshot.size, signal)) throw conflict("文件在复核时继续写入，请等待下载完成后重新复核"); });
    return () => {
      this.checkContentReview(id, version);
      const db = this.database.connection, previous = db.prepare("SELECT * FROM ingestion_candidate WHERE source_id=? AND relative_json=? AND is_current=1 AND managed_item_id IS NULL").get(id, JSON.stringify(relative)) as CandidateRow | undefined;
      if (previous && previous.attribute_key !== sourceVersion(snapshot) && previous.id !== observed?.id) throw conflict("扫描已发现更新的文件版本，请重新复核");
      if (!previous || previous.attribute_key !== sourceVersion(snapshot)) {
        const candidate = this.newLocalVersion(id, relative, snapshot, sha256); this.observeWindow(this.observations, candidate.id, candidate.version_key);
        return { state: "BASELINED" as const, candidateId: candidate.id, sha256 };
      }
      if (!previous.expected_sha256) { db.prepare("UPDATE ingestion_candidate SET expected_sha256=? WHERE id=?").run(sha256, previous.id); return { state: "BASELINED" as const, candidateId: previous.id, sha256 }; }
      if (previous.expected_sha256 === sha256) return { state: "UNCHANGED" as const, candidateId: previous.id, sha256 };
      this.observations.delete(previous.id);
      const candidate = this.newLocalVersion(id, relative, snapshot, sha256); this.observeWindow(this.observations, candidate.id, candidate.version_key);
      return { state: "CHANGED" as const, candidateId: candidate.id, sha256 };
    };
  }
  private candidate(id: string) { const row = this.database.connection.prepare("SELECT * FROM ingestion_candidate WHERE id=?").get(id) as CandidateRow | undefined; if (!row) throw conflict("候选文件已不存在"); return row; }
  private candidatePolicy(row: CandidateRow) { return this.database.connection.prepare("SELECT policy_key,configuration_json,target_root_id FROM ingestion_candidate_policy WHERE candidate_id=?").get(row.id) as { policy_key: string; configuration_json: string; target_root_id: string } | undefined; }
  private managedCandidateEnabled(row: CandidateRow) {
    const owner = recognitionOwner(this.database, row.source_id);
    if (owner) return !!owner.active && !owner.deleted_at && !owner.paused;
    if (!row.managed_item_id || !row.managed_version_key) return true;
    const policy = this.candidatePolicy(row), current = resolveManagedOrganization(this.database, row.managed_item_id, row.managed_version_key);
    return policy ? current.state === "ENABLED" && current.policy.key === policy.policy_key : current.state === "LEGACY";
  }
  private candidateSource(row: CandidateRow): SourceRow {
    const source = this.source(row.source_id), policy = this.candidatePolicy(row);
    if (!this.managedCandidateEnabled(row)) throw conflict("来源暂停、配置变化或历史归属待核对，请核对整理需求");
    if (recognitionOwner(this.database, row.source_id)) return { ...source, media_type: "AUTO" };
    if (!policy) return source;
    const configuration = JSON.parse(policy.configuration_json) as OrganizationConfiguration;
    return { ...source, policy_key: policy.policy_key, media_type: configuration.mediaType, target_root_id: policy.target_root_id, target_path: configuration.targetPath };
  }
  private operationRunnable(operation: OperationRow) {
    if (this.correctionLeases.has(operation.task_id) || this.database.connection.prepare("SELECT 1 FROM correction_item WHERE task_id=? AND state IN ('PENDING','RUNNING','NEEDS_ATTENTION')").get(operation.task_id) || this.database.connection.prepare("SELECT 1 FROM media_task WHERE id=? AND status='CORRECTED'").get(operation.task_id)) return false;
    const candidate = this.candidate(operation.candidate_id);
    if (this.contentReviews.active(candidate.source_id)) return false;
    const plan = JSON.parse(operation.plan_json) as Plan;
    if (plan.recognitionSnapshot || recognitionOwner(this.database, plan.sourceId)) { const rule = this.database.connection.prepare("SELECT paused,deleted_at FROM recognition_rule WHERE id=?").get(plan.recognitionSnapshot?.ruleId ?? recognitionOwner(this.database, plan.sourceId)!.rule_id) as { paused: number; deleted_at: string | null } | undefined; return !!rule && !rule.paused && !rule.deleted_at; }
    return this.managedCandidateEnabled(candidate) || (!!candidate.managed_item_id && !this.candidatePolicy(candidate) && ["COPYING", "VERIFIED", "FILE_COMMITTED"].includes(operation.phase));
  }
  private operationSource(operation: OperationRow, plan: Plan) {
    if (plan.recognitionSnapshot || recognitionOwner(this.database, plan.sourceId)) {
      const row = this.database.connection.prepare(sourceQuery + " WHERE i.source_id=?").get(plan.sourceId) as SourceRow | undefined;
      const rule = this.database.connection.prepare("SELECT paused,deleted_at FROM recognition_rule WHERE id=?").get(plan.recognitionSnapshot?.ruleId ?? recognitionOwner(this.database, plan.sourceId)!.rule_id) as { paused: number; deleted_at: string | null } | undefined;
      if (!row || !rule || rule.paused || rule.deleted_at || this.pauseStatus().paused) throw conflict("原识别规则或全局整理已暂停，已受理计划保留原目标，恢复后继续");
      // 已验收的暂存／正式证据不再依赖输入在线；未开始复制仍核对原卷与文件版本。
      return { ...row, version: plan.sourceVersion, media_type: plan.selection.mediaType, target_root_id: plan.target.id, target_path: plan.target.path };
    }
    const candidate = this.candidate(plan.candidateId);
    if (candidate.managed_item_id && !this.candidatePolicy(candidate) && !this.managedCandidateEnabled(candidate) && this.operationRunnable(operation)) {
      // 已开始的旧人工确认操作只沿原计划恢复，不能把未知历史重新套用当前根级策略。
      return { ...this.source(plan.sourceId), policy_key: `legacy:${operation.id}`, media_type: plan.selection.mediaType, target_root_id: plan.target.id, target_path: plan.target.path };
    }
    return this.candidateSource(candidate);
  }
  canAccept(input: { itemId: string; versionKey: string }) {
    const independent = this.database.connection.prepare("SELECT i.source_id,r.paused,r.deleted_at,p.candidate_id FROM download_item d JOIN recognition_input i ON i.directory_id=d.target_root_id AND i.active=1 AND i.mode='managed-completed' JOIN recognition_rule r ON r.id=i.rule_id LEFT JOIN sync_receipt s ON s.result_kind='download-item' AND s.result_id=d.id LEFT JOIN recognition_receipt p ON p.receipt_id=s.id WHERE d.id=? AND d.version_key=?").get(input.itemId, input.versionKey) as { source_id: string; paused: number; deleted_at: string | null; candidate_id: string | null } | undefined;
    if (independent) { if (independent.candidate_id) return true; if (independent.paused || independent.deleted_at || this.closed || this.pauseStatus().paused) return false; try { this.source(independent.source_id); return true; } catch { return false; } }
    if (this.database.connection.prepare("SELECT 1 FROM ingestion_candidate WHERE managed_item_id=? AND managed_version_key=?").get(input.itemId, input.versionKey)) return true;
    if (this.closed || this.pauseStatus().paused) return false;
    const resolved = resolveManagedOrganization(this.database, input.itemId, input.versionKey);
    if (resolved.state !== "ENABLED" && resolved.state !== "LEGACY") return false;
    try { this.source(resolved.state === "ENABLED" ? resolved.policy.sourceId : resolved.sourceId); return true; } catch { return false; }
  }
  private watchSource(id: string, path: string) {
    const previous = this.watches.get(id); if (previous) { clearTimeout(previous.timer); previous.watcher.close(); this.watches.delete(id); }
    if (this.closed || this.pauseStatus().paused || (this.database.connection.prepare("SELECT paused FROM desktop_source WHERE id=?").get(id) as { paused: number } | undefined)?.paused) return;
    try {
      const watcher = this.watchFiles(path, { recursive: true }, (_event, filename) => {
        if (this.closed || filename?.split(/[/\\]/).some((part) => part.normalize("NFC").toLowerCase() === ".media-marshal")) return;
        const owned = this.watches.get(id); if (!owned || owned.timer) return;
        owned.timer = setTimeout(() => { owned.timer = undefined; if (!this.closed) void this.scan(id).catch(() => {}); }, 500);
      });
      watcher.on("error", () => { const owned = this.watches.get(id); if (owned?.watcher === watcher) { clearTimeout(owned.timer); watcher.close(); this.watches.delete(id); } });
      this.watches.set(id, { watcher });
    } catch { /* 事件只是提示；不支持递归监听的环境仍用相同就绪规则定时补扫。 */ }
  }
  private ignored(source: SourceRow) {
    const independent = recognitionSnapshot(this.database, source.source_id);
    if (independent) return discoveryIgnore(independent.configuration.ignoredFilePatterns);
    if (source.mode !== "local") return () => false;
    const cached = this.ignorePolicies.get(source.source_id); if (cached?.version === source.version) return cached.ignored;
    const row = this.database.connection.prepare("SELECT v.configuration_json FROM source_rule s JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version WHERE s.local_source_id=?").get(source.source_id) as { configuration_json: string } | undefined;
    const configuration = row ? sourceConfigurationSchema.parse(JSON.parse(row.configuration_json)) : null;
    const ignored = discoveryIgnore(configuration?.type === "local" ? configuration.ignoredFilePatterns : null);
    this.ignorePolicies.set(source.source_id, { version: source.version, ignored }); return ignored;
  }
  private async observe(row: CandidateRow, check?: () => void, frozenSource?: SourceRow, frozenPatterns?: string[] | null) {
    check?.();
    if (!row.managed_item_id && !this.candidate(row.id).is_current) return false;
    const configuration = frozenSource ?? this.candidateSource(row), relative: string[] = JSON.parse(row.relative_json), source = this.sources.get(row.source_id)!;
    if ((frozenSource ? frozenPatterns === undefined ? () => false : discoveryIgnore(frozenPatterns) : this.ignored(configuration))(relative)) {
      this.observations.delete(row.id);
      this.database.connection.prepare("UPDATE ingestion_candidate SET state=CASE WHEN state='READY' THEN 'OBSERVING' ELSE state END,reason='文件符合当前来源的忽略规则，请在来源配置核对后重新预览' WHERE id=? AND state NOT IN ('PROCESSED','SKIPPED','SUPERSEDED')").run(row.id);
      return false;
    }
    let snapshot: SourceSnapshot;
    try { snapshot = await source.inspect(JSON.parse(row.relative_json)); check?.(); }
    catch { check?.(); this.observations.delete(row.id); this.database.connection.prepare("UPDATE ingestion_candidate SET state='UNAVAILABLE',reason='文件不可访问，未将其当作删除',updated_at=? WHERE id=? AND state NOT IN ('PROCESSED','SKIPPED','SUPERSEDED')").run(timestamp(this.now), row.id); throw new DesktopError("LOCAL_UNAVAILABLE", "来源文件不可访问，等待原卷或文件恢复", true); }
    if (!sameSnapshot(snapshot, sourceSnapshotSchema.parse(JSON.parse(row.snapshot_json)))) {
      this.observations.delete(row.id); this.database.connection.prepare("UPDATE ingestion_candidate SET state='SUPERSEDED',reason='来源版本已变化',updated_at=? WHERE id=? AND state NOT IN ('PROCESSED','SKIPPED')").run(timestamp(this.now), row.id); throw conflict();
    }
    const latest = this.candidate(row.id); if (!latest.managed_item_id && !latest.is_current) return false;
    const { now, current } = this.observeWindow(this.observations, row.id, row.version_key);
    const temporaryName = temporary.test(relative.at(-1)!), ready = snapshot.size > 0 && !temporaryName && now - current.since >= 120000;
    const reason = snapshot.size === 0 ? "文件为零字节，等待下载写入" : temporaryName ? "文件仍使用下载临时名称，等待正式文件后重新观察" : ready ? "未经验证的下载行为，请确认文件已完整下载" : "等待文件稳定至少 120 秒";
    if (!["QUEUED", "PROCESSED", "SKIPPED", "SUPERSEDED"].includes(latest.state)) this.database.connection.prepare("UPDATE ingestion_candidate SET state=?,reason=?,updated_at=? WHERE id=?").run(ready ? "READY" : "OBSERVING", reason, timestamp(this.now), row.id);
    return ready;
  }
  private async receive(sourceId: string, relative: string[], managed?: { itemId: string; versionKey: string; sha256: string; size: number; policy?: ManagedOrganization }, skipReason?: string, check?: () => void) {
    check?.();
    const source = this.source(sourceId), snapshot = await this.sources.get(sourceId)!.inspect(relative), version = sourceVersion(snapshot), db = this.database.connection;
    check?.();
    if (managed && snapshot.size !== managed.size) throw conflict();
    if (managed?.policy) { const current = resolveManagedOrganization(this.database, managed.itemId, managed.versionKey); if (current.state !== "ENABLED" || current.policy.key !== managed.policy.key) throw conflict("整理需求已暂停或变化，请核对来源"); }
    if (associated.test(relative.at(-1)!)) await this.observeAccessory(sourceId, relative, undefined, managed?.policy?.key);
    check?.();
    let previous = managed ? db.prepare("SELECT * FROM ingestion_candidate WHERE managed_item_id=? AND managed_version_key=?").get(managed.itemId, managed.versionKey) as CandidateRow | undefined : undefined;
    if (previous && previous.version_key !== version) throw conflict("受管下载文件已被修改，请核验下载成果");
    if (previous && managed?.policy && this.candidatePolicy(previous)?.policy_key !== managed.policy.key) throw conflict("既有候选的整理策略不同或证据不足，请核对原操作");
    if (!managed) previous = db.transaction(() => {
      const current = db.prepare("SELECT * FROM ingestion_candidate WHERE source_id=? AND relative_json=? AND is_current=1 AND managed_item_id IS NULL").get(sourceId, JSON.stringify(relative)) as CandidateRow | undefined;
      return current?.attribute_key === version ? current : this.newLocalVersion(sourceId, relative, snapshot, null, skipReason);
    })();
    else previous ??= db.prepare("SELECT * FROM ingestion_candidate WHERE source_id=? AND relative_json=? AND version_key=?").get(source.source_id, JSON.stringify(relative), version) as CandidateRow | undefined;
    if (previous && skipReason && previous.state !== "PROCESSED" && !db.prepare("SELECT 1 FROM ingestion_operation WHERE candidate_id=?").get(previous.id)) {
      const candidate = previous;
      db.transaction(() => {
        db.prepare("UPDATE ingestion_candidate SET state='SKIPPED',reason=?,updated_at=? WHERE id=?").run(skipReason, timestamp(this.now), candidate.id);
        if (candidate.task_id) db.prepare("UPDATE media_task SET status='SKIPPED',updated_at=? WHERE id=? AND status!='DONE'").run(timestamp(this.now), candidate.task_id);
      })(); this.observations.delete(previous.id); return { candidateId: previous.id };
    }
    if (!previous) {
      const id = randomUUID(), current = timestamp(this.now), skip = !!skipReason || (!video.test(relative.at(-1)!) && !temporary.test(relative.at(-1)!)) || relative.some((part) => /^(?:BDMV|VIDEO_TS)$/i.test(part));
      db.transaction(() => {
        db.prepare("UPDATE ingestion_candidate SET state='SUPERSEDED',reason='已发现新版本',updated_at=? WHERE source_id=? AND relative_json=? AND version_key!=? AND state IN ('OBSERVING','READY','UNAVAILABLE')").run(current, sourceId, JSON.stringify(relative), version);
        db.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,attribute_key,snapshot_json,expected_sha256,managed_item_id,managed_version_key,state,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, sourceId, JSON.stringify(relative), version, version, JSON.stringify(snapshot), managed?.sha256 ?? null, managed?.itemId ?? null, managed?.versionKey ?? null, skip ? "SKIPPED" : "OBSERVING", skipReason ?? (skip ? "此项不能作为普通视频识别；音乐、ISO 和蓝光目录首版不支持" : "等待文件稳定至少 120 秒"), current, current);
        if (managed?.policy) db.prepare("INSERT INTO ingestion_candidate_policy VALUES(?,?,?,?)").run(id, managed.policy.key, JSON.stringify(managed.policy.configuration), managed.policy.targetRootId);
      })(); previous = this.candidate(id);
    }
    if (!["PROCESSED", "SKIPPED", "SUPERSEDED"].includes(previous.state)) await this.observe(previous, check);
    return { candidateId: previous.id };
  }
  private async receiveReceipt(sourceId: string, receiptId: string, skipReason?: string, check?: () => void) {
    const db = this.database.connection, owner = recognitionOwner(this.database, sourceId);
    if (!owner?.active || owner.mode !== "managed-completed") throw conflict("成果尚未被独立识别输入接管");
    const row = db.prepare("SELECT r.*,e.evidence_json FROM sync_receipt r LEFT JOIN sync_receipt_evidence e ON e.receipt_id=r.id WHERE r.id=? AND r.target_directory_id=?").get(receiptId, owner.directory_id) as { target_segments_json: string; local_sha256: string; size: number; evidence_json: string | null } | undefined;
    if (!row) throw conflict("正式同步成功收据已不存在，请核对原任务；不会补下载");
    const relative = ["completed", ...JSON.parse(row.target_segments_json)], previous = db.prepare("SELECT candidate_id FROM recognition_receipt WHERE receipt_id=?").get(receiptId) as { candidate_id: string | null } | undefined;
    try {
      check?.(); this.source(sourceId); const source = this.sources.get(sourceId)!, snapshot = await source.inspect(relative); check?.();
      const evidence = row.evidence_json ? localFileEvidenceSchema.parse(JSON.parse(row.evidence_json)) : null;
      if (!evidence || evidence.volumeId !== source.grant.volume.volumeId || evidence.inode !== snapshot.inode || evidence.birthtimeNs !== snapshot.birthtimeNs || evidence.modifiedNs !== snapshot.modifiedNs || evidence.size !== snapshot.size || row.size !== snapshot.size || evidence.sha256 !== row.local_sha256) throw conflict("正式成果与原成功收据的文件身份不一致，请核对原同步文件，识别不会补下载或接管外部替换文件");
      let candidate = previous?.candidate_id ? this.candidate(previous.candidate_id) : db.prepare("SELECT * FROM ingestion_candidate WHERE source_id=? AND relative_json=? AND is_current=1 ORDER BY created_at DESC LIMIT 1").get(sourceId, JSON.stringify(relative)) as CandidateRow | undefined;
      if (candidate && (!sameSnapshot(JSON.parse(candidate.snapshot_json), snapshot) || candidate.expected_sha256 && candidate.expected_sha256 !== evidence.sha256)) throw conflict("成果候选在接入后已有变化，请核对原文件和任务，未创建重复候选");
      if (!previous?.candidate_id) await source.read(relative, snapshot, async (handle) => { if ((await handle.stat()).nlink !== 1) throw conflict("正式成果正在清理提交暂存或存在额外硬链接，请等待同步收尾后补扫"); if (await source.digest(handle, snapshot.size, this.controller?.signal ?? new AbortController().signal) !== evidence.sha256) throw conflict("正式成果摘要与成功收据不一致，请保留原文件并核对同步任务"); });
      check?.(); this.source(sourceId);
      const result = db.transaction(() => {
        const latestOwner = recognitionOwner(this.database, sourceId); if (!latestOwner || latestOwner.rule_id !== owner.rule_id || latestOwner.version !== owner.version || latestOwner.paused || latestOwner.deleted_at) throw conflict("识别接管在读取期间变化，请按当前配置补扫");
        const joined = db.prepare("SELECT c.* FROM recognition_receipt r JOIN ingestion_candidate c ON c.id=r.candidate_id WHERE r.receipt_id=?").get(receiptId) as CandidateRow | undefined;
        candidate = joined ?? db.prepare("SELECT * FROM ingestion_candidate WHERE source_id=? AND relative_json=? AND is_current=1 ORDER BY created_at DESC LIMIT 1").get(sourceId, JSON.stringify(relative)) as CandidateRow | undefined;
        if (candidate && (!sameSnapshot(JSON.parse(candidate.snapshot_json), snapshot) || candidate.expected_sha256 && candidate.expected_sha256 !== evidence.sha256)) throw conflict("成果在并发交接期间变化，请核对原任务");
        if (!candidate) candidate = this.newLocalVersion(sourceId, relative, snapshot, evidence.sha256, skipReason);
        else if (!candidate.expected_sha256) db.prepare("UPDATE ingestion_candidate SET expected_sha256=? WHERE id=? AND expected_sha256 IS NULL").run(evidence.sha256, candidate.id);
        db.prepare("INSERT INTO recognition_receipt VALUES(?,?,?,'ACCEPTED',NULL,?) ON CONFLICT(receipt_id) DO UPDATE SET candidate_id=excluded.candidate_id,state='ACCEPTED',failure=NULL,updated_at=excluded.updated_at").run(receiptId, sourceId, candidate.id, timestamp(this.now));
        return { candidateId: candidate.id };
      })();
      if (associated.test(relative.at(-1)!)) await this.observeAccessory(sourceId, relative, undefined, "local", check);
      else if (!["PROCESSED", "SKIPPED", "SUPERSEDED"].includes(this.candidate(result.candidateId).state)) await this.observe(this.candidate(result.candidateId), check);
      return result;
    } catch (error) {
      check?.(); const reason = error instanceof DesktopError ? error.message.slice(0, 500) : "正式成果不可读取，请恢复原输入卷、目录和文件后补扫；识别不会要求重新下载";
      db.transaction(() => { db.prepare("INSERT INTO recognition_receipt VALUES(?,?,?,'UNAVAILABLE',?,?) ON CONFLICT(receipt_id) DO UPDATE SET state='UNAVAILABLE',failure=excluded.failure,updated_at=excluded.updated_at").run(receiptId, sourceId, previous?.candidate_id ?? null, reason, timestamp(this.now)); if (previous?.candidate_id) db.prepare("UPDATE ingestion_candidate SET state='UNAVAILABLE',reason=? WHERE id=? AND state NOT IN ('PROCESSED','SKIPPED','SUPERSEDED')").run(reason, previous.candidate_id); })();
      throw error;
    }
  }
  async accept(input: Parameters<ManagedIngestionSink["accept"]>[0], signal: AbortSignal) {
    const independent = this.database.connection.prepare("SELECT i.source_id,s.id FROM recognition_input i JOIN sync_receipt s ON s.target_directory_id=i.directory_id AND s.result_kind='download-item' JOIN download_item d ON d.id=s.result_id JOIN recognition_rule r ON r.id=i.rule_id WHERE i.mode='managed-completed' AND i.active=1 AND r.deleted_at IS NULL AND d.id=? AND d.version_key=? AND s.target_directory_id=?").get(input.itemId, input.versionKey, input.rootId) as { source_id: string; id: string } | undefined;
    if (independent) {
      const receipt = this.database.connection.prepare("SELECT target_segments_json,local_sha256,size FROM sync_receipt WHERE id=?").get(independent.id) as { target_segments_json: string; local_sha256: string; size: number };
      if (receipt.target_segments_json !== JSON.stringify(input.completedSegments) || receipt.local_sha256 !== input.sha256 || receipt.size !== input.size) throw conflict("完成交接与成功收据不一致，请核对原同步任务");
      const prior = this.database.connection.prepare("SELECT candidate_id FROM recognition_receipt WHERE receipt_id=? AND state='ACCEPTED'").get(independent.id) as { candidate_id: string } | undefined;
      if (prior?.candidate_id) return { candidateId: prior.candidate_id };
      return this.receiveReceipt(independent.source_id, independent.id, undefined, () => { if (signal.aborted || this.closed) throw new DesktopError("INTERRUPTED", "完成交接已中断，恢复后补查成功收据", true); });
    }
    if (this.closed || signal.aborted) throw new DesktopError("INTERRUPTED", "候选接收已中断", true);
    const db = this.database.connection;
    const committed = db.prepare("SELECT i.target_segments_json,c.file_evidence_json FROM download_item i JOIN download_commit_intent c ON c.item_id=i.id AND c.state='RECORDED' WHERE i.id=? AND i.version_key=? AND i.target_root_id=? AND i.state='COMPLETED'").get(input.itemId, input.versionKey, input.rootId) as { target_segments_json: string; file_evidence_json: string } | undefined;
    if (!committed || committed.target_segments_json !== JSON.stringify(input.completedSegments)) throw conflict();
    const evidence = localFileEvidenceSchema.parse(JSON.parse(committed.file_evidence_json));
    if (evidence.sha256 !== input.sha256 || evidence.size !== input.size) throw conflict();
    const previous = db.prepare("SELECT * FROM ingestion_candidate WHERE managed_item_id=? AND managed_version_key=?").get(input.itemId, input.versionKey) as CandidateRow | undefined;
    if (previous) {
      if (previous.expected_sha256 !== input.sha256 || sourceSnapshotSchema.parse(JSON.parse(previous.snapshot_json)).size !== input.size) throw conflict();
      let available = false; try { this.source(previous.source_id); available = true; } catch { /* 已接收候选的重复确认不创建新工作，可在暂停或缺盘时补记。 */ }
      if (available && this.managedCandidateEnabled(previous)) {
        const version = this.scanScope(previous.source_id).version;
        const checkExisting = () => { if (signal.aborted || this.closed) throw new DesktopError("INTERRUPTED", "候选观察已中断，原记录保留", true); if (this.source(previous.source_id).version !== version || !this.managedCandidateEnabled(previous)) throw conflict("整理来源或需求已变化，请重新补扫"); };
        if (associated.test((JSON.parse(previous.relative_json) as string[]).at(-1)!)) await this.observeAccessory(previous.source_id, JSON.parse(previous.relative_json), undefined, this.candidatePolicy(previous)?.policy_key, checkExisting);
        if (!["PROCESSED", "SKIPPED", "SUPERSEDED"].includes(previous.state)) await this.observe(previous, checkExisting);
      }
      return { candidateId: previous.id };
    }
    const resolved = resolveManagedOrganization(this.database, input.itemId, input.versionKey);
    if (resolved.state !== "ENABLED" && resolved.state !== "LEGACY") throw conflict(resolved.state === "NOT_ENABLED" ? "该完成项未启用整理" : "整理来源暂停或归属待核对，请确认来源配置");
    const sourceId = resolved.state === "ENABLED" ? resolved.policy.sourceId : resolved.sourceId;
    const row = db.prepare(sourceQuery + " WHERE i.source_id=? AND i.download_root_id=?").get(sourceId, input.rootId) as SourceRow | undefined;
    if (!row) throw conflict("受管整理来源尚未恢复");
    this.source(row.source_id);
    const current = await this.sources.get(row.source_id)!.inspect(["completed", ...input.completedSegments]);
    if (current.inode !== evidence.inode || current.birthtimeNs !== evidence.birthtimeNs || current.modifiedNs !== evidence.modifiedNs || current.size !== evidence.size) throw conflict("受管下载成果的文件身份已变化");
    const check = () => { if (signal.aborted || this.closed) throw new DesktopError("INTERRUPTED", "候选确认已中断，请查询原任务", true); if (this.source(row.source_id).version !== row.version) throw conflict("整理来源配置已变化，请重新补扫"); };
    const result = await this.receive(row.source_id, ["completed", ...input.completedSegments], { ...input, policy: resolved.state === "ENABLED" ? resolved.policy : undefined }, undefined, check);
    if (signal.aborted) throw new DesktopError("INTERRUPTED", "候选确认已中断，重试会复用原候选", true); return result;
  }
  scanScope(sourceId: string) {
    const row = this.database.connection.prepare("SELECT d.name,d.version,d.paused,i.available,i.source_version FROM desktop_source d JOIN ingestion_source i ON i.source_id=d.id WHERE d.id=?").get(sourceId) as { name: string; version: number; paused: number; available: number; source_version: number } | undefined;
    if (!row) throw conflict("整理来源不存在，请在来源页重新确认目录配置");
    return { name: row.name, version: row.version, paused: !!row.paused, available: !!row.available && row.source_version === row.version && this.sources.has(sourceId) };
  }
  scan(sourceId: string): Promise<ScanResult> {
    if (this.closed) return Promise.reject(new DesktopError("INTERRUPTED", "整理服务正在停止", true));
    const previous = this.scans.get(sourceId); if (previous) return previous;
    const controller = new AbortController(); this.scanControllers.set(sourceId, controller);
    const pending = this.scanSource(sourceId, controller.signal).finally(() => { if (this.scans.get(sourceId) === pending) { this.scans.delete(sourceId); this.scanControllers.delete(sourceId); } }); this.scans.set(sourceId, pending); return pending;
  }
  private unavailableSource(sourceId: string) {
    const db = this.database.connection;
    for (const row of db.prepare("SELECT id FROM ingestion_candidate WHERE source_id=?").all(sourceId) as { id: string }[]) this.observations.delete(row.id);
    for (const key of this.accessoryObservations.keys()) if (key.startsWith(sourceId + ":")) this.accessoryObservations.delete(key);
    db.prepare("UPDATE ingestion_candidate SET state='UNAVAILABLE',reason='来源目录不可访问，请连接原磁盘并检查权限；文件记录仍保留',updated_at=? WHERE source_id=? AND state IN ('OBSERVING','READY','UNAVAILABLE','QUEUED')").run(timestamp(this.now), sourceId);
  }
  private async scanSource(sourceId: string, signal: AbortSignal): Promise<ScanResult> {
    const row = this.source(sourceId), root = this.sources.get(sourceId), issues = new Map<string, string>(), checkedPaths: string[] = []; let discovered = 0;
    const check = () => { if (this.closed || signal.aborted) throw new DesktopError("INTERRUPTED", "扫描已中断，已发现候选保留；恢复后重新补扫", true); const latest = this.source(sourceId); if (latest.version !== row.version || this.sources.get(sourceId) !== root) throw conflict("来源配置或授权已变化，请按当前配置重新扫描"); };
    const checkRoot = async () => { check(); await root!.check(); await access(root!.grant.path, constants.R_OK | constants.X_OK); check(); };
    const failed = async (relative: string[], error: unknown) => { await checkRoot(); const reason = error instanceof DesktopError ? error.message.slice(0, 500) : "文件暂不可读，请检查原文件、磁盘和读取权限后重新扫描"; issues.set(relative.join("/"), reason); };
    try {
      const independent = recognitionOwner(this.database, sourceId);
      if (independent && !independent.active) return { discovered: 0, checkedPaths: [], issues: [] };
      if (independent?.mode === "managed-completed") {
        const files = this.database.connection.prepare("SELECT id,target_segments_json FROM sync_receipt WHERE target_directory_id=? ORDER BY completed_at,id LIMIT 10001").all(independent.directory_id) as { id: string; target_segments_json: string }[];
        if (files.length > 10000) throw conflict("受管成果超过一万项，请先按规则拆分同步目标");
        const samples = sampleVideos(files.map((file) => ["completed", ...JSON.parse(file.target_segments_json)]), (name) => video.test(name));
        for (const file of files) { const relative = ["completed", ...JSON.parse(file.target_segments_json)]; check(); try { await this.receiveReceipt(sourceId, file.id, samples.has(JSON.stringify(relative)) ? "同目录存在精确同基名主视频，已跳过样片；正式成果保留" : undefined, check); check(); discovered++; checkedPaths.push(relative.join("/")); } catch (error) { await failed(relative, error); } }
      } else if (row.mode === "managed") {
        const files = this.database.connection.prepare("SELECT i.id,i.version_key,i.target_segments_json,c.file_evidence_json FROM download_item i JOIN download_commit_intent c ON c.item_id=i.id AND c.state='RECORDED' WHERE i.target_root_id=? AND i.state='COMPLETED' ORDER BY i.id LIMIT 10001").all(row.download_root_id) as { id: string; version_key: string; target_segments_json: string; file_evidence_json: string }[];
        if (files.length > 10000) throw conflict("已完成下载超过一万项，请按来源拆分目录");
        for (const file of files) {
          check(); if (!this.canAccept({ itemId: file.id, versionKey: file.version_key })) continue;
          const evidence = localFileEvidenceSchema.parse(JSON.parse(file.file_evidence_json)), completedSegments: string[] = JSON.parse(file.target_segments_json), relative = ["completed", ...completedSegments];
          try {
            // 幂等接收允许终态候选补记回执；显式／定时补扫仍须核对本次文件可读。
            await root!.inspect(relative); check();
            await this.accept({ itemId: file.id, versionKey: file.version_key, rootId: row.download_root_id!, completedSegments, size: evidence.size, sha256: evidence.sha256 }, signal);
            check(); discovered++; checkedPaths.push(relative.join("/"));
          } catch (error) { await failed(relative, error); }
        }
      } else {
        const ignored = this.ignored(row), files = await this.sources.get(sourceId)!.discover([], 10000, ignored, signal), samples = sampleVideos(files, (name) => video.test(name)), observed = new Set<string>();
        for (const relative of files) {
          check();
          if (associated.test(relative.at(-1)!)) { try { await this.observeAccessory(sourceId, relative, undefined, "local", check); } catch (error) { await failed(relative, error); } continue; }
          if (!video.test(relative.at(-1)!) && !unsupported.test(relative.at(-1)!) && !temporary.test(relative.at(-1)!)) continue;
          try { await this.receive(sourceId, relative, undefined, samples.has(JSON.stringify(relative)) ? "同目录存在精确同基名主视频，已跳过样片；来源文件保留" : undefined, check); check(); observed.add(JSON.stringify(relative)); discovered++; checkedPaths.push(relative.join("/")); }
          catch (error) { await failed(relative, error); }
        }
        // 即使没有新事件，也主动复核已知候选；缺失／不可读保留证据，不冒充删除。
        for (const candidate of this.database.connection.prepare("SELECT * FROM ingestion_candidate WHERE source_id=? AND state IN ('OBSERVING','READY','UNAVAILABLE','QUEUED') LIMIT 10000").all(sourceId) as CandidateRow[]) {
          check();
          if (observed.has(candidate.relative_json)) continue;
          try { await this.observe(candidate, check); } catch (error) { await failed(JSON.parse(candidate.relative_json), error); }
        }
      }
      await checkRoot(); this.database.connection.prepare("UPDATE desktop_source SET health='available' WHERE id=?").run(sourceId);
    } catch (error) {
      if (signal.aborted || this.closed) throw error;
      this.database.connection.prepare("UPDATE desktop_source SET health='unavailable' WHERE id=?").run(sourceId);
      if (error instanceof Error && "code" in error && ["LOCAL_UNAVAILABLE", "ENOENT", "ENOTDIR", "EACCES", "EPERM", "ENODEV", "ENXIO", "ESTALE", "EIO"].includes(String(error.code))) this.unavailableSource(sourceId);
      throw error;
    }
    return { discovered, checkedPaths, issues: [...issues].map(([relativePath, failure]) => ({ relativePath, failure })) };
  }
  list(input: CoreInput<"ingestion.candidates">): CoreOutput<"ingestion.candidates"> {
    const db = this.database.connection;
    const rule = input.sourceId ? db.prepare("SELECT type,local_source_id FROM source_rule WHERE id=?").get(input.sourceId) as { type: string; local_source_id: string | null } | undefined : undefined;
    const where = !input.sourceId ? "" : rule?.type === "cloud" ? " WHERE managed_item_id IN (SELECT ji.item_id FROM download_job_item ji JOIN download_source_demand d ON d.job_id=ji.job_id WHERE d.source_id=?)" : " WHERE source_id=?";
    const args = input.sourceId ? [rule?.type === "local" ? rule.local_source_id ?? input.sourceId : input.sourceId] : [];
    const total = (db.prepare("SELECT count(*) AS n FROM ingestion_candidate" + where).get(...args) as { n: number }).n;
    const rows = db.prepare("SELECT * FROM ingestion_candidate" + where + " ORDER BY updated_at DESC,id LIMIT 100 OFFSET ?").all(...args, ((input.page ?? 1) - 1) * 100) as CandidateRow[];
    return { total, items: rows.map((row) => this.candidateDto(row)) };
  }
  private candidateDto(row: CandidateRow): CoreOutput<"ingestion.candidates">["items"][number] { const automation = this.automatic.status(row.id); return { id: row.id, sourceId: row.source_id, relativePath: (JSON.parse(row.relative_json) as string[]).join("/"), size: sourceSnapshotSchema.parse(JSON.parse(row.snapshot_json)).size, state: row.state, requiresConfirmation: automation?.state !== "SUBMITTED", automation, taskId: row.task_id, reason: row.reason, updatedAt: row.updated_at }; }
  describeCandidate(id: string) { return this.candidateDto(this.candidate(id)); }
  async recognize(input: CoreInput<"ingestion.recognize">, automaticKey?: string) {
    const db = this.database.connection, row = this.candidate(input.candidateId);
    const owned = () => db.prepare("SELECT id,task_id,source_id,context FROM ingestion_automatic WHERE candidate_id=? AND recognition_key=? AND state IN ('PENDING','RECOGNIZING')").get(row.id, automaticKey) as { id: string; task_id: string | null; source_id: string; context: string } | undefined;
    if (row.task_id) { if (automaticKey && owned()?.task_id !== row.task_id) throw conflict("此文件已被人工领取，请在待处理继续核对"); return { taskId: row.task_id }; }
    this.assertCandidateCurrent(row);
    if (row.state !== "READY" || !await this.observe(row)) throw conflict("文件尚未稳定，请等待观察完成");
    const taskId = db.transaction(() => {
      // 文件观察包含异步读取；领取必须在同一事务内重新核对，不能留下孤立任务。
      const latest = this.candidate(row.id); if (latest.task_id) { if (automaticKey && owned()?.task_id !== latest.task_id) throw conflict("此文件已被人工领取，请继续人工核对"); return latest.task_id; }
      if (automaticKey) { const owner = owned(); if (!owner || this.automaticPolicies.check(row.id, owner.source_id, owner.context).state !== "READY") throw conflict("自动领取授权已变化，请人工核对"); }
      this.assertCandidateCurrent(latest);
      if (latest.state !== "READY") throw conflict("候选状态已变化，请重新查询");
      const source = this.candidateSource(latest), id = randomUUID(), current = timestamp(this.now);
      this.database.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,created_at,updated_at) VALUES(?,?,?,'PENDING',?,?)").run(id, row.source_id, join(JSON.parse(source.source_grant_json).path, ...JSON.parse(row.relative_json)), current, current);
      const claimed = db.prepare("UPDATE ingestion_candidate SET task_id=?,state='QUEUED',reason=NULL,updated_at=? WHERE id=? AND task_id IS NULL AND state='READY'").run(id, current, row.id);
      if (claimed.changes !== 1) throw conflict("候选已被领取，请查询现有任务");
      if (automaticKey) db.prepare("UPDATE ingestion_automatic SET task_id=?,state='RECOGNIZING' WHERE id=?").run(id, owned()!.id);
      return id;
    })();
    void this.tick().catch(() => {}); return { taskId };
  }
  task(taskId: string): CoreOutput<"ingestion.task"> {
    const row = this.database.connection.prepare("SELECT t.*,c.id AS candidate_id,c.reason FROM media_task t JOIN ingestion_candidate c ON c.task_id=t.id WHERE t.id=?").get(taskId) as { id: string; candidate_id: string; source_path: string; status: string; parsed_json: string | null; reason: string | null } | undefined;
    if (!row) throw conflict("任务不存在");
    const parsed = row.parsed_json ? JSON.parse(row.parsed_json) as ParsedMedia : null;
    const matches = this.database.connection.prepare("SELECT metadata_json FROM task_candidate WHERE task_id=? ORDER BY confidence DESC,json_extract(metadata_json,'$.mediaType'),json_extract(metadata_json,'$.tmdbId'),id LIMIT 100").all(taskId) as { metadata_json: string }[];
    const accessories = (this.database.connection.prepare("SELECT a.* FROM ingestion_accessory a JOIN ingestion_operation o ON o.id=a.operation_id WHERE o.task_id=? ORDER BY a.id LIMIT 100").all(taskId) as (OperationRow & { failure_code: string | null })[]).map((asset) => { const plan = JSON.parse(asset.plan_json) as Plan; return { id: asset.id, sourcePath: join(plan.source.path, ...plan.sourceSegments), targetPath: join(plan.target.path, ...plan.targetSegments), state: asset.phase as NonNullable<CoreOutput<"ingestion.task">["accessories"]>[number]["state"], failure: asset.failure_code }; });
    return { taskId, candidateId: row.candidate_id, sourcePath: row.source_path, revision: this.recognitionEdits.revision(taskId), matchesStale: this.recognitionEdits.matchesStale(taskId), state: row.status, parsed: parsed ? { title: parsed.title, year: parsed.year, season: parsed.season, episode: parsed.episode, episodeEnd: parsed.episodeEnd, type: parsed.type } : null, matches: matches.map((entry) => { const match = JSON.parse(entry.metadata_json) as MediaMatch; return { tmdbId: match.tmdbId, mediaType: match.mediaType, title: match.title, originalTitle: match.originalTitle, year: match.year, confidence: match.score.confidence, evidence: match.evidence, episodeCheck: match.episodeCheck, explanation: match.evidence === "manual" ? "根据已保存的人工识别字段重新匹配，请核对作品" : match.parentOnlyCapped ? "父目录证据不足，仅供人工选择" : `名称 ${Math.round(match.score.titleScore * 100)}%，年份 ${Math.round(match.score.yearScore * 100)}%，${match.evidence === "both" ? "父目录与名称一致" : "请核对作品"}` }; }), failure: row.reason, accessories };
  }
  private async identify(row: CandidateRow, signal: AbortSignal) {
    this.assertCandidateCurrent(row);
    const db = this.database.connection;
    if (!await this.observe(row)) return;
    const source = this.candidateSource(row), parser = this.parser(), edited = this.recognitionEdits.saved(row.task_id!), recognitionRevision = this.recognitionEdits.revision(row.task_id!); if (!parser && !edited) throw new DesktopError("COMPONENT_UNAVAILABLE", "名称解析器尚未就绪，请重试", true);
    const connectionVersion = this.connections.version, relative: string[] = JSON.parse(row.relative_json);
    db.prepare("UPDATE media_task SET status='PROCESSING',updated_at=? WHERE id=?").run(timestamp(this.now), row.task_id);
    const parsed = edited ?? await parser!.parse(relative.at(-1)!, signal); if (!edited && source.media_type !== "AUTO") parsed.type = source.media_type;
    parsed.season = parsed.type === "TV_SHOW" ? resolveSeason(parsed.season, null, relative.slice(0, -1)) : null;
    let matches = await searchMatches(parsed, this.connections.tmdb, signal, !!edited);
    const parent = relative.slice(0, -1).reverse().map((part) => parentContext(part, parsed)).find(Boolean);
    if (parent && !edited) { const context = await parser!.parse(parent.folderName, signal); context.type = parsed.type; context.season = parsed.season; matches = mergeParentEvidence(matches, await searchMatches(context, this.connections.tmdb, signal)); }
    // 只预检排序首项，不据此选择作品或提升置信度；其他候选在人工预览时校验。
    matches.sort((a, b) => b.score.confidence - a.score.confidence || (a.mediaType < b.mediaType ? -1 : a.mediaType > b.mediaType ? 1 : 0) || a.tmdbId - b.tmdbId);
    const first = matches[0];
    if (first?.mediaType === "TV_SHOW") {
      const deadline = new AbortController(), timeout = setTimeout(() => deadline.abort(), 15000);
      try {
        const checked = await validateMediaSelection(this.database, this.connections.tmdb, { tmdbId: first.tmdbId, mediaType: first.mediaType, season: parsed.season, episode: parsed.episode, episodeEnd: parsed.episodeEnd }, { taskId: row.task_id!, fileName: relative.at(-1)!, signal: AbortSignal.any([signal, deadline.signal]) });
        first.episodeCheck = { state: "VALID", season: checked.selection.season!, episode: checked.selection.episode!, episodeEnd: checked.selection.episodeEnd, seasonChanged: checked.seasonChanged };
      } catch (error) {
        signal.throwIfAborted();
        const failure = previewFailure(error);
        first.episodeCheck = { state: "NEEDS_REVIEW", reason: deadline.signal.aborted ? "季集预检超时，请核对网络后在整理预览中重新校验" : failure instanceof DesktopError ? failure.message.slice(0, 500) : "首选候选的季集校验未完成，请核对 TMDB 信息后重新预览" };
      } finally { clearTimeout(timeout); }
    }
    if (signal.aborted || recognitionRevision !== this.recognitionEdits.revision(row.task_id!) || connectionVersion !== this.connections.version || this.candidateSource(row).version !== source.version) throw conflict();
    this.assertCandidateCurrent(row);
    db.transaction(() => {
      db.prepare("DELETE FROM task_candidate WHERE task_id=?").run(row.task_id);
      for (const match of matches) db.prepare("INSERT INTO task_candidate(id,task_id,metadata_json,confidence) VALUES(?,?,?,?)").run(randomUUID(), row.task_id, JSON.stringify(match), match.score.confidence);
      db.prepare("UPDATE media_task SET parsed_json=?,status='AWAITING_CONFIRMATION',title=?,updated_at=? WHERE id=?").run(JSON.stringify(parsed), parsed.title, timestamp(this.now), row.task_id);
      db.prepare("UPDATE ingestion_candidate SET reason=? WHERE id=?").run(matches.length ? null : "没有可靠候选，请手动输入 TMDB ID 预览", row.id);
      this.recognitionEdits.matched(row.task_id!, recognitionRevision);
    })();
  }
  private async observeAccessory(sourceId: string, relative: string[], expected?: SourceSnapshot, policyKey = "local", check?: () => void) {
    check?.(); this.source(sourceId); const snapshot = await this.sources.get(sourceId)!.inspect(relative); check?.(); const version = sourceVersion(snapshot), key = sourceId + ":" + policyKey + ":" + JSON.stringify(relative);
    if (expected && !sameSnapshot(expected, snapshot)) throw conflict("附属文件已变化，请重新预览");
    const { now, current } = this.observeWindow(this.accessoryObservations, key, version);
    return snapshot.size > 0 && now - current.since >= 120000;
  }
  private async accessories(source: SourceRow, candidate: CandidateRow, targetSegments: string[]) {
    const relative = JSON.parse(candidate.relative_json) as string[], sourceName = relative.at(-1)!, base = sourceName.slice(0, -extname(sourceName).length), targetName = targetSegments.at(-1)!, targetBase = targetName.slice(0, -extname(targetName).length), result: Accessory[] = [];
    for (const entry of await this.sources.get(source.source_id)!.filesIn(relative.slice(0, -1))) {
      const name = entry.at(-1)!; if (!associated.test(name) || this.ignored(source)(entry)) continue;
      const sameBase = name.startsWith(base + "."), generic = /^(?:poster|folder|cover)\.jpg$/i.test(name); if (!sameBase && !generic) continue;
      let expectedSha256: string | null = null;
      const independent = recognitionOwner(this.database, source.source_id);
      if (independent?.mode === "managed-completed") {
        const proof = this.database.connection.prepare("SELECT r.local_sha256 FROM sync_receipt r JOIN recognition_receipt p ON p.receipt_id=r.id WHERE r.target_directory_id=? AND r.target_segments_json=? AND p.source_id=? AND p.state='ACCEPTED'").get(independent.directory_id, JSON.stringify(entry.slice(1)), source.source_id) as { local_sha256: string } | undefined;
        if (!proof) continue; expectedSha256 = proof.local_sha256;
      } else if (source.mode === "managed") {
        const proof = this.database.connection.prepare("SELECT i.id,i.version_key,c.file_evidence_json FROM download_item i JOIN download_commit_intent c ON c.item_id=i.id AND c.state='RECORDED' WHERE i.target_root_id=? AND i.target_segments_json=? AND i.state='COMPLETED'").get(source.download_root_id, JSON.stringify(entry.slice(1))) as { id: string; version_key: string; file_evidence_json: string } | undefined;
        if (!proof) continue;
        if (source.policy_key) { const policy = resolveManagedOrganization(this.database, proof.id, proof.version_key); if (policy.state !== "ENABLED" || policy.policy.key !== source.policy_key) continue; }
        expectedSha256 = localFileEvidenceSchema.parse(JSON.parse(proof.file_evidence_json)).sha256;
      }
      if (!await this.observeAccessory(source.source_id, entry, undefined, source.policy_key)) throw conflict("同名附属文件还未稳定 120 秒，请稍后预览或取消附属文件复制");
      result.push({ sourceSegments: entry, targetSegments: [...targetSegments.slice(0, -1), sameBase ? targetBase + name.slice(base.length) : name], snapshot: await this.sources.get(source.source_id)!.inspect(entry), expectedSha256 });
      if (result.length > 100) throw conflict("附属文件超过一百项，请缩小来源范围");
    }
    return result;
  }
  private previewDto(row: PreviewRow): CoreOutput<"ingestion.preview"> { const plan = JSON.parse(row.plan_json) as Plan; return { id: row.id, taskId: row.task_id, title: plan.metadata.title, mediaType: plan.metadata.mediaType, targetPath: join(plan.target.path, ...plan.targetSegments), sourcePath: join(plan.source.path, ...plan.sourceSegments), size: plan.snapshot.size, season: plan.selection.season, episode: plan.selection.episode, episodeEnd: plan.selection.episodeEnd, expiresAt: row.expires_at, operationId: row.operation_id, accessories: plan.accessories?.map((asset) => ({ sourcePath: join(plan.source.path, ...asset.sourceSegments), targetPath: join(plan.target.path, ...asset.targetSegments), size: asset.snapshot.size })) ?? [] }; }
  private previewScope(candidate: CandidateRow) {
    const db = this.database.connection;
    const independent = recognitionOwner(this.database, candidate.source_id);
    if (independent) return independent.active && !independent.paused && !independent.deleted_at ? [{ id: independent.rule_id, revision: independent.lifecycle_revision }] : [];
    const sql = candidate.managed_item_id
      ? "SELECT DISTINCT s.id,s.lifecycle_revision AS revision FROM source_rule s JOIN download_source_demand d ON d.source_id=s.id AND d.source_version=s.version JOIN download_job j ON j.id=d.job_id JOIN download_job_item ji ON ji.job_id=j.id JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version WHERE ji.item_id=? AND d.review_required=0 AND ji.demand_state='ACTIVE' AND j.state NOT IN ('CANCELLED','CANCELLING') AND s.deleted_at IS NULL AND s.paused=0 AND s.review_required=0 AND json_extract(v.configuration_json,'$.organization') IS NOT NULL"
      : "SELECT id,lifecycle_revision AS revision FROM source_rule WHERE local_source_id=? AND deleted_at IS NULL AND paused=0";
    return db.prepare(sql).all(candidate.managed_item_id ?? candidate.source_id) as { id: string; revision: number }[];
  }
  private assertPreviewScope(candidate: CandidateRow, original?: Plan["sourceLifecycles"]) {
    const current = this.previewScope(candidate);
    // 同策略的其他原始需求仍有效时允许共享确认；全部原需求已删除／恢复则旧预览失效。
    if (original?.length ? !original.some((prior) => current.some((row) => row.id === prior.id && row.revision === prior.revision)) : current.some((row) => row.revision > 0)) throw conflict("来源已经删除或恢复，请重新预览整理范围");
  }
  async preview(input: CoreInput<"ingestion.preview">, signal?: AbortSignal): Promise<CoreOutput<"ingestion.preview">> {
    try { signal?.throwIfAborted(); return await this.buildPreview(input, signal); } catch (error) { throw previewFailure(error); }
  }
  private async buildPreview(input: CoreInput<"ingestion.preview">, signal?: AbortSignal): Promise<CoreOutput<"ingestion.preview">> {
    const db = this.database.connection, digest = fingerprint(input), existing = db.prepare("SELECT * FROM ingestion_preview WHERE request_key=?").get(input.requestKey) as PreviewRow | undefined;
    if (existing) { if (existing.input_hash !== digest) throw conflict("预览请求键已用于不同内容"); return this.previewDto(existing); }
    const row = db.prepare("SELECT c.* FROM ingestion_candidate c JOIN media_task t ON t.id=c.task_id WHERE t.id=? AND t.status='AWAITING_CONFIRMATION'").get(input.taskId) as CandidateRow | undefined;
    const recognitionRevision = this.recognitionEdits.revision(input.taskId);
    if (!row || !await this.observe(row)) throw conflict("任务或文件尚未就绪");
    this.assertCandidateCurrent(row);
    const source = this.candidateSource(row), sourceLifecycles = this.previewScope(row), target = this.targetFor(source, input.selection.mediaType, input.selection.targetId), connectionVersion = this.connections.version;
    const parsedRow = db.prepare("SELECT parsed_json FROM media_task WHERE id=?").get(input.taskId) as { parsed_json: string | null };
    if (!parsedRow.parsed_json) throw conflict("请先完成名称识别");
    const parsed = JSON.parse(parsedRow.parsed_json) as ParsedMedia;
    const { selection, metadata, episodeTitle } = await validateMediaSelection(this.database, this.connections.tmdb, input.selection, { taskId: input.taskId, fileName: (JSON.parse(row.relative_json) as string[]).at(-1)!, signal });
    const variables = { title: metadata.title, original_title: metadata.originalTitle, year: metadata.year, tmdb_id: metadata.tmdbId, media_type: metadata.mediaType, season: selection.season, episode: selection.episode === null ? null : { start: selection.episode, end: selection.episodeEnd }, episode_title: episodeTitle, title_initial: titleInitial(metadata.title), genre_1: metadata.genres?.[0] ?? null, genre_2: metadata.genres?.[1] ?? null, genre_3: metadata.genres?.[2] ?? null, genre_4: metadata.genres?.[3] ?? null, country: metadata.country ?? null, resolution: parsed.screenSize, codec: parsed.videoCodec, release_group: parsed.releaseGroup, ext: extname(parsed.originalFilename).slice(1) };
    const route = recognitionRoute(this.database, row.source_id, input.selection.mediaType, input.selection.targetId);
    const template = input.template ?? route?.configuration.template ?? (selection.mediaType === "MOVIE" ? "{title}[[ ({year})]] [tmdb-{tmdb_id}]/{title}[[ ({year})]].{ext}" : "{title} [tmdb-{tmdb_id}]/Season {season:02d}/{title} - S{season:02d}E{episode:02d}.{ext}");
    const segments = templatePath(template, variables, process.platform === "win32" ? "win32" : "darwin"); target.segments(segments); assertCorrectionTarget(this.database, target, segments, input.taskId); await target.assertVacant(segments); await target.check();
    const accessories = input.includeAccessories === false ? [] : await this.accessories(source, row, segments); target.assertMappings([segments, ...accessories.map((asset) => asset.targetSegments)]); for (const asset of accessories) assertCorrectionTarget(this.database, target, asset.targetSegments, input.taskId);
    if (connectionVersion !== this.connections.version || this.candidateSource(row).version !== source.version || !await this.observe(row)) throw conflict();
    this.assertCandidateCurrent(row);
    this.assertCoordinates(selection, row.id);
    this.assertPreviewScope(row, sourceLifecycles);
    if (recognitionRevision !== this.recognitionEdits.revision(input.taskId)) throw conflict("识别信息已变化，请重新预览整理范围");
    signal?.throwIfAborted();
    const plan: Plan = { ...(route ? { recognitionSnapshot: route.snapshot, recognitionContext: recognitionCandidateContext(this.database, row.source_id), logicalTargetId: route.configuration.id, embyBinding: route.binding } : {}), taskId: input.taskId, candidateId: row.id, sourceId: row.source_id, sourceVersion: source.version, recognitionRevision, sourceLifecycles, connectionVersion, source: JSON.parse(source.source_grant_json), target: target.grant, sourceSegments: JSON.parse(row.relative_json), targetSegments: segments, snapshot: JSON.parse(row.snapshot_json), expectedSha256: row.expected_sha256, parsed, metadata, selection, episodeTitle, accessories };
    const result: PreviewRow = { id: randomUUID(), request_key: input.requestKey, task_id: input.taskId, input_hash: digest, plan_json: JSON.stringify(plan), expires_at: this.now() + 10 * 60 * 1000, operation_id: null };
    const concurrent = db.prepare("SELECT * FROM ingestion_preview WHERE request_key=?").get(input.requestKey) as PreviewRow | undefined;
    if (concurrent) { if (concurrent.input_hash !== digest) throw conflict(); return this.previewDto(concurrent); }
    db.prepare("INSERT INTO ingestion_preview(id,request_key,task_id,input_hash,plan_json,expires_at) VALUES(?,?,?,?,?,?)").run(result.id, result.request_key, result.task_id, result.input_hash, result.plan_json, result.expires_at); return this.previewDto(result);
  }
  private assertCoordinates(selection: Plan["selection"], candidateId: string) {
    const candidate = this.candidate(candidateId), current = JSON.parse(candidate.relative_json) as string[];
    assertMediaCoordinates(this.database, selection, candidate.task_id ?? "", current.at(-1)!);
  }
  withCorrectionLease<T>(taskId: string, work: () => Promise<T>): Promise<T> { return this.withCorrectionLeases([taskId], work); }
  async withCorrectionLeases<T>(taskIds: readonly string[], work: () => Promise<T>): Promise<T> {
    const ids = [...new Set(taskIds)];
    for (const taskId of ids) {
      if (this.closed || this.correctionLeases.has(taskId)) throw conflict("此任务正在核对修正，请等待当前请求完成");
      if (this.database.connection.prepare("SELECT 1 FROM app_setting s JOIN ingestion_operation o ON s.key='ingestion.restore.audit.'||o.id WHERE o.task_id=?").get(taskId)) throw conflict("恢复备份后的原目标尚待核对，请等待原卷恢复后再预览修正");
      const candidate = this.database.connection.prepare("SELECT id FROM ingestion_candidate WHERE task_id=?").get(taskId) as { id: string } | undefined;
      if (candidate && [...this.activeWork.values()].some((active) => active.candidateId === candidate.id)) throw conflict("此任务的附属文件仍在处理，请等待当前步骤到达安全点后重新预览修正");
    }
    for (const id of ids) this.correctionLeases.add(id);
    try { return await work(); } finally { for (const id of ids) this.correctionLeases.delete(id); }
  }
  async confirm(input: CoreInput<"ingestion.confirm">, ownerBatchId?: string, automaticCheck?: () => void) {
    if (!automaticCheck && this.database.connection.prepare("SELECT 1 FROM ingestion_automatic a JOIN ingestion_preview p ON p.request_key=a.preview_key WHERE p.id=?").get(input.previewId)) throw conflict("此预览属于自动整理意图，请查看原任务或暂停来源后人工重新预览");
    const owner = this.database.connection.prepare("SELECT i.batch_id FROM ingestion_organize_batch_item i JOIN ingestion_preview p ON p.request_key=i.request_key WHERE p.id=?").get(input.previewId) as { batch_id: string } | undefined;
    if (owner && owner.batch_id !== ownerBatchId) throw conflict("此预览属于批量整理，请从批次入口确认完整范围");
    const db = this.database.connection, previous = db.prepare("SELECT id FROM ingestion_operation WHERE request_key=?").get(input.requestKey) as { id: string } | undefined;
    const receipt = db.prepare("SELECT * FROM ingestion_preview WHERE id=?").get(input.previewId) as PreviewRow | undefined;
    if (previous) { if (receipt?.operation_id !== previous.id) throw conflict("确认请求键已用于其他预览"); return { operationId: previous.id }; }
    if (!receipt) throw conflict("预览不存在"); if (receipt.operation_id) return { operationId: receipt.operation_id };
    automaticCheck?.();
    const plan = JSON.parse(receipt.plan_json) as Plan, candidate = this.candidate(plan.candidateId), source = this.candidateSource(candidate);
    this.assertPreviewScope(candidate, plan.sourceLifecycles); this.assertRecognitionPlanCurrent(plan);
    if ((plan.recognitionRevision ?? 0) !== this.recognitionEdits.revision(receipt.task_id)) throw conflict("识别信息已变化，请重新预览整理范围");
    this.assertCandidateCurrent(candidate);
    if (plan.expectedSha256 !== candidate.expected_sha256) throw conflict("内容复核证据已更新，请重新预览后确认");
    if (receipt.expires_at <= this.now() || source.version !== plan.sourceVersion || this.targetFor(source, plan.selection.mediaType, plan.logicalTargetId).grant.id !== plan.target.id || this.connections.version !== plan.connectionVersion || candidate.task_id !== receipt.task_id || !["QUEUED", "READY"].includes(candidate.state) || !await this.observe(candidate)) throw conflict("预览已过期或文件变化，请重新预览");
    const target = this.targets.get(plan.target.id); await target.assertVacant(plan.targetSegments); for (const asset of plan.accessories ?? []) if (!await this.observeAccessory(plan.sourceId, asset.sourceSegments, asset.snapshot, source.policy_key)) throw conflict("附属文件需重新观察"); assertSpaceBudget(await target.check(), plan.snapshot.size + (plan.accessories ?? []).reduce((sum, asset) => sum + asset.snapshot.size, 0), this.reserved(plan.target.id));
    const id = randomUUID(), current = timestamp(this.now);
    const concurrent = db.prepare("SELECT id FROM ingestion_operation WHERE candidate_id=?").get(candidate.id) as { id: string } | undefined;
    if (concurrent) { const updated = db.prepare("SELECT operation_id FROM ingestion_preview WHERE id=?").get(receipt.id) as { operation_id: string | null }; if (updated.operation_id === concurrent.id) return { operationId: concurrent.id }; throw conflict(); }
    db.transaction(() => {
      automaticCheck?.();
      if (this.candidateSource(candidate).version !== plan.sourceVersion || this.connections.version !== plan.connectionVersion) throw conflict();
      this.assertPreviewScope(candidate, plan.sourceLifecycles); this.assertRecognitionPlanCurrent(plan);
      if ((plan.recognitionRevision ?? 0) !== this.recognitionEdits.revision(receipt.task_id)) throw conflict("识别信息已变化，请重新预览整理范围");
      this.assertCandidateCurrent(candidate);
      if (plan.expectedSha256 !== this.candidate(candidate.id).expected_sha256) throw conflict("内容复核证据已更新，请重新预览后确认");
      if (db.prepare("SELECT 1 FROM ingestion_operation WHERE candidate_id=?").get(candidate.id)) throw conflict("此文件已有整理计划");
      this.assertCoordinates(plan.selection, candidate.id);
      for (const parts of [plan.targetSegments, ...(plan.accessories ?? []).map((asset) => asset.targetSegments)]) assertCorrectionTarget(this.database, target, parts, receipt.task_id);
      db.prepare("INSERT INTO ingestion_operation(id,candidate_id,task_id,request_key,target_root_id,target_slot,plan_json,attempt_id,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'PLANNED',?,?)").run(id, candidate.id, receipt.task_id, input.requestKey, plan.target.id, target.slotKey(plan.targetSegments), receipt.plan_json, randomUUID(), current, current);
      db.prepare("UPDATE ingestion_preview SET operation_id=? WHERE id=?").run(id, receipt.id);
      db.prepare("UPDATE media_task SET status='PROCESSING',confirmed_json=?,metadata_json=?,title=?,updated_at=? WHERE id=?").run(JSON.stringify(plan.selection), JSON.stringify(plan.metadata), plan.metadata.title, current, receipt.task_id);
      db.prepare("INSERT INTO desktop_job(id,kind,state,plan_json,updated_at) VALUES(?,'ingestion','PLANNED',?,?)").run(id, receipt.plan_json, current);
      for (const asset of plan.accessories ?? []) db.prepare("INSERT INTO ingestion_accessory(id,operation_id,target_root_id,plan_json,attempt_id,phase,created_at,updated_at) VALUES(?,?,?,?,?,'PLANNED',?,?)").run(randomUUID(), id, plan.target.id, JSON.stringify({ ...plan, ...asset, accessories: [] }), randomUUID(), current, current);
    })(); void this.tick().catch(() => {}); return { operationId: id };
  }
  private reserved(rootId: string, except?: string) { const rows = this.database.connection.prepare("SELECT id,plan_json FROM ingestion_operation WHERE target_root_id=? AND phase IN ('PLANNED','COPYING') UNION ALL SELECT id,plan_json FROM ingestion_accessory WHERE target_root_id=? AND phase IN ('PLANNED','COPYING')").all(rootId, rootId) as { id: string; plan_json: string }[]; return rows.filter((row) => row.id !== except).reduce((total, row) => total + (JSON.parse(row.plan_json) as Plan).snapshot.size, 0); }
  private async copyContent(operation: OperationRow, signal: AbortSignal, table: "ingestion_operation" | "ingestion_accessory") {
    const db = this.database.connection, plan = JSON.parse(operation.plan_json) as Plan, sourceRow = this.operationSource(operation, plan), target = this.targets.get(plan.target.id), source = this.sources.get(plan.sourceId)!;
    if (!sameVolumeRoot(target.grant.volume, plan.target.volume)) throw conflict();
    let evidence = operation.evidence_json ? localFileEvidenceSchema.parse(JSON.parse(operation.evidence_json)) : undefined;
    if (!evidence) {
      if (!source || source.grant.path !== plan.source.path || !sameVolumeRoot(source.grant.volume, plan.source.volume)) throw conflict("原识别输入卷或目录身份已变化，请恢复原目录后重试原任务");
      if (!plan.recognitionSnapshot && !recognitionOwner(this.database, plan.sourceId) && (sourceRow.version !== plan.sourceVersion || this.targetFor(sourceRow, plan.selection.mediaType).grant.id !== plan.target.id)) throw conflict("来源规则或路由已变化，未开始计划需要重新预览");
      if (table === "ingestion_operation" ? !await this.observe(this.candidate(plan.candidateId), undefined, plan.recognitionSnapshot || recognitionOwner(this.database, plan.sourceId) ? sourceRow : undefined, plan.recognitionSnapshot?.configuration.ignoredFilePatterns) : !await this.observeAccessory(plan.sourceId, plan.sourceSegments, plan.snapshot, sourceRow.policy_key)) return;
      assertSpaceBudget(await target.check(), plan.snapshot.size, this.reserved(target.grant.id, operation.id)); await target.assertVacant(plan.targetSegments);
      // COPYING 重启时仅清理持有本操作标记的残留暂存，再换新尝试 ID。
      if (operation.phase === "COPYING") { await target.cleanupAttempt(operation.attempt_id).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); operation.attempt_id = randomUUID(); db.prepare(`UPDATE ${table} SET attempt_id=? WHERE id=?`).run(operation.attempt_id, operation.id); }
      db.prepare(`UPDATE ${table} SET phase='COPYING',updated_at=? WHERE id=?`).run(timestamp(this.now), operation.id);
      await target.prepareStage(operation.attempt_id); const stage = await target.stageFilePath(operation.attempt_id, plan.targetSegments);
      let copiedHash = "";
      await source.read(plan.sourceSegments, plan.snapshot, async (handle) => {
        const writer = await open(stage, "wx", 0o600);
        try { copiedHash = await source.digest(handle, plan.snapshot.size, signal, async (buffer) => { let offset = 0; while (offset < buffer.length) { const result = await writer.write(buffer, offset, buffer.length - offset); if (!result.bytesWritten) throw new Error(); offset += result.bytesWritten; } }); await writer.sync(); }
        finally { await writer.close(); }
        const rechecked = await source.digest(handle, plan.snapshot.size, signal), baseline = table === "ingestion_operation" ? this.candidate(plan.candidateId).expected_sha256 : null;
        if (rechecked !== copiedHash || (plan.expectedSha256 && copiedHash !== plan.expectedSha256) || (baseline && copiedHash !== baseline)) throw conflict("来源内容校验失败，未发布正式文件");
      });
      evidence = await target.verifyStage(operation.attempt_id, plan.targetSegments, plan.snapshot.size);
      if (evidence.sha256 !== copiedHash) throw conflict("暂存文件内容校验失败");
      if (table === "ingestion_operation") db.prepare("UPDATE ingestion_candidate SET expected_sha256=coalesce(expected_sha256,?) WHERE id=?").run(copiedHash, plan.candidateId);
      if (signal.aborted) throw new DesktopError("INTERRUPTED", "整理已中断，文件保留在暂存区", true);
      db.prepare(`UPDATE ${table} SET phase='VERIFIED',evidence_json=?,updated_at=? WHERE id=?`).run(JSON.stringify(evidence), timestamp(this.now), operation.id);
    }
    // VERIFIED 之后恢复只补提交和记账，绝不再从来源复制。
    if (signal.aborted || this.operationSource(operation, plan).paused) return;
    const committed = await target.commit(operation.attempt_id, plan.targetSegments, evidence);
    db.prepare(`UPDATE ${table} SET phase='FILE_COMMITTED',updated_at=? WHERE id=?`).run(timestamp(this.now), operation.id); return committed;
  }
  private async copy(operation: OperationRow, signal: AbortSignal) {
    const committed = await this.copyContent(operation, signal, "ingestion_operation"); if (!committed) return;
    const db = this.database.connection, plan = JSON.parse(operation.plan_json) as Plan, target = this.targets.get(plan.target.id);
    db.transaction(() => {
      db.prepare("UPDATE media_task SET status='DONE',target_path=?,delivery_status='REFRESH_PENDING',updated_at=? WHERE id=?").run(committed.path, timestamp(this.now), plan.taskId);
      db.prepare("UPDATE ingestion_candidate SET state='PROCESSED',reason=NULL,updated_at=? WHERE id=?").run(timestamp(this.now), plan.candidateId);
      db.prepare("UPDATE ingestion_operation SET phase='RECORDED',failure_code=NULL,updated_at=? WHERE id=?").run(timestamp(this.now), operation.id);
      db.prepare("UPDATE desktop_job SET state=?,updated_at=? WHERE id=?").run(plan.accessories?.length ? "COPYING_ACCESSORIES" : "DONE", timestamp(this.now), operation.id);
      const connection = db.prepare("SELECT id,version FROM emby_connection ORDER BY verified_at DESC LIMIT 1").get() as { id: string; version: number } | undefined;
      db.prepare("INSERT INTO emby_delivery(task_id,operation_id,connection_id,connection_version,state,next_attempt_at,updated_at,binding_json) VALUES(?,?,?,?,'REFRESH_PENDING',?,?,?) ON CONFLICT(task_id) DO NOTHING").run(plan.taskId, operation.id, connection?.id ?? null, connection?.version ?? null, this.now() + 30000, timestamp(this.now), plan.embyBinding ? JSON.stringify(plan.embyBinding) : null);
    })(); await target.cleanupAttempt(operation.attempt_id).catch(() => {});
  }
  private async copyAccessory(operation: OperationRow & { operation_id: string }, signal: AbortSignal) {
    const committed = await this.copyContent(operation, signal, "ingestion_accessory"); if (!committed) return;
    const db = this.database.connection, plan = JSON.parse(operation.plan_json) as Plan;
    db.transaction(() => {
      db.prepare("UPDATE ingestion_accessory SET phase='RECORDED',failure_code=NULL,updated_at=? WHERE id=?").run(timestamp(this.now), operation.id);
      // 字幕稍后补齐时只再安排交付，主视频记录和文件不重新复制。
      db.prepare("UPDATE emby_delivery SET state='REFRESH_PENDING',next_attempt_at=?,check_started_at=NULL,emby_item_id=NULL WHERE task_id=? AND state IN ('REFRESH_PENDING','WAITING_LIBRARY','COLLECTED')").run(this.now() + 30000, plan.taskId);
      db.prepare("UPDATE media_task SET delivery_status=(SELECT state FROM emby_delivery WHERE task_id=?) WHERE id=?").run(plan.taskId, plan.taskId);
    })(); await this.targets.get(plan.target.id).cleanupAttempt(operation.attempt_id).catch(() => {}); this.accessoryJobState(operation.operation_id);
  }
  private accessoryJobState(operationId: string) { const rows = this.database.connection.prepare("SELECT phase FROM ingestion_accessory WHERE operation_id=?").all(operationId) as { phase: string }[]; this.database.connection.prepare("UPDATE desktop_job SET state=?,updated_at=? WHERE id=?").run(rows.every((row) => row.phase === "RECORDED") ? "DONE" : rows.some((row) => row.phase === "NEEDS_ATTENTION") ? "PARTIAL_FAILED" : "COPYING_ACCESSORIES", timestamp(this.now), operationId); }
  retry(taskId: string) {
    if (this.database.connection.prepare("SELECT 1 FROM media_correction_operation WHERE new_task_id=?").get(taskId) || this.correctionLeases.has(taskId) || this.database.connection.prepare("SELECT 1 FROM media_task WHERE id=? AND status='CORRECTED'").get(taskId) || this.database.connection.prepare("SELECT 1 FROM correction_item WHERE task_id=? AND state IN ('PENDING','RUNNING','NEEDS_ATTENTION')").get(taskId)) throw conflict("此任务已被修正或正在修正，不能重放旧附属文件计划；请查看最新任务与修正作业");
    if (this.database.connection.prepare("SELECT 1 FROM app_setting s JOIN ingestion_operation o ON s.key='ingestion.restore.audit.'||o.id WHERE o.task_id=?").get(taskId)) throw conflict("恢复备份后的目标文件尚待核对，请等待原卷和权限恢复");
    const db = this.database.connection, candidate = db.prepare("SELECT * FROM ingestion_candidate WHERE task_id=?").get(taskId) as CandidateRow | undefined; if (!candidate) throw conflict(); this.candidateSource(candidate);
    if (this.contentReviews.active(candidate.source_id)) throw conflict("该来源正在全量复核内容，请等待完成或取消后重试");
    const operation = db.prepare("SELECT * FROM ingestion_operation WHERE task_id=?").get(taskId) as OperationRow | undefined;
    if (operation?.phase === "RECORDED") {
      const changed = db.prepare("UPDATE ingestion_accessory SET phase=CASE WHEN evidence_json IS NULL THEN 'COPYING' ELSE 'VERIFIED' END,failure_code=NULL WHERE operation_id=? AND phase='NEEDS_ATTENTION'").run(operation.id);
      if (!changed.changes) throw conflict("文件已完成，请仅重试 Emby 交付"); this.accessoryJobState(operation.id); void this.tick().catch(() => {}); return {};
    }
    this.assertCandidateCurrent(candidate);
    if (operation) db.prepare("UPDATE ingestion_operation SET phase=CASE WHEN evidence_json IS NULL THEN 'COPYING' ELSE 'VERIFIED' END,failure_code=NULL WHERE id=?").run(operation.id);
    db.prepare("UPDATE media_task SET status=?,updated_at=? WHERE id=?").run(operation ? "PROCESSING" : "PENDING", timestamp(this.now), taskId); db.prepare("UPDATE ingestion_candidate SET reason=NULL WHERE id=?").run(candidate.id); void this.tick().catch(() => {}); return {};
  }
  tick(): Promise<void> { if (this.closed) return Promise.resolve(); return this.flight ??= this.run().finally(() => { this.flight = undefined; }); }
  private async withSourceWork<T>(candidateId: string, parent: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const candidate = this.candidate(candidateId), controller = new AbortController(), abort = () => controller.abort();
    if (parent.aborted) abort(); else parent.addEventListener("abort", abort, { once: true });
    this.activeWork.set(controller, { sourceId: candidate.source_id, candidateId });
    try { return await work(controller.signal); }
    catch (error) { if (controller.signal.aborted && !parent.aborted) throw new SourceWorkInterrupted(); throw error; }
    finally { parent.removeEventListener("abort", abort); this.activeWork.delete(controller); }
  }
  private async run() {
    this.contentReviews.kick();
    await this.auditRestored();
    if (this.pauseStatus().paused) return;
    const db = this.database.connection, controller = new AbortController(); this.controller = controller;
    try {
      for (const source of db.prepare(sourceQuery + " WHERE i.available=1 AND s.paused=0 AND i.source_version=s.version ORDER BY i.source_id LIMIT 1000").all() as SourceRow[]) { if (controller.signal.aborted) return; await this.scan(source.source_id).catch(() => {}); }
      for (const row of db.prepare("SELECT id FROM ingestion_candidate WHERE state='READY' AND task_id IS NULL AND NOT EXISTS(SELECT 1 FROM ingestion_automatic a WHERE a.candidate_id=ingestion_candidate.id) AND (EXISTS(SELECT 1 FROM source_rule s JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version WHERE json_extract(v.configuration_json,'$.organization.automatic')=1 AND s.deleted_at IS NULL AND (s.local_source_id=ingestion_candidate.source_id OR EXISTS(SELECT 1 FROM download_source_demand d JOIN download_job_item ji ON ji.job_id=d.job_id WHERE d.source_id=s.id AND d.source_version=s.version AND ji.item_id=ingestion_candidate.managed_item_id))) OR EXISTS(SELECT 1 FROM recognition_input ri JOIN recognition_rule r ON r.id=ri.rule_id JOIN recognition_rule_version rv ON rv.rule_id=r.id AND rv.version=r.version WHERE ri.source_id=ingestion_candidate.source_id AND ri.active=1 AND r.deleted_at IS NULL AND json_extract(rv.snapshot_json,'$.configuration.automatic')=1)) ORDER BY created_at,id LIMIT 1000").all() as { id: string }[]) { const intent = this.automaticPolicies.capture(row.id); if (intent) this.automatic.enqueue(intent); }
      await this.automatic.tick();
      const candidates = db.prepare("SELECT c.* FROM ingestion_candidate c JOIN media_task t ON t.id=c.task_id JOIN desktop_source s ON s.id=c.source_id WHERE t.status='PENDING' AND s.paused=0 ORDER BY t.created_at,t.id LIMIT 10").all() as CandidateRow[];
      for (const row of candidates) { if (controller.signal.aborted) return; if (!this.managedCandidateEnabled(row) || this.contentReviews.active(row.source_id)) continue; try { await this.withSourceWork(row.id, controller.signal, (signal) => this.identify(row, signal)); } catch (error) {
        if (controller.signal.aborted) { db.prepare("UPDATE media_task SET status='PENDING',updated_at=? WHERE id=? AND status='PROCESSING'").run(timestamp(this.now), row.task_id); return; }
        const latest = this.candidate(row.id);
        if (!latest.managed_item_id && !latest.is_current) { db.prepare("UPDATE media_task SET status='SKIPPED',updated_at=? WHERE id=? AND status!='DONE'").run(timestamp(this.now), row.task_id); continue; }
        if (error instanceof SourceWorkInterrupted) { db.prepare("UPDATE media_task SET status='PENDING',updated_at=? WHERE id=? AND status='PROCESSING'").run(timestamp(this.now), row.task_id); db.prepare("UPDATE ingestion_candidate SET reason=? WHERE id=?").run(error.message, row.id); continue; }
        db.prepare("UPDATE media_task SET status='AWAITING_CONFIRMATION',updated_at=? WHERE id=?").run(timestamp(this.now), row.task_id); db.prepare("UPDATE ingestion_candidate SET reason=? WHERE id=?").run(recognitionFailure(error), row.id);
      } }
      await this.automatic.tick();
      const operations = db.prepare("SELECT o.* FROM ingestion_operation o JOIN desktop_source s ON s.id=(SELECT source_id FROM ingestion_candidate WHERE id=o.candidate_id) WHERE o.phase IN ('PLANNED','COPYING','VERIFIED','FILE_COMMITTED') AND s.paused=0 ORDER BY o.created_at,o.id LIMIT 10").all() as OperationRow[];
      for (const operation of operations) { if (controller.signal.aborted) return; if (!this.operationRunnable(operation)) continue; try { await this.withSourceWork(operation.candidate_id, controller.signal, (signal) => this.copy(operation, signal)); } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof SourceWorkInterrupted) continue;
        if (!this.operationRunnable(operation)) continue;
        const unavailable = error instanceof DesktopError && error.code === "LOCAL_UNAVAILABLE" || error instanceof Error && "code" in error && error.code === "LOCAL_UNAVAILABLE";
        if (unavailable) { db.prepare("UPDATE desktop_source SET health='unavailable' WHERE id=(SELECT source_id FROM ingestion_candidate WHERE id=?)").run(operation.candidate_id); continue; }
        db.prepare("UPDATE ingestion_operation SET phase='NEEDS_ATTENTION',failure_code=?,updated_at=? WHERE id=?").run(error instanceof DesktopError ? error.code : "STORAGE_ERROR", timestamp(this.now), operation.id);
        db.prepare("UPDATE media_task SET status='FAILED',updated_at=? WHERE id=?").run(timestamp(this.now), operation.task_id);
        db.prepare("UPDATE ingestion_candidate SET reason='整理中断或证据冲突，未覆盖现有文件；请检查后重试' WHERE id=?").run(operation.candidate_id);
      } }
      const accessories = db.prepare("SELECT a.*,o.task_id,o.candidate_id FROM ingestion_accessory a JOIN ingestion_operation o ON o.id=a.operation_id JOIN desktop_source s ON s.id=(SELECT source_id FROM ingestion_candidate WHERE id=o.candidate_id) WHERE o.phase='RECORDED' AND a.phase IN ('PLANNED','COPYING','VERIFIED','FILE_COMMITTED') AND s.paused=0 ORDER BY a.created_at,a.id LIMIT 100").all() as (OperationRow & { operation_id: string })[];
      for (const asset of accessories) { if (controller.signal.aborted) return; if (!this.operationRunnable(asset)) continue; try { await this.withSourceWork(asset.candidate_id, controller.signal, (signal) => this.copyAccessory(asset, signal)); } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof SourceWorkInterrupted) continue;
        if (!this.operationRunnable(asset)) continue;
        if (error instanceof Error && "code" in error && error.code === "LOCAL_UNAVAILABLE") continue;
        db.prepare("UPDATE ingestion_accessory SET phase='NEEDS_ATTENTION',failure_code=?,updated_at=? WHERE id=?").run(error instanceof DesktopError ? error.code : "STORAGE_ERROR", timestamp(this.now), asset.id); this.accessoryJobState(asset.operation_id);
      } }
    } finally { this.controller = undefined; }
  }
  async quiesce() { this.closed = true; clearInterval(this.timer); this.controller?.abort(); for (const controller of this.scanControllers.values()) controller.abort(); for (const { watcher, timer } of this.watches.values()) { clearTimeout(timer); watcher.close(); } this.watches.clear(); await this.automatic.close(); await this.organizeBatches.close(); await this.recognitionBatches.close(); await this.contentReviews.close(); await this.flight?.catch(() => {}); await Promise.allSettled([...this.scans.values()]); await this.configurationQueue.catch(() => {}); }
  async close() { await this.quiesce(); await Promise.allSettled([...this.sources.values()].map((source) => source.close())); this.sources.clear(); await this.targets.close(); }
}
