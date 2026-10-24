import { createHash } from "node:crypto";
import { z } from "zod";
import { CloudError, remoteEntrySchema, versionEvidenceSchema, type DownloadState } from "@media-marshal/contracts";
import {
  bindingRefSchema, remoteLocatorSchema, transferItemSchema,
  type ExecutionContext, type HostEvent, type TransferPlan,
} from "@media-marshal/contracts/internal";

const scopeSchema = z.strictObject({
  jobId: z.uuid(), requestKey: z.uuid(), attemptId: z.uuid(), binding: bindingRefSchema, targetGrantId: z.uuid(),
  files: z.array(z.strictObject({
    entry: remoteEntrySchema, locator: remoteLocatorSchema,
    // 位置映射由卷与路径授权层产生，不能由 Renderer 提供。
    mapping: z.strictObject({ segments: transferItemSchema.shape.targetSegments, slotKey: z.string().regex(/^[a-f0-9]{64}$/) }),
  })).min(1).max(100),
});
export type OnceScope = z.input<typeof scopeSchema>;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function planOnce(value: OnceScope) {
  const parsed = scopeSchema.safeParse(value);
  if (!parsed.success) throw new CloudError("INVALID_REQUEST");
  const scope = parsed.data;
  const refs = new Set<string>(), slots = new Set<string>(), names = new Set<string>();
  let bytes = 0;
  let weakComparison = false;
  const items = scope.files.map(({ entry, locator, mapping }) => {
    if (entry.accountId !== scope.binding.accountId || entry.type !== "file" || entry.size === null) throw new CloudError("UNSUPPORTED_CAPABILITY");
    const nameKey = JSON.stringify(mapping.segments);
    if (refs.has(entry.ref) || slots.has(mapping.slotKey) || names.has(nameKey)) throw new CloudError("CONFLICT");
    refs.add(entry.ref); slots.add(mapping.slotKey); names.add(nameKey);
    const version = versionEvidenceSchema.parse(entry.version ?? { kind: "weak", size: entry.size, modifiedAt: entry.modifiedAt });
    if (version.kind === "weak") {
      weakComparison = true;
      if (version.size !== entry.size) throw new CloudError("REMOTE_CHANGED");
    }
    bytes += entry.size;
    if (!Number.isSafeInteger(bytes)) throw new CloudError("INVALID_REQUEST");
    return {
      // 条目 ID 在持久化计划前分配；重放必须读取原计划，不能再次调用分配器。
      itemId: globalThis.crypto.randomUUID(), source: { binding: scope.binding, remoteRef: entry.ref, locator, expectedVersion: version },
      targetSegments: mapping.segments, expectedSize: entry.size,
      versionKey: fingerprint(version), targetPathKey: mapping.slotKey,
    };
  });
  const transfer: TransferPlan = { attemptId: scope.attemptId, targetGrantId: scope.targetGrantId, items: items.map(({ versionKey: _, targetPathKey: __, ...item }) => item) };
  return freeze({ jobId: scope.jobId, requestKey: scope.requestKey, accountId: scope.binding.accountId, items, transfer, summary: { files: items.length, bytes, weakComparison } });
}

const allowed: Record<DownloadState, readonly DownloadState[]> = {
  QUEUED: ["RUNNING", "PAUSED", "CANCELLED", "AUTH_REQUIRED", "BLOCKED_LOCAL", "FAILED"],
  RUNNING: ["VERIFYING", "PAUSING", "CANCELLING", "RETRY_WAIT", "AUTH_REQUIRED", "FAILED", "BLOCKED_LOCAL", "RECONCILING"],
  VERIFYING: ["COMMITTING", "PAUSING", "CANCELLING", "FAILED", "RECONCILING", "BLOCKED_LOCAL"],
  COMMITTING: ["COMPLETED", "RECONCILING"],
  COMPLETED: ["RECONCILING"], PAUSING: ["PAUSED", "RECONCILING"], PAUSED: ["QUEUED", "CANCELLED"],
  CANCELLING: ["CANCELLED", "RECONCILING"], CANCELLED: [],
  RETRY_WAIT: ["QUEUED", "CANCELLED", "AUTH_REQUIRED"], AUTH_REQUIRED: ["QUEUED", "CANCELLED"],
  FAILED: ["QUEUED", "CANCELLED", "RECONCILING"], BLOCKED_LOCAL: ["QUEUED", "CANCELLED", "RECONCILING"],
  RECONCILING: ["QUEUED", "COMMITTING", "COMPLETED", "FAILED", "BLOCKED_LOCAL"],
};
export interface TransitionEvidence { writerStopped?: boolean; fileVerified?: boolean; commitRecorded?: boolean; rootAvailable?: boolean; authorized?: boolean }
export function advanceDownloadState(from: DownloadState, to: DownloadState, evidence: TransitionEvidence = {}): DownloadState {
  if (from === to) return from;
  if (!allowed[from].includes(to)) throw new CloudError("CONFLICT");
  if (["RUNNING", "QUEUED", "VERIFYING", "PAUSED", "CANCELLED", "COMMITTING", "COMPLETED"].includes(to) && !evidence.writerStopped) throw new CloudError("CONFLICT");
  if (to === "RUNNING" && (!evidence.authorized || !evidence.rootAvailable)) throw new CloudError("CONFLICT");
  if (to === "QUEUED" && from === "AUTH_REQUIRED" && !evidence.authorized) throw new CloudError("CONFLICT");
  if (to === "QUEUED" && ["BLOCKED_LOCAL", "RECONCILING"].includes(from) && !evidence.rootAvailable) throw new CloudError("CONFLICT");
  if (["COMMITTING", "COMPLETED"].includes(to) && (!evidence.fileVerified || !evidence.rootAvailable)) throw new CloudError("CONFLICT");
  if (to === "COMPLETED" && !evidence.commitRecorded) throw new CloudError("CONFLICT");
  if (["FAILED", "AUTH_REQUIRED", "RETRY_WAIT", "BLOCKED_LOCAL"].includes(to) && ["RUNNING", "PAUSING", "CANCELLING", "COMMITTING", "RECONCILING"].includes(from) && !evidence.writerStopped) throw new CloudError("CONFLICT");
  return to;
}
export interface ExecutionCursor { context: ExecutionContext; executionId: string; sequence: number }
export function acceptExecutionEvent(cursor: ExecutionCursor, event: HostEvent): ExecutionCursor {
  const left = cursor.context, right = event.context;
  if (cursor.executionId !== event.executionId || event.sequence <= cursor.sequence ||
      left.coreGeneration !== right.coreGeneration || left.hostGeneration !== right.hostGeneration ||
      left.bindingGeneration !== right.bindingGeneration || left.attemptId !== right.attemptId) return cursor;
  // 仅接受观测；退出或成功日志都不能绕过文件校验和提交。
  return { ...cursor, sequence: event.sequence };
}
