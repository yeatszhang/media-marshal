import { z } from "zod";
import { syncGlobIssue } from "./sync-glob.js";

const id = z.uuid();
const revision = z.number().int().nonnegative().safe();
const version = z.number().int().positive().safe();
const path = z.string().min(1).max(4096).refine((value) => !/[\0\r\n]/.test(value), "目录路径不能包含控制字符");
const name = z.string().trim().min(1).max(100);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);

/** 公开目录身份不包含 Main 的 grant、卷身份、文件描述符或访问凭据。 */
export const directoryBindingSchema = z.strictObject({ id, version, path });
export type DirectoryBinding = z.infer<typeof directoryBindingSchema>;
export const directorySelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("default") }),
  z.strictObject({ kind: z.literal("directory"), directoryId: id }),
]);
export type DirectorySelection = z.infer<typeof directorySelectionSchema>;
export const defaultDownloadDirectorySchema = z.strictObject({ version: revision, directory: directoryBindingSchema.nullable() });
export type DefaultDownloadDirectory = z.infer<typeof defaultDownloadDirectorySchema>;
export const defaultDownloadDirectoryWriteSchema = z.strictObject({ expectedVersion: revision, directoryId: id.nullable(), requestKey: id });

export const syncFilterSchema = z.strictObject({ action: z.enum(["include", "exclude"]), pattern: z.string().min(1).max(4096).refine((value) => !/[\0\r\n]/.test(value), "过滤表达式必须为单行"), caseSensitive: z.boolean().default(true) }).superRefine((value, context) => {
  const issue = syncGlobIssue(value.pattern, value.action);
  if (issue) context.addIssue({ code: "custom", path: ["pattern"], message: issue });
});
export type SyncFilter = z.infer<typeof syncFilterSchema>;
const periodic = z.strictObject({ enabled: z.boolean().default(false), intervalSeconds: z.number().int().min(60).max(604800).default(900) }).default({ enabled: false, intervalSeconds: 900 });
const syncFields = {
  name,
  target: directorySelectionSchema.default({ kind: "default" }),
  filters: z.array(syncFilterSchema).max(200).default([]),
  periodic,
};

/** 新同步来源不接受 organization；旧配置只由 source-rules 的历史读取契约解析。 */
export const syncSourceConfigurationSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...syncFields, type: z.literal("local"), inputDirectoryId: id, client: z.enum(["quark", "custom"]).default("custom") }),
  z.strictObject({ ...syncFields, type: z.literal("cloud"), accountId: id, remoteRef: id }),
]);
export type SyncSourceConfiguration = z.infer<typeof syncSourceConfigurationSchema>;

const edit = { id, expectedVersion: revision, expectedDraftRevision: revision, expectedLifecycleRevision: revision, requestKey: id };
export const syncSourceWriteSchema = z.strictObject({ ...edit, configuration: syncSourceConfigurationSchema });
export const syncSourceSnapshotSchema = z.strictObject({
  sourceId: id, sourceVersion: version, configuration: syncSourceConfigurationSchema,
  inputDirectory: directoryBindingSchema.nullable(), targetDirectory: directoryBindingSchema,
  defaultDirectoryVersion: revision.nullable(),
}).superRefine((value, context) => {
  if ((value.configuration.type === "local") !== (value.inputDirectory !== null)) context.addIssue({ code: "custom", path: ["inputDirectory"], message: "仅本地来源绑定本机输入" });
  if (value.configuration.type === "local" && value.inputDirectory?.id !== value.configuration.inputDirectoryId) context.addIssue({ code: "custom", path: ["inputDirectory"], message: "输入目录与来源配置不一致" });
  const target = value.configuration.target;
  if (target.kind === "directory" && (target.directoryId !== value.targetDirectory.id || value.defaultDirectoryVersion !== null)) context.addIssue({ code: "custom", path: ["targetDirectory"], message: "显式同步目标与快照不一致" });
  if (target.kind === "default" && value.defaultDirectoryVersion === null) context.addIssue({ code: "custom", path: ["defaultDirectoryVersion"], message: "默认目录必须冻结设置版本" });
});
export type SyncSourceSnapshot = z.infer<typeof syncSourceSnapshotSchema>;

export const recognitionTargetSchema = z.strictObject({ id, name, mediaType: z.enum(["MOVIE", "TV_SHOW"]), directoryId: id, template: z.string().min(1).max(16384).nullable().default(null) });
export const recognitionRuleConfigurationSchema = z.strictObject({
  name, input: directorySelectionSchema.default({ kind: "default" }),
  client: z.enum(["quark", "custom"]).default("custom"),
  ignoredFilePatterns: z.array(z.string().trim().min(1).max(256).refine((value) => !/[\0\r\n]/.test(value))).max(100).nullable().default(null),
  targets: z.array(recognitionTargetSchema).max(100).refine((items) => new Set(items.map((item) => item.id)).size === items.length, "映射目标 ID 不能重复"),
  operation: z.literal("COPY").default("COPY"), automatic: z.boolean().default(false),
});
export type RecognitionRuleConfiguration = z.infer<typeof recognitionRuleConfigurationSchema>;
export const recognitionRuleWriteSchema = z.strictObject({ ...edit, configuration: recognitionRuleConfigurationSchema });

/** 绑定具体库根，不能只保存库名或库内第一条路径。 */
export const embyTargetBindingSchema = z.strictObject({
  id, version, targetId: id, targetDirectory: directoryBindingSchema,
  serverId: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/), connectionVersion: version,
  libraryId: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/), libraryRoot: path,
  mediaType: z.enum(["MOVIE", "TV_SHOW"]),
  conversion: z.strictObject({ id, version, localRoot: directoryBindingSchema, serverRoot: path, serverPathStyle: z.enum(["posix", "win32"]) }).nullable(),
});
export type EmbyTargetBinding = z.infer<typeof embyTargetBindingSchema>;
export const recognitionRuleSnapshotSchema = z.strictObject({
  ruleId: id, ruleVersion: version, configuration: recognitionRuleConfigurationSchema,
  inputDirectory: directoryBindingSchema, inputMode: z.enum(["ordinary", "managed-completed"]),
  defaultDirectoryVersion: revision.nullable(),
  targets: z.array(z.strictObject({ targetId: id, directory: directoryBindingSchema, embyBinding: embyTargetBindingSchema.nullable() })).max(100),
}).superRefine((value, context) => {
  const input = value.configuration.input;
  if (input.kind === "directory" && (input.directoryId !== value.inputDirectory.id || value.defaultDirectoryVersion !== null)) context.addIssue({ code: "custom", path: ["inputDirectory"], message: "识别输入与快照不一致" });
  if (input.kind === "default" && value.defaultDirectoryVersion === null) context.addIssue({ code: "custom", path: ["defaultDirectoryVersion"], message: "默认输入必须冻结设置版本" });
  const targets = new Map(value.targets.map((target) => [target.targetId, target]));
  if (targets.size !== value.targets.length || targets.size !== value.configuration.targets.length) context.addIssue({ code: "custom", path: ["targets"], message: "映射目标快照缺失或重复" });
  for (const target of value.configuration.targets) {
    const snapshot = targets.get(target.id);
    if (!snapshot || snapshot.directory.id !== target.directoryId) context.addIssue({ code: "custom", path: ["targets"], message: "映射目录与配置不一致" });
    const binding = snapshot?.embyBinding;
    if (binding && (binding.targetId !== target.id || binding.mediaType !== target.mediaType || binding.targetDirectory.id !== snapshot.directory.id || binding.targetDirectory.version !== snapshot.directory.version || binding.targetDirectory.path !== snapshot.directory.path)) context.addIssue({ code: "custom", path: ["targets"], message: "Emby 关联与目标版本不一致" });
  }
});
export type RecognitionRuleSnapshot = z.infer<typeof recognitionRuleSnapshotSchema>;

const ruleFields = {
  id, version: revision, draftRevision: version, lifecycleRevision: revision,
  paused: z.boolean(), deletedAt: z.string().nullable(),
  reviewReasons: z.array(z.enum(["LEGACY_AUTHORIZATION_MISSING", "LEGACY_POLICY_CONFLICT", "AUTOMATIC_REAUTHORIZATION_REQUIRED", "LEGACY_SCOPE_REVIEW_REQUIRED"])).max(4),
  createdAt: z.string(), updatedAt: z.string(),
};
export const syncSourceRuleSchema = z.strictObject({ ...ruleFields, draft: syncSourceConfigurationSchema, snapshot: syncSourceSnapshotSchema.nullable(), runtime: z.strictObject({ claimed: z.boolean(), nextScanAt: z.number().int().nullable(), failure: z.string().max(500).nullable() }).optional() });
export type SyncSourceRule = z.infer<typeof syncSourceRuleSchema>;
export const recognitionRuleSchema = z.strictObject({ ...ruleFields, draft: recognitionRuleConfigurationSchema, snapshot: recognitionRuleSnapshotSchema.nullable() });
export type RecognitionRule = z.infer<typeof recognitionRuleSchema>;

export const embyPathConversionWriteSchema = z.strictObject({
  id, expectedVersion: revision, requestKey: id,
  localDirectoryId: id, serverId: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/), connectionVersion: version,
  serverRoot: path, serverPathStyle: z.enum(["posix", "win32"]),
});

const previewVersion = z.strictObject({ id, version: revision, draftRevision: revision, lifecycleRevision: revision });
export const configurationPreviewContextSchema = z.strictObject({
  owner: previewVersion, configurationFingerprint: fingerprint,
  directories: z.array(directoryBindingSchema).max(201).refine((items) => new Set(items.map((item) => item.id)).size === items.length, "目录身份不能重复"),
  defaultDirectoryVersion: revision.nullable(), expiresAt: z.number().int().nonnegative().safe(),
});
export type ConfigurationPreviewContext = z.infer<typeof configurationPreviewContextSchema>;
export const configurationConfirmationSchema = z.strictObject({
  previewId: id, requestKey: id, context: configurationPreviewContextSchema,
});
export const recognitionAutomaticConsentSchema = z.strictObject({
  ruleId: id, ruleVersion: version, samplePreviewId: id, configurationFingerprint: fingerprint, accepted: z.literal(true),
});

/** 返回失效原因，调用者仍须从数据库与原生授权读取当前事实，不能信任页面回传。 */
export function configurationPreviewInvalidation(preview: ConfigurationPreviewContext, current: Omit<ConfigurationPreviewContext, "expiresAt">, now: number): "EXPIRED" | "CONFIGURATION_CHANGED" | "DEFAULT_DIRECTORY_CHANGED" | "DIRECTORY_CHANGED" | null {
  if (preview.expiresAt <= now) return "EXPIRED";
  if (preview.owner.id !== current.owner.id || preview.owner.version !== current.owner.version || preview.owner.draftRevision !== current.owner.draftRevision || preview.owner.lifecycleRevision !== current.owner.lifecycleRevision || preview.configurationFingerprint !== current.configurationFingerprint) return "CONFIGURATION_CHANGED";
  if (preview.defaultDirectoryVersion !== current.defaultDirectoryVersion) return "DEFAULT_DIRECTORY_CHANGED";
  const directories = new Map(current.directories.map((directory) => [directory.id, directory]));
  if (preview.directories.length !== current.directories.length || preview.directories.some((directory) => { const actual = directories.get(directory.id); return !actual || actual.version !== directory.version || actual.path !== directory.path; })) return "DIRECTORY_CHANGED";
  return null;
}
