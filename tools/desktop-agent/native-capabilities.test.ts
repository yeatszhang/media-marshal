import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeCapabilities } from "./native-capabilities.ts";
test("录屏缺失只阻断可选图像，AX 输入独立核验辅助功能和锁屏，未知状态拒绝", () => {
  const available = { accessibility: true, screenCapture: false, sessionLocked: false };
  assert.equal(nativeCapabilities(available).input.status, "ready");
  assert.equal(nativeCapabilities(available).capture.reason, "NATIVE_SCREEN_CAPTURE_REQUIRED");
  assert.equal(
    nativeCapabilities({ ...available, accessibility: false }).input.reason,
    "NATIVE_ACCESSIBILITY_REQUIRED",
  );
  assert.equal(
    nativeCapabilities({ ...available, sessionLocked: true }).input.reason,
    "NATIVE_SESSION_LOCKED",
  );
  assert.equal(nativeCapabilities({ ...available, screenCapture: true }).capture.status, "ready");
  assert.throws(() => nativeCapabilities({ accessibility: true, screenCapture: true }));
});
