import { z } from "zod";
import { cloudFiltersSchema, downloadPreviewSchema, cloudFailureSchema } from "./cloud/index.js";

const id = z.uuid(), version = z.number().int().nonnegative(), path = z.string().min(1).max(4096);
const organization = z.strictObject({
  targetPath: path,
  mediaType: z.enum(["AUTO", "MOVIE", "TV_SHOW"]).default("AUTO"),
  operation: z.literal("COPY").default("COPY"),
  automatic: z.boolean().default(false),
});
/** 历史来源／活动操作的兼容格式；新职责契约使用 syncSourceConfigurationSchema。 */
export const sourceConfigurationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("local"), name: z.string().trim().min(1).max(100),
    client: z.enum(["quark", "baidu", "alipan", "custom"]).default("custom"),
    sourcePath: path, organization,
    ignoredFilePatterns: z.array(z.string().trim().min(1).max(256).regex(/^[^\r\n\0]*$/)).max(100).nullable().optional(),
  }),
  z.strictObject({
    type: z.literal("cloud"), name: z.string().trim().min(1).max(100),
    accountId: id, remoteRef: id, downloadRootId: id,
    filters: cloudFiltersSchema.transform((value) => ({ extensions: [...new Set(value.extensions)].sort(), names: [...new Set(value.names)].sort(), ...(value.rules ? { rules: value.rules } : {}) })),
    periodic: z.strictObject({ enabled: z.boolean().default(false), intervalSeconds: z.number().int().min(60).max(604800).default(900) }).default({ enabled: false, intervalSeconds: 900 }),
    organization: organization.nullable().default(null),
  }),
]);
export type SourceConfiguration = z.output<typeof sourceConfigurationSchema>;
export const sourceRuleSchema = z.strictObject({
  id, type: z.enum(["local", "cloud"]), version, draftRevision: version,
  draft: sourceConfigurationSchema, configuration: sourceConfigurationSchema.nullable(),
  paused: z.boolean(), reviewRequired: z.boolean(),
  deletedAt: z.string().nullable().optional(), lifecycleRevision: version.optional(),
  localSourceId: id.nullable(), subscriptionId: id.nullable(), ingestionSourceId: id.nullable(),
  createdAt: z.string(), updatedAt: z.string(),
  remoteName: z.string().max(1024).nullable().optional(),
  lastRun: z.lazy(() => sourceRunSchema).nullable().optional(),
});
export type SourceRule = z.output<typeof sourceRuleSchema>;
export const localDirectoryHealthSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("AVAILABLE") }),
  z.strictObject({ state: z.literal("UNVERIFIED"), reason: z.enum(["WAITING_AUTHORIZATION", "RECHECK_REQUIRED", "CONFIGURATION_REVIEW_REQUIRED"]) }),
  z.strictObject({ state: z.literal("UNAVAILABLE"), reason: z.enum(["ORIGINAL_DIRECTORY_UNAVAILABLE", "PERMISSION_DENIED"]) }),
]);
export type LocalDirectoryHealth = z.output<typeof localDirectoryHealthSchema>;
export const localSourceHealthSchema = z.strictObject({
  sourceId: id, version: z.number().int().positive(), lifecycleRevision: version,
  checkedAt: z.iso.datetime(), input: localDirectoryHealthSchema, target: localDirectoryHealthSchema,
  previous: z.strictObject({ checkedAt: z.iso.datetime(), input: localDirectoryHealthSchema, target: localDirectoryHealthSchema }).optional(),
});
export type LocalSourceHealth = z.output<typeof localSourceHealthSchema>;
export const sourceRuleDraftSchema = z.strictObject({
  id, expectedVersion: version, expectedDraftRevision: version, requestKey: id,
  expectedLifecycleRevision: version.optional(),
  configuration: sourceConfigurationSchema,
});
export const automaticSampleSchema = z.strictObject({ previewId: id, title: z.string().max(500), sourcePath: z.string().max(16384), targetPath: z.string().max(16384), size: z.number().int().positive() });
export type AutomaticSample = z.infer<typeof automaticSampleSchema>;
export const sourceRulePreviewSchema = z.strictObject({
  id, sourceId: id, version, draftRevision: version, configuration: sourceConfigurationSchema,
  lifecycleRevision: version.optional(),
  state: z.enum(["BUILDING", "READY", "FAILED", "EXPIRED", "APPLIED"]), expiresAt: z.number().int(),
  download: downloadPreviewSchema.nullable(),
  automaticSample: automaticSampleSchema.nullable().optional(), automaticBlockedReason: z.string().max(500).nullable().optional(),
  organizationConflicts: z.array(z.strictObject({ sourceId: id, name: z.string().max(100) })).max(1000),
});
export type SourceRulePreview = z.output<typeof sourceRulePreviewSchema>;
export const sourceRuleApplySchema = z.strictObject({ previewId: id, requestKey: id, runOnce: z.boolean().default(false), automaticConsent: z.strictObject({ previewId: id, accepted: z.literal(true) }).optional(), historyConsent: z.strictObject({ accepted: z.literal(true) }).optional() });
export const sourceLegacyReferenceSchema = z.strictObject({
  kind: z.enum(["local-source", "subscription", "managed-binding", "download-job"]), id, sourceId: id.nullable(),
  status: z.enum(["MAPPED", "REVIEW_REQUIRED", "HISTORICAL"]),
  reason: z.enum(["NONE", "NO_AUTHORIZATION", "AMBIGUOUS_OWNERSHIP", "SNAPSHOT_UNAVAILABLE", "UNCONFIRMED", "CANCELLED", "NO_SOURCE"]),
});
export type SourceLegacyReference = z.output<typeof sourceLegacyReferenceSchema>;
const sourceCommand = z.strictObject({ id, expectedVersion: version, expectedLifecycleRevision: version.optional(), requestKey: id });
const lifecycleCommand = sourceCommand.extend({ expectedDraftRevision: version, expectedLifecycleRevision: version });
export const sourceRunSchema = z.strictObject({
  id, sourceId: id, sourceVersion: version, state: z.enum(["QUEUED", "SCANNING", "SUBMITTED", "FAILED", "ABANDONED"]),
  jobId: id.nullable(), failure: cloudFailureSchema.nullable(), createdAt: z.string(), updatedAt: z.string(),
  forceRedownload: z.boolean().default(false),
});
export type SourceRun = z.output<typeof sourceRunSchema>;
export const sourceExecutionPreviewSchema = z.strictObject({
  id, sourceId: id, sourceVersion: version, name: z.string().max(100), forceRedownload: z.boolean(),
  lifecycleRevision: version.optional(),
  state: z.enum(["BUILDING", "READY", "FAILED", "EXPIRED", "APPLIED"]), expiresAt: z.number().int(),
  download: downloadPreviewSchema, run: sourceRunSchema.nullable(),
});
export type SourceExecutionPreview = z.output<typeof sourceExecutionPreviewSchema>;
export const sourceRuleActions = {
  "source-rules.local-health": {
    input: z.strictObject({ items: z.array(z.strictObject({ id, expectedVersion: z.number().int().positive(), expectedLifecycleRevision: version })).min(1).max(25).refine((items) => new Set(items.map((value) => value.id)).size === items.length, "来源不能重复"), force: z.boolean().default(false) }),
    output: z.strictObject({ items: z.array(localSourceHealthSchema).max(25) }),
  },
  "source-rules.remove": { input: lifecycleCommand, output: sourceRuleSchema },
  "source-rules.restore": { input: lifecycleCommand, output: sourceRuleSchema },
  "source-rules.preview-execution": { input: sourceCommand.extend({ forceRedownload: z.boolean().default(false) }), output: sourceExecutionPreviewSchema },
  "source-rules.get-execution-preview": { input: z.strictObject({ id }), output: sourceExecutionPreviewSchema.nullable() },
  "source-rules.execute": { input: z.strictObject({ previewId: id, requestKey: id }), output: sourceRunSchema },
  "source-rules.control": { input: sourceCommand.extend({ operation: z.enum(["pause", "resume", "scan"]) }), output: sourceRuleSchema },
  "source-rules.run-once": { input: sourceCommand, output: sourceRunSchema },
  "source-rules.runs": { input: z.strictObject({ sourceId: id, page: z.number().int().min(1).max(1000000).default(1), pageSize: z.number().int().min(1).max(100).default(25) }), output: z.strictObject({ items: z.array(sourceRunSchema).max(100), total: z.number().int().nonnegative() }) },
  "source-rules.resolve-legacy": { input: sourceLegacyReferenceSchema.pick({ kind: true, id: true }), output: sourceLegacyReferenceSchema.nullable() },
  "source-rules.legacy": { input: z.strictObject({ page: z.number().int().min(1).max(1000000).default(1), pageSize: z.number().int().min(1).max(100).default(25), status: sourceLegacyReferenceSchema.shape.status.optional() }), output: z.strictObject({ items: z.array(sourceLegacyReferenceSchema).max(100), total: z.number().int().nonnegative() }) },
  "source-rules.configure": { input: sourceRuleDraftSchema, output: sourceRuleSchema },
  "source-rules.list": { input: z.strictObject({ includeDeleted: z.boolean().optional() }), output: z.array(sourceRuleSchema).max(1000) },
  "source-rules.get": { input: z.strictObject({ id }), output: sourceRuleSchema.nullable() },
  "source-rules.preview": { input: z.strictObject({ id, expectedVersion: version, expectedDraftRevision: version, expectedLifecycleRevision: version.optional(), requestKey: id }), output: sourceRulePreviewSchema },
  "source-rules.get-preview": { input: z.strictObject({ id }), output: sourceRulePreviewSchema.nullable() },
  "source-rules.apply": { input: sourceRuleApplySchema, output: sourceRuleSchema },
} as const;
