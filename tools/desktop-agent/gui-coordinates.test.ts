import { test } from "node:test";
import assert from "node:assert/strict";
import { imagePoint } from "./gui-coordinates.ts";
import type { AvailableImage } from "./gui-image.ts";
import type { SnapshotHandle } from "./gui-types.ts";
test("图像像素经裁剪／实际比例映射 CSS 与原生 DIP，越界和非有限坐标拒绝", () => {
  const image = {
    pixelWidth: 400,
    pixelHeight: 200,
    clip: { x: 10, y: 20, width: 200, height: 100 },
    pixelsPerCss: { x: 2, y: 2 },
  } as AvailableImage;
  const handle = {
    snapshot: {
      window: {
        contentBounds: { x: 100, y: 200, width: 920, height: 608 },
        zoomFactor: 1.25,
        displayScaleFactor: 2,
      },
    },
  } as SnapshotHandle;
  const result = imagePoint(image, { x: 100, y: 50 }, handle);
  assert.deepEqual(result.viewportCss, { x: 60, y: 45 });
  assert.deepEqual(result.nativeScreenDip, { x: 175, y: 256.25 });
  assert.equal(result.nativeInputSent, false);
  assert.equal(result.inputScope, "renderer-viewport");
  for (const position of [
    { x: -1, y: 0 },
    { x: 400, y: 0 },
    { x: 0, y: 200 },
    { x: NaN, y: 0 },
    { x: 0, y: Infinity },
  ])
    assert.throws(() => imagePoint(image, position, handle), /不在原截图/);
});
