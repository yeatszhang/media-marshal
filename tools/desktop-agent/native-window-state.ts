import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { ToolError } from "./protocol.ts";
import { sameProcess } from "./process.ts";
import { runHome, type Session } from "./session-store.ts";
import type { GuiWindows } from "./gui-windows.ts";
import type { GuiWindow } from "./gui-types.ts";
const exec = promisify(execFile);
const nativeState = z.strictObject({
  source: z.literal("native-window-metadata"),
  sessionLocked: z.boolean(),
  frontmost: z.boolean(),
  windows: z
    .array(
      z.strictObject({
        id: z.number().int(),
        bounds: z.strictObject({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
        occluded: z.boolean(),
        pointOwned: z.boolean().nullable(),
      }),
    )
    .max(200),
});
async function helper(root: string, input: object) {
  try {
    const operation = exec(join(root, "tools/desktop-agent/.build/native-helper"), [], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    operation.child.stdin!.on("error", () => {});
    operation.child.stdin!.end(JSON.stringify(input));
    const result = await operation;
    return JSON.parse(result.stdout);
  } catch (error) {
    const output = (error as { stdout?: string }).stdout;
    if (output) {
      const value = JSON.parse(output);
      if (value.error?.code)
        throw new ToolError(
          String(value.error.code),
          "原生窗口状态核验受阻",
          "运行 doctor 检查 helper 与辅助功能权限",
          "blocked",
        );
    }
    throw new ToolError(
      "NATIVE_WINDOW_STATE_UNAVAILABLE",
      "无法读取原生窗口状态",
      "构建 native helper 并运行 doctor，不跳过遮挡核验",
      "blocked",
    );
  }
}
export async function assertWindowVisible(
  root: string,
  session: Session,
  windows: GuiWindows,
  window: GuiWindow,
  point?: { x: number; y: number },
) {
  if (session.options.mode === "background")
    return {
      source: "dom",
      mode: "background-virtual",
      physicalOcclusion: "not-applicable",
      nativeInputSent: false,
    };
  if (process.platform !== "darwin")
    throw new ToolError(
      "NATIVE_WINDOW_STATE_UNSUPPORTED",
      "当前平台缺少原生遮挡核验",
      "使用后台隔离模式；原生能力保持未验证",
      "blocked",
    );
  const app = await windows.applicationIdentity();
  if (
    !session.application ||
    app.pid !== session.application.pid ||
    !sameProcess(session.application)
  )
    throw new ToolError(
      "APPLICATION_IDENTITY_CHANGED",
      "坐标目标进程身份不匹配",
      "停止输入并核对原会话",
      "blocked",
    );
  const identity = {
    pid: app.pid,
    executable: app.executable,
    profile: join(runHome(root, session.profileRunId), "data"),
  };
  const launch = await helper(root, { ...identity, command: "identity" });
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
  const state = nativeState.parse(
    await helper(root, {
      ...identity,
      generation: launch.generation,
      command: "window-state",
      ...(point ? { screenX: point.x, screenY: point.y } : {}),
    }),
  );
  if (state.sessionLocked)
    throw new ToolError(
      "NATIVE_SESSION_LOCKED",
      "macOS 会话当前锁定或未处于交互桌面",
      "解锁屏幕后重新观察；后台 DOM 能力可独立继续",
      "blocked",
    );
  const matches = state.windows.filter((row) =>
    Object.entries(window.bounds).every(
      ([key, value]) => Math.abs(value - row.bounds[key as keyof typeof row.bounds]) < 1,
    ),
  );
  if (
    !state.frontmost ||
    !window.focused ||
    !window.visible ||
    window.minimized ||
    matches.length !== 1 ||
    (point ? matches[0]!.pointOwned !== true : matches[0]!.occluded)
  )
    throw new ToolError(
      "GUI_WINDOW_OCCLUDED",
      "前台目标不唯一、失焦、隐藏或被遮挡",
      "恢复当前窗口并重新观察，不向旧坐标发送输入",
      "blocked",
    );
  return {
    source: state.source,
    mode: "foreground",
    windowId: matches[0]!.id,
    frontmost: true,
    occluded: false,
    rectangleOverlap: matches[0]!.occluded,
    pointOwned: point ? matches[0]!.pointOwned : null,
    hitTest: point ? "accessibility-window-z-order" : "window-rectangles",
    nativeInputSent: false,
  };
}
