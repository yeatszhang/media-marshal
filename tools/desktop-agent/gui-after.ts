import type { GuiObserver } from "./gui-observe.ts";
import { commands, ToolError } from "./protocol.ts";
export async function observeAfter(observer: GuiObserver, windowId?: string) {
  try {
    const result = await observer.observe(
      commands.observe.parse({ windowId, image: true, limit: 1 }),
    );
    if (!("snapshotId" in result)) return { status: "missing" };
    return {
      status: "available",
      source: "dom",
      snapshotId: result.snapshotId,
      windowId: result.window.windowId,
      image: result.image,
    };
  } catch (error) {
    return {
      status: "missing",
      reason: error instanceof ToolError ? error.code : "GUI_AFTER_UNAVAILABLE",
    };
  }
}
