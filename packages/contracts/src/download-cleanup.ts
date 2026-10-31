import { z } from "zod";

/** 文件删除进度独立于整理及 Emby 交付；页面只能提交业务 ID。 */
export const downloadCleanupPhaseSchema = z.enum([
  "PENDING", "WAITING_REFERENCES", "CLAIMED", "QUARANTINED", "REMOVING",
  "SOURCE_REMOVED", "CACHE_PENDING", "DONE", "NEEDS_ATTENTION",
]);
export const downloadCleanupSchema = z.strictObject({
  id: z.uuid(), receiptId: z.uuid().nullable(), taskId: z.uuid().nullable(),
  kind: z.enum(["SOURCE", "TEMPORARY"]).default("SOURCE"),
  phase: downloadCleanupPhaseSchema,
  resumePhase: downloadCleanupPhaseSchema.nullable(),
  sourcePath: z.string().max(4096), targetPath: z.string().max(4096),
  size: z.number().int().nonnegative(), freedBytes: z.number().int().nonnegative(),
  waitingReason: z.string().max(500).nullable(), failure: z.string().max(500).nullable(),
  updatedAt: z.string(),
});
export type DownloadCleanup = z.infer<typeof downloadCleanupSchema>;

export const downloadCleanupPreviewSchema = z.strictObject({
  id: z.uuid(), state: z.enum(["PREPARING", "READY", "BLOCKED", "CONFIRMED", "CANCELLED", "EXPIRED"]),
  items: z.array(z.strictObject({ receiptId: z.uuid(), sourcePath: z.string().max(4096), targetPath: z.string().max(4096), size: z.number().int().nonnegative() })).max(50),
  failure: z.string().max(500).nullable(), expiresAt: z.number().int(),
});
export type DownloadCleanupPreview = z.infer<typeof downloadCleanupPreviewSchema>;
const scopeInput = z.strictObject({ taskId: z.uuid().optional(), page: z.number().int().min(1).max(1000000).default(1) });
export const downloadCleanupActions = {
  "cleanup.list": { input: scopeInput, output: z.array(downloadCleanupSchema).max(100) },
  "cleanup.scope": { input: scopeInput, output: z.array(z.strictObject({ receiptId: z.uuid(), sourcePath: z.string().max(4096), size: z.number().int().nonnegative() })).max(50) },
  "cleanup.preview": { input: z.strictObject({ receiptIds: z.array(z.uuid()).min(1).max(50), requestKey: z.uuid() }), output: downloadCleanupPreviewSchema },
  "cleanup.get-preview": { input: z.strictObject({ id: z.uuid() }), output: downloadCleanupPreviewSchema },
  "cleanup.confirm": { input: z.strictObject({ id: z.uuid() }), output: z.strictObject({}) },
  "cleanup.cancel-preview": { input: z.strictObject({ id: z.uuid() }), output: z.strictObject({}) },
  "cleanup.retry": { input: z.strictObject({ id: z.uuid() }), output: z.strictObject({}) },
} as const;
