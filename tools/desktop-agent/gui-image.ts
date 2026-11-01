import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson } from "./build.ts";
import { agentFile } from "./paths.ts";
import { runHome, type Session } from "./session-store.ts";
import { ToolError, type Input } from "./protocol.ts";
import type { SnapshotHandle } from "./gui-types.ts";
import { maskInputs, unmaskInputs } from "./gui-mask.ts";
import { captureExisting, captureArtifact } from "./evidence-capture.ts";
interface SnapshotObserver {
  current(snapshotId: string): Promise<SnapshotHandle>;
}
export function imageClip(handle: SnapshotHandle, input: Input<"observe">) {
  if (input.clip && input.regionRef)
    throw new ToolError(
      "GUI_CLIP_AMBIGUOUS",
      "区域引用与矩形裁剪只能选一个",
      "明确一个截图范围",
      "blocked",
    );
  const viewport = handle.snapshot.document.viewport;
  const box = input.regionRef
    ? handle.snapshot.nodes.find((n) => n.ref === input.regionRef)?.box
    : input.clip;
  if (input.regionRef && !box)
    throw new ToolError(
      "GUI_REGION_UNAVAILABLE",
      "区域没有可核验坐标",
      "选择有位置的元素或重新观察",
      "blocked",
    );
  const clip = box ?? { x: 0, y: 0, ...viewport };
  if (
    !Object.values(clip).every(Number.isFinite) ||
    clip.x < 0 ||
    clip.y < 0 ||
    clip.width <= 0 ||
    clip.height <= 0 ||
    clip.x + clip.width > viewport.width ||
    clip.y + clip.height > viewport.height
  )
    throw new ToolError(
      "GUI_CLIP_OUTSIDE",
      "裁剪范围不在当前视口内",
      "滚动后重新观察并选择完整可见范围",
      "blocked",
    );
  return clip;
}
export async function captureImage(
  root: string,
  session: Session,
  observer: SnapshotObserver,
  handle: SnapshotHandle,
  input: Input<"observe">,
) {
  const imageId = randomUUID();
  const directory = await agentFile(root, runHome(root, session.runId));
  const evidence = {
    imageId,
    snapshotId: handle.snapshot.snapshotId,
    sessionId: session.sessionId,
    runId: session.runId,
    buildId: session.buildId,
    windowId: handle.snapshot.window.windowId,
  };
  try {
    const clip = imageClip(handle, input);
    await observer.current(handle.snapshot.snapshotId);
    let bytes: Buffer;
    try {
      await maskInputs(handle.page);
      bytes = await handle.page.screenshot({
        type: "png",
        clip,
        scale: input.scale,
        caret: "initial",
        timeout: 5000,
      });
    } finally {
      await unmaskInputs(handle.page);
    }
    await observer.current(handle.snapshot.snapshotId);
    if (bytes.length > 12 * 1024 * 1024)
      throw new ToolError("GUI_IMAGE_TOO_LARGE", "图片超过证据预算", "缩小截图区域", "blocked");
    const path = join(directory, `image-${imageId}.png`);
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    const result = {
      ...evidence,
      status: "available" as const,
      source: "dom" as const,
      path,
      clip,
      scale: input.scale,
      coordinateSystem: "viewport-css-pixels",
      pixelWidth: width,
      pixelHeight: height,
      pixelsPerCss: { x: width / clip.width, y: height / clip.height },
      sha256: createHash("sha256").update(bytes).digest("hex"),
      devicePixelRatio: handle.snapshot.document.devicePixelRatio,
      deviceScaleFactor:
        handle.snapshot.document.devicePixelRatio / handle.snapshot.window.zoomFactor,
      zoomFactor: handle.snapshot.window.zoomFactor,
      masked: "all-input-values",
      layoutMatched: true,
    };
    await atomicJson(join(directory, `image-${imageId}.json`), result);
    const index = await captureExisting(root, session, path, {
      kind: "image",
      source: "dom",
      snapshotId: evidence.snapshotId,
      windowId: evidence.windowId,
    });
    await captureExisting(root, session, join(directory, `image-${imageId}.json`), {
      kind: "image",
      source: "dom",
      snapshotId: evidence.snapshotId,
      windowId: evidence.windowId,
    });
    return { ...result, evidence: index };
  } catch (error) {
    const result = {
      ...evidence,
      status: "missing" as const,
      layoutMatched: false,
      reason: error instanceof ToolError ? error.code : "GUI_IMAGE_FAILED",
    };
    await atomicJson(join(directory, `image-${imageId}.json`), result);
    await captureArtifact(root, session, {
      kind: "image",
      source: "dom",
      status: "missing",
      reason: result.reason,
      snapshotId: evidence.snapshotId,
      windowId: evidence.windowId,
    });
    return result;
  }
}
export type AvailableImage = Extract<
  Awaited<ReturnType<typeof captureImage>>,
  { status: "available" }
>;
