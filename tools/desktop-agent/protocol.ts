import { z } from "zod";
import { randomUUID } from "node:crypto";
import { artifactKinds } from "./evidence-kinds.ts";

export const TOOL_PROTOCOL_VERSION = 1 as const;
const uuid = z.uuid();
const page = z.strictObject({ windowId: z.string().min(1).max(120).optional() });
export const scenario = z.enum([
  "empty",
  "local-sync-ready",
  "recognition-review",
  "download-conflict",
  "recovery-pending",
]);
const bounded = z.number().int().positive();
const semanticTarget = z.strictObject({
  role: z.enum([
    "button",
    "link",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "option",
    "slider",
    "combobox",
    "spinbutton",
    "heading",
    "alert",
    "status",
    "dialog",
    "region",
    "main",
  ]),
  name: z.string().min(1).max(500),
});
const condition = z.strictObject({
  targetRef: z.string().max(120).optional(),
  target: semanticTarget.optional(),
  state: z.enum(["visible", "hidden", "enabled", "disabled", "checked", "text", "value"]),
  value: z.union([z.string().max(500), z.boolean()]).optional(),
});
export const commands = {
  help: z.strictObject({}),
  doctor: z.strictObject({ native: z.boolean().default(false) }),
  build: z.strictObject({ target: z.enum(["development", "packaged"]).default("development") }),
  start: z.strictObject({
    scenario: scenario.default("empty"),
    seed: z.string().max(100).default("default"),
    mode: z.enum(["background", "foreground"]).default("background"),
    target: z.enum(["development", "packaged"]).default("development"),
  }),
  status: z.strictObject({ jobId: uuid.optional() }),
  restart: z.strictObject({}),
  stop: z.strictObject({}),
  observe: page.extend({
    mode: z.enum(["windows", "snapshot"]).default("snapshot"),
    snapshotId: uuid.optional(),
    image: z.boolean().default(false),
    scale: z.enum(["css", "device"]).default("css"),
    clip: z
      .strictObject({
        x: z.number().finite().nonnegative(),
        y: z.number().finite().nonnegative(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      })
      .optional(),
    limit: bounded.max(500).default(100),
    cursor: z.number().int().nonnegative().default(0),
    regionRef: z.string().max(120).optional(),
  }),
  act: page.extend({
    snapshotId: uuid,
    targetRef: z.string().max(120).optional(),
    target: semanticTarget.optional(),
    action: z.enum(["click", "fill", "select", "check", "key", "scroll"]),
    value: z.union([z.string().max(4096), z.boolean()]).optional(),
    position: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional(),
    imageId: uuid.optional(),
    timeoutMs: bounded.max(10000).default(5000),
    after: condition.optional(),
  }),
  wait: page.extend({
    snapshotId: uuid,
    targetRef: z.string().max(120).optional(),
    target: semanticTarget.optional(),
    state: condition.shape.state,
    value: condition.shape.value,
    timeoutMs: bounded.max(10000).default(5000),
  }),
  logs: z.strictObject({
    level: z.enum(["debug", "info", "warn", "error", "fatal"]).optional(),
    process: z.enum(["main", "core", "sidecar", "renderer"]).optional(),
    scope: z.string().max(120).optional(),
    requestId: uuid.optional(),
    operationId: z.string().max(120).optional(),
    cursor: z.string().max(200).optional(),
    limit: bounded.max(200).default(100),
  }),
  diagnose: z.strictObject({}),
  scenario: z.strictObject({
    mode: z.enum(["list", "run"]).default("list"),
    name: scenario.optional(),
    seed: z.string().max(100).default("default"),
  }),
  verify: z.strictObject({
    mode: z.enum(["plan", "run"]).default("plan"),
    changedFiles: z
      .array(
        z
          .string()
          .max(4096)
          .refine(
            (v) => !v.startsWith("/") && !v.split(/[\\/]/).includes(".."),
            "必须使用仓库内相对路径",
          ),
      )
      .max(1000)
      .optional(),
  }),
  collect: z.strictObject({
    runId: uuid.optional(),
    pin: z.boolean().optional(),
    kinds: z.array(z.enum(artifactKinds)).nonempty().max(11).optional(),
  }),
  gc: z.strictObject({ dryRun: z.boolean().default(false) }),
} as const;
export type Command = keyof typeof commands;
export type Input<C extends Command> = z.output<(typeof commands)[C]>;
export interface Request<C extends Command = Command> {
  protocolVersion: 1;
  command: C;
  requestId: string;
  sessionId?: string;
  payload: Input<C>;
}
export class ToolError extends Error {
  readonly code: string;
  readonly repair: string;
  readonly state: "failed" | "blocked" | "unknown";
  constructor(
    code: string,
    message: string,
    repair: string,
    state: "failed" | "blocked" | "unknown" = "failed",
  ) {
    super(message);
    this.code = code;
    this.repair = repair;
    this.state = state;
  }
}
const envelope = z.strictObject({
  protocolVersion: z.literal(1).default(1),
  command: z.string(),
  requestId: uuid.default(randomUUID),
  sessionId: uuid.optional(),
  payload: z.unknown().default({}),
});
export function parseRequest(value: unknown): Request {
  const base = envelope.safeParse(value);
  if (!base.success)
    throw new ToolError("INVALID_REQUEST", "开发控制请求格式无效", "使用 help 查看协议及输入范围");
  if (!Object.hasOwn(commands, base.data.command))
    throw new ToolError("UNKNOWN_COMMAND", "开发控制命令不存在", "使用 help 列出有效命令");
  const command = base.data.command as Command;
  const payload = commands[command].safeParse(base.data.payload);
  if (!payload.success)
    throw new ToolError(
      "INVALID_INPUT",
      "命令参数不符合受限输入范围",
      `使用 help 查看 ${command} 输入，不支持任意脚本、SQL 或 IPC 动作`,
    );
  return { ...base.data, command, payload: payload.data } as Request;
}
export function result(
  request: Pick<Request, "command" | "requestId" | "sessionId">,
  value: unknown,
) {
  return {
    protocolVersion: TOOL_PROTOCOL_VERSION,
    command: request.command,
    requestId: request.requestId,
    sessionId: request.sessionId,
    status: "completed",
    result: value,
  };
}
export function failure(
  error: unknown,
  request?: Pick<Request, "command" | "requestId" | "sessionId">,
) {
  const known =
    error instanceof ToolError
      ? error
      : new ToolError(
          "INTERNAL_ERROR",
          "开发控制工具未完成请求",
          "检查当前运行的诊断记录；未知异常不回显原始敏感内容",
        );
  return {
    protocolVersion: TOOL_PROTOCOL_VERSION,
    command: request?.command,
    requestId: request?.requestId,
    sessionId: request?.sessionId,
    status: known.state,
    error: { code: known.code, message: known.message, repair: known.repair },
  };
}
