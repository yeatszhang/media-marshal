import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { nativeHelperRecord } from "./native-fingerprint.ts";
import { ToolError } from "./protocol.ts";
import { sameProcess } from "./process.ts";
import { runHome, type Session } from "./session-store.ts";
import type { GuiWindows } from "./gui-windows.ts";
const exec = promisify(execFile);
const requestSchema = z.strictObject({
  command: z.enum([
    "identity",
    "observe",
    "window-state",
    "capture",
    "press",
    "fill",
    "key",
    "activate",
  ]),
  pid: z.number().int().positive(),
  executable: z.string().min(1).max(4096),
  profile: z.string().min(1).max(4096),
  generation: z
    .string()
    .regex(/^\d+:\d+$/)
    .optional(),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  path: z.array(z.number().int().nonnegative()).max(23).optional(),
  text: z.string().max(4096).optional(),
  key: z.string().max(100).optional(),
  windowID: z.number().int().positive().optional(),
  output: z.string().max(4096).optional(),
  screenX: z.number().finite().optional(),
  screenY: z.number().finite().optional(),
});
export type NativeRequest = z.output<typeof requestSchema>;
export async function invokeNative(root: string, input: NativeRequest) {
  const request = requestSchema.safeParse(input);
  if (!request.success)
    throw new ToolError(
      "INVALID_NATIVE_INPUT",
      "原生请求不符合受限协议",
      "使用固定原生命令和已核验目标",
      "blocked",
    );
  const before = await nativeHelperRecord(root);
  try {
    const operation = exec(before.path, [], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 512 * 1024,
    });
    operation.child.stdin!.on("error", () => {});
    operation.child.stdin!.end(JSON.stringify(request.data));
    const result = JSON.parse((await operation).stdout);
    let unchanged = false;
    try {
      unchanged = (await nativeHelperRecord(root)).manifest.buildId === before.manifest.buildId;
    } catch {
      // 请求已交给子进程，后续构建核验失败不能证明输入未发送。
    }
    if (!unchanged)
      throw new ToolError(
        "NATIVE_BUILD_CHANGED",
        "原生请求期间 helper 已重新构建",
        "保留原动作并重新观察，不自动重放输入",
        "unknown",
      );
    return result;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    try {
      const value = JSON.parse((error as { stdout?: string }).stdout ?? "null");
      if (value?.error?.code && /^[A-Z][A-Z0-9_]{0,95}$/.test(value.error.code))
        throw new ToolError(
          value.error.code,
          "原生驱动拒绝或未完成请求",
          "重新观察已核验的目标，必要时运行 doctor",
          value.status === "blocked" ? "blocked" : "failed",
        );
    } catch (known) {
      if (known instanceof ToolError) throw known;
    }
    throw new ToolError(
      "NATIVE_RESULT_UNKNOWN",
      "原生请求没有可信结果",
      "保留原请求身份并查询证据，不重放输入",
      ["press", "fill", "key", "activate"].includes(input.command) ? "unknown" : "blocked",
    );
  }
}
export async function nativeTarget(root: string, session: Session, windows: GuiWindows) {
  const app = await windows.applicationIdentity();
  if (
    !session.application ||
    app.pid !== session.application.pid ||
    !sameProcess(session.application)
  )
    throw new ToolError(
      "APPLICATION_IDENTITY_CHANGED",
      "原生目标进程身份不匹配",
      "停止输入并核对原会话",
      "blocked",
    );
  const identity = {
    pid: app.pid,
    executable: app.executable,
    profile: join(runHome(root, session.profileRunId), "data"),
  };
  const launch = await invokeNative(root, {
    ...identity,
    pid: session.application.pid,
    command: "identity",
  });
  if (
    !sameProcess(session.application) ||
    launch.pid !== app.pid ||
    typeof launch.generation !== "string" ||
    !/^\d+:\d+$/.test(launch.generation)
  )
    throw new ToolError(
      "APPLICATION_IDENTITY_CHANGED",
      "无法关联原生进程代际",
      "停止输入并核对原会话",
      "blocked",
    );
  return { ...identity, pid: session.application.pid, generation: launch.generation as string };
}
