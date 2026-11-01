import { z } from "zod";
import { ToolError } from "./protocol.ts";
import type { Session } from "./session-store.ts";
import type { GuiWindows } from "./gui-windows.ts";
import type { GuiWindow } from "./gui-types.ts";
import { invokeNative, nativeTarget } from "./native-runtime.ts";
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
  const identity = await nativeTarget(root, session, windows);
  const state = nativeState.parse(
    await invokeNative(root, {
      ...identity,
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
