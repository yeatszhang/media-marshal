import { test } from "node:test";
import assert from "node:assert/strict";
import { imageClip } from "./gui-image.ts";
import { parseRequest, type Input } from "./protocol.ts";
import type { SnapshotHandle } from "./gui-types.ts";
const handle = {
  snapshot: {
    document: { viewport: { width: 920, height: 640 } },
    nodes: [
      { ref: "n1", box: { x: 10, y: 20, width: 200, height: 40 } },
      { ref: "n2", box: { x: -10, y: 20, width: 200, height: 40 } },
    ],
  },
} as SnapshotHandle;
const input = (payload: object) =>
  parseRequest({ command: "observe", payload }).payload as Input<"observe">;
test("截图裁剪使用 CSS 视口坐标，只接受可核验且完全可见的范围", () => {
  assert.deepEqual(imageClip(handle, input({})), { x: 0, y: 0, width: 920, height: 640 });
  assert.deepEqual(imageClip(handle, input({ regionRef: "n1" })), {
    x: 10,
    y: 20,
    width: 200,
    height: 40,
  });
  assert.throws(() => imageClip(handle, input({ regionRef: "n2" })), /不在当前视口/);
  assert.throws(() => imageClip(handle, input({ regionRef: "缺失" })), /没有可核验坐标/);
  assert.throws(
    () => imageClip(handle, input({ clip: { x: 900, y: 0, width: 21, height: 640 } })),
    /不在当前视口/,
  );
  assert.throws(
    () => imageClip(handle, input({ regionRef: "n1", clip: { x: 0, y: 0, width: 1, height: 1 } })),
    /只能选一个/,
  );
  assert.throws(() => input({ clip: { x: 0, y: 0, width: 0, height: 1 } }), /参数/);
});
