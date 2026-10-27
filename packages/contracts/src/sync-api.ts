import { z } from "zod";
import { syncSourceRuleSchema, syncSourceSnapshotSchema, syncSourceWriteSchema } from "./sync-recognition.js";
import { downloadPreviewSchema } from "./cloud/index.js";

const id = z.uuid(), revision = z.number().int().nonnegative();
export const syncFileSchema = z.strictObject({ relativePath: z.string().max(4096), targetPath: z.string().max(4096), size: z.number().int().nonnegative(), state: z.enum(["READY", "OBSERVING", "REUSED", "REMOVED", "CONFLICT", "UNAVAILABLE", "PENDING", "DONE", "NEEDS_ATTENTION"]), reason: z.string().max(500).nullable() });
export const syncJobSchema = z.strictObject({ id, sourceId: id, sourceVersion: revision, recognition: z.strictObject({ state: z.enum(["NOT_ENABLED", "PAUSED", "ENABLED"]), ruleId: id.nullable() }).optional(), state: z.enum(["PENDING", "RUNNING", "DONE", "NEEDS_ATTENTION", "CANCELED"]), files: revision, done: revision, reused: revision, removed: revision, failed: revision, failure: z.string().max(500).nullable(), downloadJobId: id.nullable(), createdAt: z.string(), updatedAt: z.string() });
export const syncPreviewSchema = z.strictObject({ id, sourceId: id, mode: z.enum(["configuration", "execution"]), state: z.enum(["BUILDING", "READY", "BLOCKED", "EXPIRED", "APPLIED"]), snapshot: syncSourceSnapshotSchema, expiresAt: z.number().int(), files: revision, bytes: revision, complete: z.boolean(), observing: revision, conflicts: revision, reused: revision, removed: revision, force: z.boolean(), failure: z.string().max(500).nullable(), download: downloadPreviewSchema.nullable(), jobId: id.nullable() });
const versions = { id, expectedVersion: revision, expectedDraftRevision: revision, expectedLifecycleRevision: revision };
const page = { page: z.number().int().min(1).max(1000000).default(1), pageSize: z.number().int().min(1).max(100).default(25) };
export const syncActions = {
  "sync.list": { input: z.strictObject({ includeDeleted: z.boolean().default(false) }), output: z.array(syncSourceRuleSchema).max(1000) },
  "sync.save": { input: syncSourceWriteSchema, output: syncSourceRuleSchema },
  "sync.preview": { input: z.strictObject({ ...versions, requestKey: id, mode: z.enum(["configuration", "execution"]).default("configuration"), force: z.boolean().default(false), useCurrentDefault: z.boolean().default(false) }), output: syncPreviewSchema },
  "sync.get-preview": { input: z.strictObject({ id }), output: syncPreviewSchema },
  "sync.preview-files": { input: z.strictObject({ id, ...page }), output: z.strictObject({ items: z.array(syncFileSchema).max(100), total: revision }) },
  "sync.confirm": { input: z.strictObject({ previewId: id, requestKey: id, runOnce: z.boolean().default(false), filesComplete: z.literal(true).optional(), historyConsent: z.strictObject({ accepted: z.literal(true) }).optional() }), output: z.strictObject({ rule: syncSourceRuleSchema, jobId: id.nullable() }) },
  "sync.control": { input: z.strictObject({ ...versions, requestKey: id, operation: z.enum(["pause", "resume", "remove", "restore", "reset"]) }), output: syncSourceRuleSchema },
  "sync.jobs": { input: z.strictObject({ sourceId: id.optional(), ...page }), output: z.strictObject({ items: z.array(syncJobSchema).max(100), total: revision }) },
  "sync.job": { input: z.strictObject({ id }), output: syncJobSchema },
  "sync.job-files": { input: z.strictObject({ id, ...page }), output: z.strictObject({ items: z.array(syncFileSchema).max(100), total: revision }) },
  "sync.retry": { input: z.strictObject({ id, requestKey: id }), output: syncJobSchema },
} as const;
