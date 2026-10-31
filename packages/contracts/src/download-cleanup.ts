import { z } from "zod";

/** 文件删除进度独立于整理及 Emby 交付；页面只能提交业务 ID。 */
export const downloadCleanupPhaseSchema = z.enum([
  "PENDING", "WAITING_REFERENCES", "CLAIMED", "QUARANTINED", "REMOVING",
  "SOURCE_REMOVED", "CACHE_PENDING", "DONE", "NEEDS_ATTENTION",
]);
export const downloadCleanupSchema = z.strictObject({
  id: z.uuid(), receiptId: z.uuid(), taskId: z.uuid().nullable(),
  phase: downloadCleanupPhaseSchema,
  resumePhase: downloadCleanupPhaseSchema.nullable(),
  sourcePath: z.string().max(4096), targetPath: z.string().max(4096),
  size: z.number().int().nonnegative(), freedBytes: z.number().int().nonnegative(),
  waitingReason: z.string().max(500).nullable(), failure: z.string().max(500).nullable(),
  updatedAt: z.string(),
});
export type DownloadCleanup = z.infer<typeof downloadCleanupSchema>;
