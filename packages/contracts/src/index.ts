import { z } from "zod";
export * from "./cloud/index.js";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const DESKTOP_CHANNEL = "media-marshal:desktop:v1";
export const errorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "PROTOCOL_MISMATCH",
  "FORBIDDEN",
  "CORE_UNAVAILABLE",
  "INTERRUPTED",
  "TIMEOUT",
  "CONFLICT",
  "UNSAFE_PATH",
  "STORAGE_ERROR",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const rpcErrorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().max(500),
  retryable: z.boolean(),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;
export class DesktopError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DesktopError";
  }
}

export const sourceKindSchema = z.enum(["quark", "baidu", "alipan", "custom"]);
export const sourceDraftSchema = z.strictObject({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(100),
  kind: sourceKindSchema,
  sourcePath: z.string().min(1).max(4096),
  targetPath: z.string().min(1).max(4096),
  mediaType: z.enum(["AUTO", "MOVIE", "TV_SHOW"]).default("AUTO"),
  operation: z.literal("COPY").default("COPY"),
  automatic: z.literal(false).default(false),
});
export type SourceDraft = z.infer<typeof sourceDraftSchema>;
export const sourceSchema = sourceDraftSchema.extend({
  id: z.uuid(),
  version: z.number().int().positive(),
  paused: z.boolean(),
  health: z.enum(["unverified", "available", "unavailable"]),
  createdAt: z.string(),
});
export type DesktopSource = z.infer<typeof sourceSchema>;

export const settingsDraftSchema = z.strictObject({
  language: z.enum(["zh-CN", "en"]).default("zh-CN"),
  embyUrl: z.union([z.literal(""), z.url().max(2048)]).default(""),
  tmdbProxy: z.union([z.literal(""), z.url().max(2048)]).default(""),
});
export type SettingsDraft = z.infer<typeof settingsDraftSchema>;
export const settingsSchema = settingsDraftSchema.extend({
  tmdbKeyConfigured: z.boolean(),
  embyKeyConfigured: z.boolean(),
});
export type DesktopSettings = z.infer<typeof settingsSchema>;

export const taskStatusSchema = z.enum([
  "PENDING",
  "PROCESSING",
  "AWAITING_CONFIRMATION",
  "DONE",
  "FAILED",
  "SKIPPED",
  "CORRECTED",
]);
export const deliveryStatusSchema = z.enum([
  "NOT_READY",
  "REFRESH_PENDING",
  "WAITING_LIBRARY",
  "COLLECTED",
  "NEEDS_ATTENTION",
]);
export const taskSchema = z.strictObject({
  id: z.uuid(),
  sourceId: z.uuid(),
  sourcePath: z.string(),
  title: z.string().nullable(),
  status: taskStatusSchema,
  deliveryStatus: deliveryStatusSchema,
  targetPath: z.string().nullable(),
  updatedAt: z.string(),
});
export type MediaTask = z.infer<typeof taskSchema>;
export const pageInputSchema = z.strictObject({
  page: z.number().int().min(1).max(1000000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  status: taskStatusSchema.optional(),
});
export type PageInput = z.infer<typeof pageInputSchema>;
export const taskPageSchema = z.strictObject({
  items: z.array(taskSchema).max(100),
  total: z.number().int().nonnegative(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type TaskPage = z.infer<typeof taskPageSchema>;
export const jobSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["ingestion", "correction"]),
  state: z.string().max(64),
  updatedAt: z.string(),
});
export type DesktopJob = z.infer<typeof jobSchema>;
export const coreStatusSchema = z.strictObject({
  schemaVersion: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  mode: z.literal("manual-only"),
  parser: z.enum(["unavailable", "ready"]),
});
export type CoreStatus = z.infer<typeof coreStatusSchema>;
export const runtimeSchema = z.strictObject({
  appVersion: z.string(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  core: z.enum(["starting", "ready", "failed", "stopping"]),
  detail: z.string().max(500).nullable(),
  status: coreStatusSchema.nullable(),
});
export type DesktopRuntime = z.infer<typeof runtimeSchema>;

const empty = z.strictObject({});
export const coreActions = {
  "runtime.get": { input: empty, output: coreStatusSchema },
  "sources.list": { input: empty, output: z.array(sourceSchema).max(1000) },
  "sources.save": { input: sourceDraftSchema, output: sourceSchema },
  "sources.pause": {
    input: z.strictObject({ id: z.uuid(), paused: z.boolean() }),
    output: sourceSchema,
  },
  "tasks.list": { input: pageInputSchema, output: taskPageSchema },
  "jobs.list": { input: empty, output: z.array(jobSchema).max(100) },
  "settings.get": { input: empty, output: settingsDraftSchema },
  "settings.save": { input: settingsDraftSchema, output: settingsDraftSchema },
} as const;
export type CoreAction = keyof typeof coreActions;
export type CoreInput<K extends CoreAction> = z.input<
  (typeof coreActions)[K]["input"]
>;
export type CoreOutput<K extends CoreAction> = z.output<
  (typeof coreActions)[K]["output"]
>;
export const coreActionSchema = z.enum(
  Object.keys(coreActions) as [CoreAction, ...CoreAction[]],
);
export const requestSchema = z.strictObject({
  kind: z.literal("request"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.uuid(),
  action: coreActionSchema,
  payload: z.unknown(),
});
export type CoreRequest = z.infer<typeof requestSchema>;
export const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    kind: z.literal("response"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal("response"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: z.uuid(),
    ok: z.literal(false),
    error: rpcErrorSchema,
  }),
]);
export type CoreResponse = z.infer<typeof responseSchema>;
export const credentialSchema = z.strictObject({
  kind: z.enum(["tmdb", "emby"]),
  value: z.string().trim().max(1024),
});
export const nativeActions = {
  "desktop.runtime": empty,
  "desktop.choose-directory": z.strictObject({
    purpose: z.enum(["source", "target"]),
  }),
  "desktop.credentials.save": credentialSchema,
  "desktop.settings": empty,
  "desktop.restart-core": empty,
} as const;
export type NativeAction = keyof typeof nativeActions;

export interface DesktopApi {
  getRuntime(): Promise<DesktopRuntime>;
  listSources(): Promise<DesktopSource[]>;
  saveSource(input: SourceDraft): Promise<DesktopSource>;
  pauseSource(id: string, paused: boolean): Promise<DesktopSource>;
  listTasks(input: PageInput): Promise<TaskPage>;
  listJobs(): Promise<DesktopJob[]>;
  getSettings(): Promise<DesktopSettings>;
  saveSettings(input: SettingsDraft): Promise<SettingsDraft>;
  saveCredential(kind: "tmdb" | "emby", value: string): Promise<void>;
  chooseDirectory(purpose: "source" | "target"): Promise<string | null>;
  restartCore(): Promise<void>;
}

export function checkMessageSize(
  value: unknown,
  maximum = MAX_MESSAGE_BYTES,
): void {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new DesktopError("INVALID_REQUEST", "消息不是可序列化数据");
  }
  if (!json || new TextEncoder().encode(json).byteLength > maximum)
    throw new DesktopError("INVALID_REQUEST", "消息超过允许大小");
}
export function parseCoreRequest(value: unknown): CoreRequest {
  checkMessageSize(value);
  if (
    value &&
    typeof value === "object" &&
    "protocolVersion" in value &&
    value.protocolVersion !== PROTOCOL_VERSION
  )
    throw new DesktopError("PROTOCOL_MISMATCH", "组件协议版本不兼容");
  const request = requestSchema.safeParse(value);
  if (!request.success)
    throw new DesktopError("INVALID_REQUEST", "业务动作或请求格式无效");
  const payload = coreActions[request.data.action].input.safeParse(
    request.data.payload,
  );
  if (!payload.success)
    throw new DesktopError("INVALID_REQUEST", "业务参数无效");
  return { ...request.data, payload: payload.data };
}
export function publicError(error: unknown): RpcError {
  if (error instanceof DesktopError)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  // 文件系统、数据库和网络原始错误可能包含个人路径或凭据。
  return {
    code: "INTERNAL_ERROR",
    message: "操作失败，请检查配置或重试",
    retryable: true,
  };
}
