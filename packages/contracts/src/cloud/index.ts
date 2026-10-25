import { z } from "zod";

const id = z.uuid();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
const opaqueKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const cloudErrorCodeSchema = z.enum([
  "AUTH_REQUIRED", "RATE_LIMITED", "NETWORK_UNAVAILABLE", "REMOTE_CHANGED",
  "REMOTE_NOT_FOUND", "LOCAL_UNAVAILABLE", "UNSUPPORTED_CAPABILITY",
  "COMPONENT_UNAVAILABLE", "CONFLICT", "INVALID_REQUEST", "INTERRUPTED",
  "TIMEOUT", "INTERNAL_ERROR",
]);
export type CloudErrorCode = z.infer<typeof cloudErrorCodeSchema>;
const messages: Record<CloudErrorCode, string> = {
  AUTH_REQUIRED: "账号需要重新授权",
  RATE_LIMITED: "网盘请求受到限制，请稍后重试",
  NETWORK_UNAVAILABLE: "网络暂不可用",
  REMOTE_CHANGED: "远端内容已变化，需要重新核对",
  REMOTE_NOT_FOUND: "远端对象不可用，请重新选择",
  LOCAL_UNAVAILABLE: "下载目录不可用",
  UNSUPPORTED_CAPABILITY: "接入方式与传输能力不兼容",
  COMPONENT_UNAVAILABLE: "下载组件不可用",
  CONFLICT: "操作存在冲突，请查询当前状态",
  INVALID_REQUEST: "云端请求无效",
  INTERRUPTED: "执行已中断，请查询当前状态",
  TIMEOUT: "等待超时，请查询状态后重试",
  INTERNAL_ERROR: "云端操作失败，请重试或查看诊断",
};
export const cloudFailureSchema = z.strictObject({
  code: cloudErrorCodeSchema,
  message: z.string().max(200),
  retryable: z.boolean(),
  retryAfterSeconds: z.number().int().min(1).max(3600).optional(),
}).refine((failure) => failure.message === messages[failure.code], "错误消息必须经过归一化");
export type CloudFailure = z.infer<typeof cloudFailureSchema>;
export class CloudError extends Error {
  constructor(readonly code: CloudErrorCode, readonly retryAfterSeconds?: number) {
    super(messages[code]);
    this.name = "CloudError";
  }
}
export function cloudFailure(error: unknown): CloudFailure {
  const code = error instanceof CloudError ? error.code : "INTERNAL_ERROR";
  const retryable = ["RATE_LIMITED", "NETWORK_UNAVAILABLE", "COMPONENT_UNAVAILABLE", "TIMEOUT"].includes(code);
  const delay = error instanceof CloudError ? error.retryAfterSeconds : undefined;
  return {
    code, message: messages[code], retryable,
    ...(code === "RATE_LIMITED" && Number.isInteger(delay) && delay! > 0 && delay! <= 3600 ? { retryAfterSeconds: delay } : {}),
  };
}

export const transferSourceKindSchema = z.enum(["webdav"]);
export type TransferSourceKind = z.infer<typeof transferSourceKindSchema>;
export const driveCapabilitiesSchema = z.strictObject({
  authorizationMethods: z.array(z.literal("cookie")).min(1).max(1),
  accountIdentity: z.enum(["stable-id", "unavailable"]),
  objectIdentity: z.enum(["stable-id", "path"]),
  reliableRevision: z.boolean(),
  hashAlgorithms: z.array(z.enum(["sha256", "sha1", "md5"])).max(3),
  rangeRead: z.enum(["supported", "unavailable", "unknown"]),
  sourceKinds: z.array(transferSourceKindSchema).max(1),
});
export type DriveCapabilities = z.infer<typeof driveCapabilitiesSchema>;

export const versionEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("weak"), size: count, modifiedAt: timestamp.nullable() }),
  // revisionKey 是实现归一化的非敏感比较键，不是上游授权或对象 ID。
  z.strictObject({ kind: z.literal("revision"), revisionKey: opaqueKey }),
  z.strictObject({ kind: z.literal("hash"), algorithm: z.enum(["sha256", "sha1", "md5"]), value: z.string().regex(/^[a-f0-9]+$/) })
    .refine((hash) => hash.value.length === { sha256: 64, sha1: 40, md5: 32 }[hash.algorithm], "摘要长度不匹配"),
]);
export type VersionEvidence = z.infer<typeof versionEvidenceSchema>;
export const cloudAccountSchema = z.strictObject({
  id, name: z.string().trim().min(1).max(100), providerKind: z.literal("quark"),
  status: z.enum(["UNCONFIGURED", "READY", "AUTH_REQUIRED", "RESELECT_REQUIRED", "DISCONNECTED", "UNAVAILABLE"]),
  capabilities: driveCapabilitiesSchema.nullable(),
  rootRef: id.nullable().default(null),
});
export type CloudAccount = z.infer<typeof cloudAccountSchema>;
export const cloudAuthorizationSchema = z.strictObject({
  id, requestKey: id, accountId: id,
  state: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "INTERRUPTED"]),
  failure: cloudFailureSchema.nullable(), updatedAt: timestamp,
});
export type CloudAuthorization = z.infer<typeof cloudAuthorizationSchema>;
export const cloudCredentialDraftSchema = z.strictObject({
  accountId: id.optional(), name: z.string().trim().min(1).max(100), requestKey: id,
  cookie: z.string().trim().min(1).max(32768).refine((value) => !/[\r\n\0]/.test(value)),
});
export type CloudCredentialDraft = z.infer<typeof cloudCredentialDraftSchema>;
export const managedDownloadRootSchema = z.strictObject({ id, path: z.string().max(4096), state: z.enum(["AVAILABLE", "UNAVAILABLE", "REVIEW_REQUIRED"]), availableBytes: count.nullable() });
export type ManagedDownloadRoot = z.infer<typeof managedDownloadRootSchema>;
export const remoteEntrySchema = z.strictObject({
  accountId: id, ref: id, parentRef: id.nullable(),
  name: z.string().min(1).max(1024).refine((name) => !/[\0/]/.test(name) && name !== "." && name !== ".."),
  type: z.enum(["file", "directory"]), size: count.nullable(),
  modifiedAt: timestamp.nullable(), version: versionEvidenceSchema.nullable(),
});
export type RemoteEntry = z.infer<typeof remoteEntrySchema>;
export const remotePageSchema = z.strictObject({
  items: z.array(remoteEntrySchema).max(100), nextCursor: opaqueKey.nullable(),
  total: count.nullable(), complete: z.boolean(),
}).refine((page) => !page.complete || page.nextCursor === null, "完整分页不能保留游标");
export type RemotePage = z.infer<typeof remotePageSchema>;
export const downloadStateSchema = z.enum([
  "QUEUED", "RUNNING", "VERIFYING", "COMMITTING", "COMPLETED", "PAUSING", "PAUSED",
  "CANCELLING", "CANCELLED", "RETRY_WAIT", "AUTH_REQUIRED", "FAILED", "BLOCKED_LOCAL", "RECONCILING",
]);
export type DownloadState = z.infer<typeof downloadStateSchema>;
export const downloadProgressSchema = z.strictObject({
  bytes: count, totalBytes: count.nullable(), bytesPerSecond: z.number().min(0).finite(),
  completedItems: count, totalItems: count.nullable(),
});
export type DownloadProgress = z.infer<typeof downloadProgressSchema>;
export const cloudDiagnosticCountsSchema = z.strictObject({
  pausedItems: count, authenticationRequiredAccounts: count, authenticationRequiredItems: count, componentFailedItems: count,
});
export type CloudDiagnosticCounts = z.infer<typeof cloudDiagnosticCountsSchema>;
export const downloadJobSchema = z.strictObject({
  id, accountId: id, name: z.string().max(1024), state: downloadStateSchema, progress: downloadProgressSchema,
  ingestion: z.strictObject({ pending: count, candidates: count, organized: count, collected: count, needsAttention: count }).optional(),
  failure: cloudFailureSchema.nullable(), updatedAt: timestamp,
});
export type DownloadJob = z.infer<typeof downloadJobSchema>;
export const cloudFiltersSchema = z.strictObject({ extensions: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9]{1,12}$/)).max(32).default([]), names: z.array(z.string().min(1).max(1024).refine((name) => !/[\0/]/.test(name) && name !== "." && name !== "..")).max(100).default([]) }).default({ extensions: [], names: [] });
export const downloadPreviewSchema = z.strictObject({
  id, accountId: id, remoteRef: id, targetGrantId: id,
  files: count, bytes: count, complete: z.boolean(), weakComparison: z.boolean(),
  expiresAt: timestamp,
  state: z.enum(["BUILDING", "READY", "FAILED", "EXPIRED", "CONFIRMED"]), failure: cloudFailureSchema.nullable(),
  reuseFiles: count, conflicts: count, forceRedownload: z.boolean(), destinationPrefix: z.string().max(256), selectionPath: z.string().max(4096), layout: z.enum(["selection", "drive"]),
});
export type DownloadPreview = z.infer<typeof downloadPreviewSchema>;
export const cloudSubscriptionSchema = z.strictObject({
  id, accountId: id, remoteRef: id, targetGrantId: id, name: z.string().max(1024),
  filters: cloudFiltersSchema, intervalSeconds: z.number().int().min(60).max(604800), enabled: z.boolean(), configurationVersion: z.number().int().positive(),
  state: z.enum(["IDLE", "SCANNING", "RETRY_WAIT", "PAUSED", "AUTH_REQUIRED", "BLOCKED_LOCAL", "RESELECT_REQUIRED", "FAILED", "CANCELLED"]),
  failure: cloudFailureSchema.nullable(), lastScanAt: timestamp.nullable(), nextScanAt: timestamp.nullable(),
  lastResult: z.strictObject({ files: count, bytes: count, reused: count, conflicts: count, complete: z.boolean(), jobId: id.nullable() }).nullable(),
});
export type CloudSubscription = z.infer<typeof cloudSubscriptionSchema>;

const empty = z.strictObject({});
// 先定义契约；只有完成实现的动作才接入桌面 dispatch，不暴露通用代理。
export const cloudActions = {
  "cloud.downloads.pause-status": { input: empty, output: z.strictObject({ paused: z.boolean(), pausing: z.boolean() }) },
  "cloud.downloads.set-paused": { input: z.strictObject({ paused: z.boolean(), requestKey: id }), output: z.strictObject({ paused: z.boolean(), pausing: z.boolean() }) },
  "cloud.subscriptions.configure": {
    input: z.strictObject({ subscriptionId: id.optional(), configurationVersion: z.number().int().positive().optional(), previewId: id, intervalSeconds: z.number().int().min(60).max(604800).default(900), requestKey: id }),
    output: cloudSubscriptionSchema,
  },
  "cloud.subscriptions.list": {
    input: z.strictObject({ page: z.number().int().min(1).max(10000).default(1), pageSize: z.number().int().min(1).max(100).default(25) }),
    output: z.strictObject({ items: z.array(cloudSubscriptionSchema).max(100), total: count }),
  },
  "cloud.subscriptions.control": {
    input: z.strictObject({ subscriptionId: id, operation: z.enum(["scan", "pause", "resume", "cancel"]), requestKey: id }),
    output: cloudSubscriptionSchema,
  },
  "cloud.roots.list": { input: empty, output: z.array(managedDownloadRootSchema).max(100) },
  "cloud.accounts.list": { input: empty, output: z.array(cloudAccountSchema).max(100) },
  "cloud.authorizations.get": { input: z.strictObject({ requestKey: id }), output: cloudAuthorizationSchema.nullable() },
  "cloud.remote.list": {
    input: z.strictObject({ accountId: id, parentRef: id, cursor: opaqueKey.nullable().default(null), pageSize: z.number().int().min(1).max(100).default(50), refresh: z.boolean().default(false) }),
    output: remotePageSchema,
  },
  "cloud.remote.stat": { input: z.strictObject({ accountId: id, ref: id }), output: remoteEntrySchema },
  "cloud.downloads.preview": {
    input: z.strictObject({ accountId: id, remoteRef: id, targetGrantId: id, requestKey: id, filters: cloudFiltersSchema, forceRedownload: z.boolean().default(false), layout: z.enum(["selection", "drive"]).default("selection") }),
    output: downloadPreviewSchema,
  },
  "cloud.downloads.get-preview": { input: z.strictObject({ requestKey: id }), output: downloadPreviewSchema.nullable() },
  "cloud.downloads.confirm": {
    input: z.strictObject({ previewId: id, requestKey: id }), output: z.strictObject({ jobId: id }),
  },
  "cloud.downloads.list": {
    input: z.strictObject({ page: z.number().int().min(1).max(1_000_000).default(1), pageSize: z.number().int().min(1).max(100).default(25) }),
    output: z.strictObject({ items: z.array(downloadJobSchema).max(100), total: count }),
  },
  "cloud.downloads.control": {
    input: z.strictObject({ jobId: id, operation: z.enum(["pause", "resume", "cancel", "retry"]), requestKey: id }),
    output: z.strictObject({ jobId: id }),
  },
} as const;
export type CloudAction = keyof typeof cloudActions;
export type CloudInput<K extends CloudAction> = z.input<(typeof cloudActions)[K]["input"]>;
export type CloudOutput<K extends CloudAction> = z.output<(typeof cloudActions)[K]["output"]>;
export const cloudRequestSchema = z.strictObject({
  action: z.enum(Object.keys(cloudActions) as [CloudAction, ...CloudAction[]]), payload: z.unknown(),
});
export function parseCloudRequest(value: unknown) {
  const request = cloudRequestSchema.safeParse(value);
  if (!request.success) throw new CloudError("INVALID_REQUEST");
  const payload = cloudActions[request.data.action].input.safeParse(request.data.payload);
  if (!payload.success) throw new CloudError("INVALID_REQUEST");
  return { action: request.data.action, payload: payload.data };
}
