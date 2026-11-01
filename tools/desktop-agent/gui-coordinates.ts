import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ToolError, type Input } from "./protocol.ts";
import { agentFile } from "./paths.ts";
import type { AvailableImage } from "./gui-image.ts";
import type { GuiObserver } from "./gui-observe.ts";
import type { SnapshotHandle } from "./gui-types.ts";
import type { Session } from "./session-store.ts";
import { assertWindowVisible } from "./native-window-state.ts";
import { waitCondition } from "./gui-condition.ts";
import type { ActionReceipt } from "./action-store.ts";
export function imagePoint(
  image: AvailableImage,
  position: { x: number; y: number },
  handle: SnapshotHandle,
) {
  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    position.x < 0 ||
    position.y < 0 ||
    position.x >= image.pixelWidth ||
    position.y >= image.pixelHeight
  )
    throw new ToolError(
      "GUI_POSITION_OUTSIDE",
      "坐标不在原截图像素范围内",
      "查看当前图片后选择窗口内位置",
      "blocked",
    );
  const css = {
    x: image.clip.x + position.x / image.pixelsPerCss.x,
    y: image.clip.y + position.y / image.pixelsPerCss.y,
  };
  const window = handle.snapshot.window;
  return {
    imagePixels: position,
    viewportCss: css,
    nativeScreenDip: {
      x: window.contentBounds.x + css.x * window.zoomFactor,
      y: window.contentBounds.y + css.y * window.zoomFactor,
    },
    displayScaleFactor: window.displayScaleFactor,
    nativeInputSent: false,
    inputScope: "renderer-viewport" as const,
  };
}
export async function prepareCoordinate(
  root: string,
  session: Session,
  observer: GuiObserver,
  handle: SnapshotHandle,
  input: Input<"act">,
) {
  const image = observer.observedImage(input.imageId!, input.snapshotId);
  const path = await agentFile(root, image.path);
  if (
    (await stat(path)).size > 12 * 1024 * 1024 ||
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex") !== image.sha256
  )
    throw new ToolError(
      "GUI_IMAGE_CHANGED",
      "原截图文件已变化，不能用作坐标依据",
      "重新观察并查看新图片",
      "blocked",
    );
  const point = imagePoint(image, input.position!, handle);
  const hit = await handle.page.evaluateHandle(
    ({ x, y }) => document.elementFromPoint(x, y),
    point.viewportCss,
  );
  const allowed = await hit.evaluate(
    (element) =>
      !!element &&
      !element.closest(
        "input,textarea,[contenteditable],iframe,[disabled],[aria-disabled='true'],[inert]",
      ),
  );
  if (!allowed) {
    await hit.dispose().catch(() => {});
    throw new ToolError(
      "GUI_POSITION_BLOCKED",
      "坐标命中禁用、敏感或不可核验区域",
      "使用语义控件，或重新观察其他目标",
      "blocked",
    );
  }
  try {
    const visibility = await assertWindowVisible(
      root,
      session,
      observer.windows,
      handle.snapshot.window,
      point.nativeScreenDip,
    );
    await observer.current(input.snapshotId, input.windowId);
    return {
      imageId: image.imageId,
      beforeImage: { imageId: image.imageId, path: image.path, snapshotId: image.snapshotId },
      point,
      visibility,
      hit,
    };
  } catch (error) {
    await hit.dispose().catch(() => {});
    throw error;
  }
}
export async function clickCoordinate(
  root: string,
  session: Session,
  observer: GuiObserver,
  handle: SnapshotHandle,
  prepared: Awaited<ReturnType<typeof prepareCoordinate>>,
) {
  await assertWindowVisible(
    root,
    session,
    observer.windows,
    handle.snapshot.window,
    prepared.point.nativeScreenDip,
  );
  await handle.page.mouse.move(prepared.point.viewportCss.x, prepared.point.viewportCss.y);
  await observer.current(handle.snapshot.snapshotId, handle.snapshot.window.windowId);
  if (
    !(await prepared.hit.evaluate(
      (element, point) => element === document.elementFromPoint(point.x, point.y),
      prepared.point.viewportCss,
    ))
  )
    throw new ToolError(
      "GUI_POSITION_OCCLUDED",
      "坐标目标已被遮挡或替换",
      "重新观察，不向原位置重放",
      "blocked",
    );
  await handle.page.mouse.click(prepared.point.viewportCss.x, prepared.point.viewportCss.y);
}
export async function executeCoordinate(
  context: {
    root: string;
    session: Session;
    observer: GuiObserver;
    handle: SnapshotHandle;
    input: Input<"act">;
  },
  receipt: ActionReceipt,
  persist: () => Promise<void>,
) {
  const { root, session, observer, handle, input } = context;
  const coordinate = await prepareCoordinate(root, session, observer, handle, input);
  try {
    const { hit: _hit, ...evidence } = coordinate;
    receipt.result = { source: "dom", coordinate: evidence, businessAssertion: "not-run" };
    receipt.inputStatus = "sending";
    await persist();
    await clickCoordinate(root, session, observer, handle, coordinate);
    receipt.inputStatus = "sent";
    await persist();
    const condition = await waitCondition(observer, handle, input.after!, input.timeoutMs);
    receipt.result = { ...(receipt.result as object), condition };
    receipt.status = "completed";
  } finally {
    await coordinate.hit.dispose().catch(() => {});
  }
}
