import { z } from "zod";
const id = z.uuid(), empty = z.strictObject({});
export const ingestionConfigureSchema = z.strictObject({ downloadRootId: id, name: z.string().trim().min(1).max(100), targetPath: z.string().min(1).max(4096), mediaType: z.enum(["AUTO", "MOVIE", "TV_SHOW"]).default("AUTO") });
export const candidateSchema = z.strictObject({ id, sourceId: id, relativePath: z.string().max(16384), size: z.number().int().nonnegative(), state: z.enum(["OBSERVING", "READY", "UNAVAILABLE", "SUPERSEDED", "QUEUED", "PROCESSED", "SKIPPED"]), requiresConfirmation: z.literal(true), taskId: id.nullable(), reason: z.string().max(500).nullable(), updatedAt: z.string() });
export type IngestionCandidate = z.infer<typeof candidateSchema>;
export const selectionSchema = z.strictObject({ tmdbId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), mediaType: z.enum(["MOVIE", "TV_SHOW"]), season: z.number().int().min(0).max(999).nullable().default(null), episode: z.number().int().min(1).max(10000).nullable().default(null), episodeEnd: z.number().int().min(1).max(10000).nullable().default(null) });
export const matchSchema = z.strictObject({ tmdbId: z.number().int().positive(), mediaType: z.enum(["MOVIE", "TV_SHOW"]), title: z.string().max(500), originalTitle: z.string().max(500).nullable(), year: z.number().int().nullable(), confidence: z.number().min(0).max(1), evidence: z.enum(["filename", "parent", "both", "manual"]), explanation: z.string().max(500) });
export const accessorySchema = z.strictObject({ id, sourcePath: z.string().max(16384), targetPath: z.string().max(16384), state: z.enum(["PLANNED","COPYING","VERIFIED","FILE_COMMITTED","RECORDED","NEEDS_ATTENTION"]), failure: z.string().max(100).nullable() });
export const recognitionSchema = z.strictObject({ taskId: id, candidateId: id, revision: z.number().int().nonnegative().optional(), matchesStale: z.boolean().optional(), state: z.string().max(64), parsed: z.strictObject({ title: z.string().nullable(), year: z.number().nullable(), season: z.number().nullable(), episode: z.number().nullable(), episodeEnd: z.number().nullable(), type: z.enum(["MOVIE", "TV_SHOW"]).nullable() }).nullable(), matches: z.array(matchSchema).max(100), failure: z.string().max(500).nullable(), accessories: z.array(accessorySchema).max(100).optional() });
export type Recognition = z.infer<typeof recognitionSchema>;
export const organizePreviewSchema = z.strictObject({ id, taskId: id, title: z.string().max(500), mediaType: z.enum(["MOVIE", "TV_SHOW"]), targetPath: z.string().max(16384), sourcePath: z.string().max(16384), size: z.number().int().positive(), season: z.number().int().nullable(), episode: z.number().int().nullable(), episodeEnd: z.number().int().nullable(), expiresAt: z.number().int(), operationId: id.nullable(), accessories: z.array(z.strictObject({ sourcePath: z.string().max(16384), targetPath: z.string().max(16384), size: z.number().int().positive() })).max(100).optional() });
export type OrganizePreview = z.infer<typeof organizePreviewSchema>;
export const recognitionFieldsSchema = z.strictObject({ title: z.string().max(16384).nullable(), year: z.number().int().min(1).max(9999).nullable(), type: z.enum(["MOVIE", "TV_SHOW"]).nullable(), season: z.number().int().min(0).max(999).nullable(), episode: z.number().int().min(1).max(10000).nullable(), episodeEnd: z.number().int().min(1).max(10000).nullable() });
export type RecognitionFields = z.infer<typeof recognitionFieldsSchema>;
const recognitionEditInput = z.strictObject({
  items: z.array(z.strictObject({ taskId: id, expectedRevision: z.number().int().nonnegative() })).min(1).max(100),
  patch: z.strictObject({ title: z.string().trim().min(1).max(500).refine((value) => !/[\0\r\n]/.test(value)).optional(), year: z.number().int().min(1).max(9999).nullable().optional(), type: z.enum(["MOVIE", "TV_SHOW"]).optional(), season: z.number().int().min(0).max(999).nullable().optional(), episode: z.number().int().min(1).max(10000).nullable().optional(), episodeEnd: z.number().int().min(1).max(10000).nullable().optional() }),
  sequence: z.strictObject({ start: z.number().int().min(1).max(10000), direction: z.enum(["ASC", "DESC"]) }).optional(),
});
export const recognitionEditPreviewSchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), canApply: z.boolean(), warnings: z.array(z.string().max(500)).max(100),
  items: z.array(z.strictObject({ taskId: id, revision: z.number().int().nonnegative(), sourcePath: z.string().max(16384), before: recognitionFieldsSchema.nullable(), after: recognitionFieldsSchema.nullable(), blockers: z.array(z.string().max(500)).max(20) })).max(100),
});
export type RecognitionEditPreview = z.infer<typeof recognitionEditPreviewSchema>;
export const contentReviewSchema = z.strictObject({ id, sourceId: id, sourceVersion: z.number().int().positive(), state: z.enum(["PENDING", "RUNNING", "WAITING_SOURCE", "COMPLETED", "PARTIAL_FAILED", "FAILED", "CANCELLED"]), total: z.number().int().nonnegative(), checked: z.number().int().nonnegative(), changed: z.number().int().nonnegative(), baselined: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), currentPath: z.string().max(16384).nullable(), failure: z.string().max(500).nullable(), createdAt: z.string(), updatedAt: z.string() });
export type ContentReview = z.infer<typeof contentReviewSchema>;
const reviewFile = z.strictObject({ relativePath: z.string().max(16384), state: z.enum(["PENDING", "UNCHANGED", "BASELINED", "CHANGED", "FAILED"]), candidateId: id.nullable(), failure: z.string().max(500).nullable() });
export const ingestionActions = {
  "ingestion.preview-recognition-edit": { input: recognitionEditInput, output: recognitionEditPreviewSchema },
  "ingestion.save-recognition-edit": { input: recognitionEditInput.extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), requestKey: id, rematch: z.boolean() }), output: z.strictObject({ updated: z.number().int().nonnegative(), rematchQueued: z.number().int().nonnegative(), items: z.array(z.strictObject({ taskId: id, revision: z.number().int().nonnegative() })).max(100) }) },
  "ingestion.review-content": { input: z.strictObject({ sourceId: id, requestKey: id }), output: contentReviewSchema },
  "ingestion.content-reviews": { input: z.strictObject({ page: z.number().int().min(1).max(1000000).default(1) }), output: z.strictObject({ items: z.array(contentReviewSchema).max(25), total: z.number().int().nonnegative() }) },
  "ingestion.content-review-files": { input: z.strictObject({ id, page: z.number().int().min(1).max(1000000).default(1) }), output: z.strictObject({ items: z.array(reviewFile).max(100), total: z.number().int().nonnegative() }) },
  "ingestion.cancel-content-review": { input: z.strictObject({ id }), output: contentReviewSchema },
  "ingestion.pause-status": { input: empty, output: z.strictObject({ paused: z.boolean() }) },
  "ingestion.set-paused": { input: z.strictObject({ paused: z.boolean(), requestKey: id }), output: z.strictObject({ paused: z.boolean() }) },
  "ingestion.candidates": { input: z.strictObject({ sourceId: id.optional(), page: z.number().int().min(1).max(1000000).default(1) }), output: z.strictObject({ items: z.array(candidateSchema).max(100), total: z.number().int().nonnegative() }) },
  "ingestion.scan": { input: z.strictObject({ sourceId: id }), output: z.strictObject({ discovered: z.number().int().nonnegative() }) },
  "ingestion.recognize": { input: z.strictObject({ candidateId: id, requestKey: id }), output: z.strictObject({ taskId: id }) },
  "ingestion.task": { input: z.strictObject({ taskId: id }), output: recognitionSchema },
  "ingestion.preview": { input: z.strictObject({ taskId: id, requestKey: id, selection: selectionSchema, template: z.string().min(1).max(16384).optional(), includeAccessories: z.boolean().default(true) }), output: organizePreviewSchema },
  "ingestion.confirm": { input: z.strictObject({ previewId: id, requestKey: id }), output: z.strictObject({ operationId: id }) },
  "ingestion.retry": { input: z.strictObject({ taskId: id }), output: empty },
} as const;
