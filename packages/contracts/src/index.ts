import { hostPreferencesDraftSchema, licenseIdSchema, type HostPreferencesDraft, type HostPreferences, type DesktopAbout, type LicenseId, type LicenseText } from "./desktop-host.js";
export * from "./desktop-host.js";
export * from "./renderer-lifecycle.js";
import { z } from "zod";
import { directoryIssueSchema, type DirectoryIssue } from "./directory-issues.js";
export * from "./directory-issues.js";
import { cloudActions, cloudCredentialDraftSchema, cloudLoginDraftSchema, cloudDiagnosticCountsSchema, CloudError, cloudFailure, type CloudAccount, type CloudAuthorization, type CloudCredentialDraft, type CloudLoginDraft, type RemotePage, type RemoteEntry, type ManagedDownloadRoot, type CloudInput, type DownloadPreview, type CloudOutput, type CloudSubscription } from "./cloud/index.js";
export * from "./cloud/index.js";
import { ingestionActions, ingestionConfigureSchema } from "./ingestion.js";
export * from "./ingestion.js";
import { correctionActions } from "./corrections.js";
export * from "./corrections.js";
import { embyActions } from "./emby.js";
export * from "./emby.js";
import { sourceRuleActions } from "./source-rules.js";
export * from "./source-rules.js";
export * from "./sync-recognition.js";
export * from "./sync-glob.js";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const DESKTOP_CHANNEL = "media-marshal:desktop:v1";
export const errorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "PROTOCOL_MISMATCH",
  "FORBIDDEN",
  "CORE_UNAVAILABLE",
  "INTERRUPTED",
  "TIMEOUT",
  "CONFLICT",
  "UNSAFE_PATH",
  "STORAGE_ERROR",
  "INTERNAL_ERROR",
  "AUTH_REQUIRED", "RATE_LIMITED", "NETWORK_UNAVAILABLE", "REMOTE_CHANGED", "REMOTE_NOT_FOUND", "LOCAL_UNAVAILABLE", "UNSUPPORTED_CAPABILITY", "COMPONENT_UNAVAILABLE",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const rpcErrorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().max(500),
  retryable: z.boolean(),
  retryAfterSeconds: z.number().int().min(1).max(3600).optional(),
  directoryIssue: directoryIssueSchema.optional(),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;
export class DesktopError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
    readonly directoryIssue?: DirectoryIssue,
  ) {
    super(message);
    this.name = "DesktopError";
  }
}

export const sourceKindSchema = z.enum(["quark", "baidu", "alipan", "custom"]);
export const sourceDraftSchema = z.strictObject({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(100),
  kind: sourceKindSchema,
  sourcePath: z.string().min(1).max(4096),
  targetPath: z.string().min(1).max(4096),
  mediaType: z.enum(["AUTO", "MOVIE", "TV_SHOW"]).default("AUTO"),
  operation: z.literal("COPY").default("COPY"),
  automatic: z.literal(false).default(false),
});
export type SourceDraft = z.infer<typeof sourceDraftSchema>;
export const sourceSchema = sourceDraftSchema.extend({
  automatic: z.boolean().default(false),
  mode: z.enum(["local", "managed"]).optional(),
  downloadRootId: z.uuid().nullable().optional(),
  id: z.uuid(),
  version: z.number().int().positive(),
  paused: z.boolean(),
  health: z.enum(["unverified", "available", "unavailable"]),
  createdAt: z.string(),
});
export type DesktopSource = z.infer<typeof sourceSchema>;

const serviceAddressSchema = (proxy: boolean) => z.string().max(2048, "服务地址不能超过 2048 字符").refine((value) => {
  if (!value) return true;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && (!proxy || url.pathname === "/"); } catch { return false; }
}, proxy ? "TMDB 代理只支持不含凭据、路径、查询或片段的 HTTP(S) 地址；留空表示直连" : "Emby 地址只支持不含凭据、查询或片段的 HTTP(S) 地址；密钥请单独保存").default("");
export const settingsDraftSchema = z.strictObject({
  language: z.enum(["zh-CN", "en"]).default("zh-CN"),
  embyUrl: serviceAddressSchema(false),
  tmdbProxy: serviceAddressSchema(true),
});
export type SettingsDraft = z.infer<typeof settingsDraftSchema>;
export const settingsSchema = settingsDraftSchema.extend({
  tmdbKeyConfigured: z.boolean(),
  embyKeyConfigured: z.boolean(),
});
export type DesktopSettings = z.infer<typeof settingsSchema>;

export const taskStatusSchema = z.enum([
  "PENDING",
  "PROCESSING",
  "AWAITING_CONFIRMATION",
  "DONE",
  "FAILED",
  "SKIPPED",
  "CORRECTED",
]);
export const deliveryStatusSchema = z.enum([
  "NOT_READY",
  "REFRESH_PENDING",
  "WAITING_LIBRARY",
  "COLLECTED",
  "NEEDS_ATTENTION",
]);
export const taskSchema = z.strictObject({
  id: z.uuid(),
  sourceId: z.uuid(),
  sourcePath: z.string(),
  title: z.string().nullable(),
  status: taskStatusSchema,
  deliveryStatus: deliveryStatusSchema,
  targetPath: z.string().nullable(),
  correctedFromId: z.uuid().nullable().optional(),
  correctedToId: z.uuid().nullable().optional(),
  activeCorrectionId: z.uuid().nullable().optional(),
  updatedAt: z.string(),
});
export type MediaTask = z.infer<typeof taskSchema>;
export const pageInputSchema = z.strictObject({
  page: z.number().int().min(1).max(1000000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  status: taskStatusSchema.optional(),
});
export type PageInput = z.infer<typeof pageInputSchema>;
export const taskPageSchema = z.strictObject({
  items: z.array(taskSchema).max(100),
  total: z.number().int().nonnegative(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type TaskPage = z.infer<typeof taskPageSchema>;
export const jobSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["ingestion", "correction"]),
  state: z.string().max(64),
  updatedAt: z.string(),
});
export type DesktopJob = z.infer<typeof jobSchema>;
export const coreStatusSchema = z.strictObject({
  schemaVersion: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  mode: z.enum(["manual-only", "automatic-enabled"]),
  parser: z.enum(["unavailable", "ready"]),
  correctionFiles: z.enum(["unavailable", "ready"]).default("unavailable"),
});
export type CoreStatus = z.infer<typeof coreStatusSchema>;
export const runtimeSchema = z.strictObject({
  appVersion: z.string(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  core: z.enum(["starting", "ready", "failed", "stopping"]),
  detail: z.string().max(500).nullable(),
  status: coreStatusSchema.nullable(),
});
export type DesktopRuntime = z.infer<typeof runtimeSchema>;

const empty = z.strictObject({});
export const coreActions = {
  ...correctionActions,
  ...sourceRuleActions,
  ...ingestionActions,
  ...embyActions,
  "cloud.downloads.pause-status": cloudActions["cloud.downloads.pause-status"],
  "cloud.downloads.set-paused": cloudActions["cloud.downloads.set-paused"],
  "cloud.subscriptions.configure": cloudActions["cloud.subscriptions.configure"],
  "cloud.subscriptions.list": cloudActions["cloud.subscriptions.list"],
  "cloud.subscriptions.control": cloudActions["cloud.subscriptions.control"],
  "cloud.roots.list": cloudActions["cloud.roots.list"],
  "cloud.downloads.preview": cloudActions["cloud.downloads.preview"],
  "cloud.downloads.get-preview": cloudActions["cloud.downloads.get-preview"],
  "cloud.downloads.confirm": cloudActions["cloud.downloads.confirm"],
  "cloud.downloads.list": cloudActions["cloud.downloads.list"],
  "cloud.downloads.control": cloudActions["cloud.downloads.control"],
  "cloud.accounts.list": cloudActions["cloud.accounts.list"],
  "cloud.authorizations.get": cloudActions["cloud.authorizations.get"],
  "cloud.remote.list": cloudActions["cloud.remote.list"],
  "cloud.remote.stat": cloudActions["cloud.remote.stat"],
  "cloud.diagnostics": { input: empty, output: cloudDiagnosticCountsSchema },
  "runtime.get": { input: empty, output: coreStatusSchema },
  "sources.list": { input: empty, output: z.array(sourceSchema).max(1000) },
  "sources.save": { input: sourceDraftSchema, output: sourceSchema },
  "sources.pause": {
    input: z.strictObject({ id: z.uuid(), paused: z.boolean() }),
    output: sourceSchema,
  },
  "tasks.list": { input: pageInputSchema, output: taskPageSchema },
  "jobs.list": { input: empty, output: z.array(jobSchema).max(100) },
  "settings.get": { input: empty, output: settingsDraftSchema },
  "settings.save": { input: settingsDraftSchema, output: settingsDraftSchema },
} as const;
export type CoreAction = keyof typeof coreActions;
export type CoreInput<K extends CoreAction> = z.input<
  (typeof coreActions)[K]["input"]
>;
export type CoreOutput<K extends CoreAction> = z.output<
  (typeof coreActions)[K]["output"]
>;
export const coreActionSchema = z.enum(
  Object.keys(coreActions) as [CoreAction, ...CoreAction[]],
);
export const requestSchema = z.strictObject({
  kind: z.literal("request"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  action: coreActionSchema,
  payload: z.unknown(),
});
export type CoreRequest = z.infer<typeof requestSchema>;
export const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    kind: z.literal("response"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal("response"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(),
    ok: z.literal(false),
    error: rpcErrorSchema,
  }),
]);
export type CoreResponse = z.infer<typeof responseSchema>;
export const credentialSchema = z.strictObject({
  kind: z.enum(["tmdb", "emby"]),
  value: z.string().trim().max(1024),
});
export const nativeActions = {
  "desktop.host-preferences.get": empty,
  "desktop.host-preferences.save": hostPreferencesDraftSchema,
  "desktop.about": empty,
  "desktop.license": z.strictObject({ id: licenseIdSchema }),
  "desktop.ingestion.configure": ingestionConfigureSchema,
  "desktop.media.choose-target": z.strictObject({ mediaType: z.enum(["MOVIE", "TV_SHOW"]) }),
  "desktop.emby.open": z.strictObject({ taskId: z.uuid() }),
  "desktop.upgrade.prepare": empty,
  "desktop.upgrade.restore": empty,
  "desktop.cloud.choose-root": empty,
  "desktop.cloud.open-completed": z.strictObject({ jobId: z.uuid() }),
  "desktop.cloud.authorize": cloudCredentialDraftSchema,
  "desktop.cloud.login": cloudLoginDraftSchema,
  "desktop.cloud.cancel-login": z.strictObject({ requestKey: z.uuid() }),
  "desktop.cloud.disconnect": z.strictObject({ accountId: z.uuid() }),
  "desktop.cloud.restore": empty,
  "desktop.runtime": empty,
  "desktop.choose-directory": z.strictObject({
    purpose: z.enum(["source", "target"]),
  }),
  "desktop.credentials.save": credentialSchema,
  "desktop.settings": empty,
  "desktop.restart-core": empty,
  "desktop.diagnostics.export": empty,
} as const;
export type NativeAction = keyof typeof nativeActions;

export interface DesktopApi {
  checkLocalSourceHealth(input: CoreInput<"source-rules.local-health">): Promise<CoreOutput<"source-rules.local-health">>;
  onBeforeReload(listener: () => Promise<void>): () => void;
  getHostPreferences(): Promise<HostPreferences>;
  saveHostPreferences(input: HostPreferencesDraft): Promise<HostPreferences>;
  getDesktopAbout(): Promise<DesktopAbout>;
  getLicenseText(id: LicenseId): Promise<LicenseText>;
  getCorrectionScope(input: CoreInput<"corrections.scope">): Promise<CoreOutput<"corrections.scope">>;
  previewCorrectionBatch(input: CoreInput<"corrections.preview-batch">): Promise<CoreOutput<"corrections.preview-batch">>;
  confirmCorrectionBatch(input: CoreInput<"corrections.confirm-batch">): Promise<CoreOutput<"corrections.confirm-batch">>;
  cancelCorrectionBatch(input: CoreInput<"corrections.cancel-batch">): Promise<CoreOutput<"corrections.cancel-batch">>;
  listCorrectionBatches(input: CoreInput<"corrections.batches">): Promise<CoreOutput<"corrections.batches">>;
  getCorrectionBatch(input: CoreInput<"corrections.batch">): Promise<CoreOutput<"corrections.batch">>;
  getCorrectionTask(taskId: string): Promise<CoreOutput<"corrections.task">>;
  previewCorrection(input: CoreInput<"corrections.preview">): Promise<CoreOutput<"corrections.preview">>;
  getCorrectionPreview(id: string): Promise<CoreOutput<"corrections.get-preview">>;
  confirmCorrection(input: CoreInput<"corrections.confirm">): Promise<CoreOutput<"corrections.confirm">>;
  getCorrectionPreparation(id: string): Promise<CoreOutput<"corrections.preparation">>;
  cancelCorrectionPreparation(id: string): Promise<CoreOutput<"corrections.cancel-preparation">>;
  listCorrections(input: CoreInput<"corrections.list">): Promise<CoreOutput<"corrections.list">>;
  getCorrection(id: string): Promise<CoreOutput<"corrections.get">>;
  retryCorrection(id: string): Promise<CoreOutput<"corrections.retry">>;
  previewSourceExecution(input: CoreInput<"source-rules.preview-execution">): Promise<CoreOutput<"source-rules.preview-execution">>;
  getSourceExecutionPreview(id: string): Promise<CoreOutput<"source-rules.get-execution-preview">>;
  executeSourcePreview(input: CoreInput<"source-rules.execute">): Promise<CoreOutput<"source-rules.execute">>;
  controlSourceRule(input: CoreInput<"source-rules.control">): Promise<CoreOutput<"source-rules.control">>;
  runSourceOnce(input: CoreInput<"source-rules.run-once">): Promise<CoreOutput<"source-rules.run-once">>;
  listSourceRuns(input: CoreInput<"source-rules.runs">): Promise<CoreOutput<"source-rules.runs">>;
  getOrganizePause(): Promise<CoreOutput<"ingestion.pause-status">>;
  setOrganizePause(input: CoreInput<"ingestion.set-paused">): Promise<CoreOutput<"ingestion.set-paused">>;
  resolveSourceLegacy(input: CoreInput<"source-rules.resolve-legacy">): Promise<CoreOutput<"source-rules.resolve-legacy">>;
  listSourceLegacy(input: CoreInput<"source-rules.legacy">): Promise<CoreOutput<"source-rules.legacy">>;
  configureSourceRule(input: CoreInput<"source-rules.configure">): Promise<CoreOutput<"source-rules.configure">>;
  listSourceRules(input?: CoreInput<"source-rules.list">): Promise<CoreOutput<"source-rules.list">>;
  removeSourceRule(input: CoreInput<"source-rules.remove">): Promise<CoreOutput<"source-rules.remove">>;
  restoreSourceRule(input: CoreInput<"source-rules.restore">): Promise<CoreOutput<"source-rules.restore">>;
  getSourceRule(id: string): Promise<CoreOutput<"source-rules.get">>;
  previewSourceRule(input: CoreInput<"source-rules.preview">): Promise<CoreOutput<"source-rules.preview">>;
  getSourceRulePreview(id: string): Promise<CoreOutput<"source-rules.get-preview">>;
  applySourceRule(input: CoreInput<"source-rules.apply">): Promise<CoreOutput<"source-rules.apply">>;
  listMediaLibraries(): Promise<CoreOutput<"media.libraries">>;
  chooseMediaTarget(mediaType: "MOVIE" | "TV_SHOW"): Promise<CoreOutput<"media.libraries">>;
  getEmbyConfiguration(): Promise<CoreOutput<"emby.configuration">>;
  listEmbyLibraries(): Promise<CoreOutput<"emby.libraries">>;
  connectEmby(input: CoreInput<"emby.connect">): Promise<CoreOutput<"emby.connect">>;
  retryEmby(taskId: string): Promise<void>;
  openEmby(taskId: string): Promise<void>;
  configureManagedIngestion(input: z.input<typeof ingestionConfigureSchema>): Promise<DesktopSource>;
  listIngestionCandidates(input: CoreInput<"ingestion.candidates">): Promise<CoreOutput<"ingestion.candidates">>;
  scanIngestion(sourceId: string, requestKey: string): Promise<CoreOutput<"ingestion.scan">>;
  listIngestionScans(input: CoreInput<"ingestion.scans">): Promise<CoreOutput<"ingestion.scans">>;
  getIngestionScan(input: CoreInput<"ingestion.scan-job">): Promise<CoreOutput<"ingestion.scan-job">>;
  reviewIngestionContent(input: CoreInput<"ingestion.review-content">): Promise<CoreOutput<"ingestion.review-content">>;
  listContentReviews(input: CoreInput<"ingestion.content-reviews">): Promise<CoreOutput<"ingestion.content-reviews">>;
  listContentReviewFiles(input: CoreInput<"ingestion.content-review-files">): Promise<CoreOutput<"ingestion.content-review-files">>;
  cancelContentReview(id: string): Promise<CoreOutput<"ingestion.cancel-content-review">>;
  previewOrganizeBatch(input: CoreInput<"ingestion.preview-organize-batch">): Promise<CoreOutput<"ingestion.preview-organize-batch">>;
  listOrganizeBatches(input: CoreInput<"ingestion.organize-batches">): Promise<CoreOutput<"ingestion.organize-batches">>;
  getOrganizeBatch(input: CoreInput<"ingestion.organize-batch">): Promise<CoreOutput<"ingestion.organize-batch">>;
  getOrganizeBatchAssets(input: CoreInput<"ingestion.organize-batch-assets">): Promise<CoreOutput<"ingestion.organize-batch-assets">>;
  confirmOrganizeBatch(input: CoreInput<"ingestion.confirm-organize-batch">): Promise<CoreOutput<"ingestion.confirm-organize-batch">>;
  cancelOrganizeBatch(id: string): Promise<CoreOutput<"ingestion.cancel-organize-batch">>;
  listIngestionSeasons(input: CoreInput<"ingestion.seasons">): Promise<CoreOutput<"ingestion.seasons">>;
  getIngestionSeason(input: CoreInput<"ingestion.season">): Promise<CoreOutput<"ingestion.season">>;
  listIngestionDirectories(input: CoreInput<"ingestion.directories">): Promise<CoreOutput<"ingestion.directories">>;
  getIngestionDirectory(input: CoreInput<"ingestion.directory">): Promise<CoreOutput<"ingestion.directory">>;
  recognizeIngestionBatch(input: CoreInput<"ingestion.recognize-batch">): Promise<CoreOutput<"ingestion.recognize-batch">>;
  listRecognitionBatches(input: CoreInput<"ingestion.recognition-batches">): Promise<CoreOutput<"ingestion.recognition-batches">>;
  listRecognitionBatchItems(input: CoreInput<"ingestion.recognition-batch-items">): Promise<CoreOutput<"ingestion.recognition-batch-items">>;
  cancelRecognitionBatch(id: string): Promise<CoreOutput<"ingestion.cancel-recognition-batch">>;
  recognizeIngestion(input: CoreInput<"ingestion.recognize">): Promise<CoreOutput<"ingestion.recognize">>;
  previewRecognitionEdit(input: CoreInput<"ingestion.preview-recognition-edit">): Promise<CoreOutput<"ingestion.preview-recognition-edit">>;
  saveRecognitionEdit(input: CoreInput<"ingestion.save-recognition-edit">): Promise<CoreOutput<"ingestion.save-recognition-edit">>;
  getIngestionTask(taskId: string): Promise<CoreOutput<"ingestion.task">>;
  previewOrganize(input: CoreInput<"ingestion.preview">): Promise<CoreOutput<"ingestion.preview">>;
  confirmOrganize(input: CoreInput<"ingestion.confirm">): Promise<CoreOutput<"ingestion.confirm">>;
  retryOrganize(taskId: string): Promise<void>;
  getCloudDownloadPause(): Promise<CloudOutput<"cloud.downloads.pause-status">>;
  setCloudDownloadPause(input: CloudInput<"cloud.downloads.set-paused">): Promise<CloudOutput<"cloud.downloads.set-paused">>;
  configureCloudSubscription(input: CloudInput<"cloud.subscriptions.configure">): Promise<CloudSubscription>;
  listCloudSubscriptions(input: CloudInput<"cloud.subscriptions.list">): Promise<CloudOutput<"cloud.subscriptions.list">>;
  controlCloudSubscription(input: CloudInput<"cloud.subscriptions.control">): Promise<CloudSubscription>;
  listDownloadRoots(): Promise<ManagedDownloadRoot[]>;
  chooseDownloadRoot(): Promise<ManagedDownloadRoot | null>;
  previewDownload(input: CloudInput<"cloud.downloads.preview">): Promise<DownloadPreview>;
  getDownloadPreview(requestKey: string): Promise<DownloadPreview | null>;
  confirmDownload(input: CloudInput<"cloud.downloads.confirm">): Promise<{ jobId: string }>;
  listDownloads(input: CloudInput<"cloud.downloads.list">): Promise<CloudOutput<"cloud.downloads.list">>;
  controlDownload(input: CloudInput<"cloud.downloads.control">): Promise<{ jobId: string }>;
  openDownloadDirectory(jobId: string): Promise<void>;
  listCloudAccounts(): Promise<CloudAccount[]>;
  authorizeCloudAccount(input: CloudCredentialDraft): Promise<CloudAuthorization>;
  loginCloudAccount(input: CloudLoginDraft): Promise<CloudAuthorization | null>;
  cancelCloudLogin(requestKey: string): Promise<void>;
  getCloudAuthorization(requestKey: string): Promise<CloudAuthorization | null>;
  disconnectCloudAccount(accountId: string): Promise<void>;
  restoreCloudAccounts(): Promise<void>;
  listRemote(input: { accountId: string; parentRef: string; cursor?: string | null; pageSize?: number; refresh?: boolean }): Promise<RemotePage>;
  statRemote(accountId: string, ref: string): Promise<RemoteEntry>;
  getRuntime(): Promise<DesktopRuntime>;
  listSources(): Promise<DesktopSource[]>;
  saveSource(input: SourceDraft): Promise<DesktopSource>;
  pauseSource(id: string, paused: boolean): Promise<DesktopSource>;
  listTasks(input: PageInput): Promise<TaskPage>;
  listJobs(): Promise<DesktopJob[]>;
  getSettings(): Promise<DesktopSettings>;
  saveSettings(input: SettingsDraft): Promise<SettingsDraft>;
  saveCredential(kind: "tmdb" | "emby", value: string): Promise<void>;
  chooseDirectory(purpose: "source" | "target"): Promise<string | null>;
  restartCore(): Promise<void>;
  prepareDesktopUpgrade(): Promise<void>;
  restoreDesktopUpgrade(): Promise<void>;
  exportDiagnostics(): Promise<boolean>;
}

export function checkMessageSize(
  value: unknown,
  maximum = MAX_MESSAGE_BYTES,
): void {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new DesktopError("INVALID_REQUEST", "消息不是可序列化数据");
  }
  if (!json || new TextEncoder().encode(json).byteLength > maximum)
    throw new DesktopError("INVALID_REQUEST", "消息超过允许大小");
}
export function parseCoreRequest(value: unknown): CoreRequest {
  checkMessageSize(value);
  if (
    value &&
    typeof value === "object" &&
    "protocolVersion" in value &&
    value.protocolVersion !== PROTOCOL_VERSION
  )
    throw new DesktopError("PROTOCOL_MISMATCH", "组件协议版本不兼容");
  const request = requestSchema.safeParse(value);
  if (!request.success)
    throw new DesktopError("INVALID_REQUEST", "业务动作或请求格式无效");
  const payload = coreActions[request.data.action].input.safeParse(
    request.data.payload,
  );
  if (!payload.success)
    throw new DesktopError("INVALID_REQUEST", "业务参数无效");
  return { ...request.data, payload: payload.data };
}
export function publicError(error: unknown): RpcError {
  if (error instanceof CloudError) return cloudFailure(error);
  if (error instanceof DesktopError)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.directoryIssue ? { directoryIssue: directoryIssueSchema.parse(error.directoryIssue) } : {}),
      ...(error.code === "RATE_LIMITED" && error.retryAfterSeconds && error.retryAfterSeconds <= 3600 ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    };
  // 文件系统、数据库和网络原始错误可能包含个人路径或凭据。
  return {
    code: "INTERNAL_ERROR",
    message: "操作失败，请检查配置或重试",
    retryable: true,
  };
}
