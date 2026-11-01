import { z } from "zod";
const capabilities = z.object({
  accessibility: z.boolean(),
  screenCapture: z.boolean(),
  sessionLocked: z.boolean(),
});
/** AX 输入与可选图像分开判断，未知权限不推断为可用。 */
export function nativeCapabilities(input: unknown) {
  const value = capabilities.parse(input);
  const reason = value.sessionLocked
    ? "NATIVE_SESSION_LOCKED"
    : !value.accessibility
      ? "NATIVE_ACCESSIBILITY_REQUIRED"
      : undefined;
  return {
    ...value,
    input: { status: reason ? "blocked" : "ready", reason },
    capture: {
      status: reason || !value.screenCapture ? "blocked" : "ready",
      reason: reason ?? (!value.screenCapture ? "NATIVE_SCREEN_CAPTURE_REQUIRED" : undefined),
    },
  } as const;
}
