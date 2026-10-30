import { z } from "zod";
import { recognitionRuleSchema, recognitionRuleSnapshotSchema, recognitionRuleWriteSchema, recognitionTargetSchema } from "./sync-recognition.js";
import { sourceScanSchema } from "./ingestion.js";
const id = z.uuid(), revision = z.number().int().nonnegative();
const versions = { id, expectedVersion: revision, expectedDraftRevision: revision, expectedLifecycleRevision: revision };
export const recognitionConfigurationPreviewSchema = z.strictObject({ id, ruleId: id, state: z.enum(["READY", "APPLIED", "EXPIRED"]), snapshot: recognitionRuleSnapshotSchema, expiresAt: z.number().int(), automaticAuthorized: z.boolean() });
export const recognitionActions = {
  "recognition.list": { input: z.strictObject({ includeDeleted: z.boolean().default(false) }), output: z.array(recognitionRuleSchema).max(1000) },
  "recognition.save": { input: recognitionRuleWriteSchema, output: recognitionRuleSchema },
  "recognition.preview": { input: z.strictObject({ ...versions, requestKey: id, useCurrentDefault: z.boolean().default(false) }), output: recognitionConfigurationPreviewSchema },
  "recognition.get-preview": { input: z.strictObject({ id }), output: recognitionConfigurationPreviewSchema },
  "recognition.confirm": { input: z.strictObject({ previewId: id, requestKey: id }), output: recognitionRuleSchema },
  "recognition.control": { input: z.strictObject({ ...versions, requestKey: id, operation: z.enum(["pause", "resume", "remove", "restore", "reset"]) }), output: recognitionRuleSchema },
  "recognition.scan": { input: z.strictObject({ ...versions, requestKey: id }), output: sourceScanSchema },
  "recognition.authorize-automatic": { input: z.strictObject({ id, expectedVersion: revision, samplePreviewId: id, accepted: z.literal(true), requestKey: id }), output: recognitionRuleSchema },
  "recognition.task-targets": { input: z.strictObject({ taskId: id }), output: z.strictObject({ ruleId: id.nullable(), scopeToken: z.string().regex(/^[a-f0-9]{64}$/).optional(), ruleVersion: revision.optional(), automatic: z.boolean().optional(), targets: z.array(recognitionTargetSchema).max(100) }) },
} as const;
