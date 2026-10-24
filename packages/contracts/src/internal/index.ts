import { z } from "zod";
import {
  cloudFailureSchema, driveCapabilitiesSchema, remoteEntrySchema, transferSourceKindSchema,
  versionEvidenceSchema, type DriveCapabilities, type VersionEvidence,
} from "../cloud/index.js";

// 此入口仅供 Core/Main/Host 使用。公开入口不得重导出这里的任何对象。
const id = z.uuid();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const implementationIdSchema = z.string().min(1).max(80).regex(/^[a-z][a-z0-9.-]+$/);
export const cloudAccountWriteSchema = z.strictObject({
  id, name: z.string().trim().min(1).max(100), credentialRef: id.nullable(),
  bindingId: id, implementationId: implementationIdSchema, generation: id,
});
export const remoteLocatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("path"), segments: z.array(z.string().min(1).max(1024).refine((part) => !/[\0/]/.test(part) && part !== "." && part !== "..")).max(256) }),
  z.strictObject({ kind: z.literal("stable-id"), objectKey: z.string().min(1).max(1024).refine((key) => !/\0|^[a-z][a-z0-9+.-]*:\/\//i.test(key)) }),
]);
export type RemoteLocator = z.infer<typeof remoteLocatorSchema>;
export const bindingRefSchema = z.strictObject({ accountId: id, bindingId: id, generation: id });
export type BindingRef = z.infer<typeof bindingRefSchema>;
export const sourceRequestSchema = z.strictObject({
  binding: bindingRefSchema, remoteRef: id, locator: remoteLocatorSchema,
  expectedVersion: versionEvidenceSchema.nullable(),
});
export type SourceRequest = z.infer<typeof sourceRequestSchema>;
export const transferItemSchema = z.strictObject({
  itemId: id, source: sourceRequestSchema,
  targetSegments: z.array(z.string().min(1).max(255).refine((part) => !/[\0/\\]/.test(part) && part !== "." && part !== "..")).min(1).max(128),
  expectedSize: count,
});
export type TransferItem = z.infer<typeof transferItemSchema>;
export const transferPlanSchema = z.strictObject({
  attemptId: id, targetGrantId: id, items: z.array(transferItemSchema).min(1).max(100),
}).refine((plan) => new Set(plan.items.map((item) => item.itemId)).size === plan.items.length, "批次条目不得重复");
export type TransferPlan = z.infer<typeof transferPlanSchema>;
export const executionHandleSchema = z.strictObject({ executionId: id, attemptId: id, hostGeneration: id });
export type ExecutionHandle = z.infer<typeof executionHandleSchema>;
export const transferEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("progress"), bytes: count, bytesPerSecond: z.number().nonnegative().finite(), totalBytes: count.nullable() }),
  // 退出成功只代表传输进程结束，仍由 Core 逐项校验并提交。
  z.strictObject({ type: z.literal("exited"), exitCode: z.number().int(), stopped: z.boolean() }),
  z.strictObject({ type: z.literal("failure"), failure: cloudFailureSchema }),
]);
export type TransferEvent = z.infer<typeof transferEventSchema>;

export const hostActions = {
  "provider.capabilities": { input: bindingRefSchema, output: driveCapabilitiesSchema },
  "provider.list": {
    input: z.strictObject({ binding: bindingRefSchema, parentRef: id, locator: remoteLocatorSchema, cursor: z.string().max(2048).nullable(), pageSize: z.number().int().min(1).max(100) }),
    output: z.strictObject({ entries: z.array(z.strictObject({ entry: remoteEntrySchema.omit({ ref: true, parentRef: true }), locator: remoteLocatorSchema })).max(100), nextCursor: z.string().max(2048).nullable(), total: count.nullable(), complete: z.boolean() }),
  },
  "provider.stat": {
    input: sourceRequestSchema,
    output: remoteEntrySchema.omit({ ref: true, parentRef: true }),
  },
  "transfer.start": { input: transferPlanSchema, output: executionHandleSchema },
  "transfer.stop": { input: executionHandleSchema, output: z.strictObject({ stopped: z.literal(true) }) },
  "transfer.status": {
    input: z.strictObject({ attemptId: id }),
    output: z.strictObject({ handle: executionHandleSchema.nullable(), state: z.enum(["UNKNOWN", "RUNNING", "EXITED", "STOPPED"]), lastSequence: count, exitCode: z.number().int().nullable() }),
  },
} as const;
export type HostAction = keyof typeof hostActions;
export type HostInput<K extends HostAction> = z.input<(typeof hostActions)[K]["input"]>;
export type HostOutput<K extends HostAction> = z.output<(typeof hostActions)[K]["output"]>;
export const HOST_PROTOCOL_VERSION = 1 as const;
export const executionContextSchema = z.strictObject({
  coreGeneration: id, hostGeneration: id, bindingGeneration: id, attemptId: id,
});
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export const hostRequestSchema = z.strictObject({
  kind: z.literal("host.request"), protocolVersion: z.literal(HOST_PROTOCOL_VERSION),
  requestId: id, idempotencyKey: id, context: executionContextSchema,
  action: z.enum(Object.keys(hostActions) as [HostAction, ...HostAction[]]), payload: z.unknown(),
});
export type HostRequest = z.infer<typeof hostRequestSchema>;
export const hostResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ kind: z.literal("host.response"), protocolVersion: z.literal(HOST_PROTOCOL_VERSION), requestId: id, context: executionContextSchema, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ kind: z.literal("host.response"), protocolVersion: z.literal(HOST_PROTOCOL_VERSION), requestId: id, context: executionContextSchema, ok: z.literal(false), error: cloudFailureSchema }),
]);
export type HostResponse = z.infer<typeof hostResponseSchema>;
export const hostEventSchema = z.strictObject({
  kind: z.literal("host.event"), protocolVersion: z.literal(HOST_PROTOCOL_VERSION),
  context: executionContextSchema, executionId: id, sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), event: transferEventSchema,
});
export type HostEvent = z.infer<typeof hostEventSchema>;

export interface AccountIdentity { stableKey: string | null }
export interface PrivateCredentialInput { binding: BindingRef; cookie: string }
export const transferSourceLeaseSchema = z.strictObject({
  leaseId: id, generation: id, kind: z.literal("webdav"),
  endpoint: z.url().max(2048).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }, "传输租约只能指向受管回环服务"),
  root: z.string().max(4096).startsWith("/").refine((value) => !/[\0\\]/.test(value) && !value.split("/").includes("..")),
  credentialHandle: id, expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export type TransferSourceLease = z.infer<typeof transferSourceLeaseSchema>;
export interface PrivateTransferPlan {
  plan: TransferPlan; context: ExecutionContext; lease: TransferSourceLease;
  stagingDirectory: string;
}
export interface CloudDriveProvider {
  readonly implementationId: string;
  capabilities(binding: BindingRef): Promise<DriveCapabilities>;
  validateCredential(input: PrivateCredentialInput): Promise<AccountIdentity>;
  list(input: HostInput<"provider.list">): Promise<HostOutput<"provider.list">>;
  stat(input: SourceRequest): Promise<HostOutput<"provider.stat">>;
  acquireSource(input: SourceRequest): Promise<TransferSourceLease>;
  releaseSource(leaseId: string): Promise<void>;
}
export interface TransferEngine {
  readonly implementationId: string;
  readonly supportedSourceKinds: readonly z.infer<typeof transferSourceKindSchema>[];
  start(input: PrivateTransferPlan): Promise<ExecutionHandle>;
  stop(handle: ExecutionHandle): Promise<{ stopped: true }>;
  events(handle: ExecutionHandle): AsyncIterable<TransferEvent>;
}
export type RemoteVersion = VersionEvidence;
