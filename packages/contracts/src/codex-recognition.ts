import { z } from "zod";

export const recognitionSettingsSchema = z.strictObject({
  codexEnabled: z.boolean().default(false),
  cliPath: z.string().trim().min(1).max(4096).refine((value) => !/[\0\r\n]/.test(value), "CLI 路径不能包含控制字符").default("codex"),
  model: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/).default("gpt-6-luna"),
  dailyCalls: z.number().int().min(1).max(1000).default(10),
  confidenceThreshold: z.number().min(0).max(1).default(0.8),
  parentFolderEnabled: z.boolean().default(true),
  parentOnlyConfidenceCap: z.number().min(0).max(1).default(0.75),
  parentMutualBoost: z.number().min(0).max(1).default(0.05),
});
export type RecognitionSettings = z.infer<typeof recognitionSettingsSchema>;
export const codexEvidenceSchema = z.strictObject({ confidence: z.number().min(0.6).max(1), reason: z.string().max(500), mode: z.enum(["cluster", "file", "directory"]) });
export type CodexEvidence = z.infer<typeof codexEvidenceSchema>;
export const codexUsageSchema = z.strictObject({ day: z.string(), calls: z.number().int().nonnegative(), reported_calls: z.number().int().nonnegative(), input_tokens: z.number().int().nonnegative(), cached_input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(), call_limit: z.number().int().positive() });
const id = z.string().uuid();
export const codexJobItemSchema = z.strictObject({ taskId: id, relativePath: z.string().max(16384), state: z.enum(["PENDING", "UPDATED", "SUBMITTED", "SKIPPED", "FAILED"]), failure: z.string().max(500).nullable(), operationId: id.nullable() });
export const codexJobSchema = z.strictObject({ id, taskId: id, directory: z.boolean(), organize: z.boolean(), state: z.enum(["PENDING", "RUNNING", "COMPLETED", "PARTIAL_FAILED", "FAILED", "CANCELLED"]), items: z.array(codexJobItemSchema).max(80), failure: z.string().max(500).nullable(), createdAt: z.string(), updatedAt: z.string() });
export type CodexJob = z.infer<typeof codexJobSchema>;
export const codexActions = {
  "codex.usage": { input: z.strictObject({}), output: codexUsageSchema },
  "codex.rematch": { input: z.strictObject({ taskId: id, directory: z.boolean().default(false), organize: z.boolean().default(true), requestKey: id }), output: codexJobSchema },
  "codex.prepare-directory": { input: z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/), sourceId: id, organize: z.boolean().default(true), requestKey: id }), output: codexJobSchema },
  "codex.jobs": { input: z.strictObject({ page: z.number().int().min(1).max(1000000).default(1) }), output: z.strictObject({ items: z.array(codexJobSchema).max(25), total: z.number().int().nonnegative() }) },
  "codex.job": { input: z.strictObject({ id }), output: codexJobSchema },
  "codex.cancel": { input: z.strictObject({ id }), output: codexJobSchema },
} as const;
