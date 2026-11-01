import type { ElectronApplication } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ToolError, type Input } from "./protocol.ts";
import { atomicJson } from "./build.ts";
import { agentFile } from "./paths.ts";
import { runHome, type Session } from "./session-store.ts";
import { GuiWindows } from "./gui-windows.ts";
import { documentState, sameObservation, staleSnapshot } from "./gui-document.ts";
import { normalizeAria } from "./gui-normalize.ts";
import type { GuiSnapshot, SnapshotHandle } from "./gui-types.ts";
import { captureImage } from "./gui-image.ts";
export class GuiObserver {
  readonly windows: GuiWindows;
  private snapshots = new Map<string, SnapshotHandle>();
  private root: string;
  private session: Session;
  constructor(root: string, app: ElectronApplication, session: Session) {
    this.root = root;
    this.session = session;
    this.windows = new GuiWindows(app);
  }
  async current(snapshotId: string, windowId?: string) {
    const handle = this.snapshots.get(snapshotId);
    if (
      !handle ||
      handle.snapshot.runId !== this.session.runId ||
      (windowId && windowId !== handle.snapshot.window.windowId)
    )
      throw staleSnapshot();
    const current = await this.windows.select(handle.snapshot.window.windowId);
    const document = await documentState(handle.page);
    if (
      current.page !== handle.page ||
      !sameObservation(current.window, handle.snapshot.window) ||
      !sameObservation(document, handle.snapshot.document)
    )
      throw staleSnapshot(
        current.page !== handle.page
          ? "窗口替换"
          : !sameObservation(current.window, handle.snapshot.window)
            ? "窗口状态"
            : Object.keys(document)
                .filter(
                  (key) =>
                    !sameObservation(
                      document[key as keyof typeof document],
                      handle.snapshot.document[key as keyof typeof document],
                    ),
                )
                .join("、") + `:${document.changeReason}`,
      );
    return handle;
  }
  async sameDocument(handle: SnapshotHandle) {
    const current = await this.windows.select(handle.snapshot.window.windowId);
    if (
      handle.snapshot.runId !== this.session.runId ||
      current.page !== handle.page ||
      (await documentState(handle.page)).documentId !== handle.snapshot.document.documentId
    )
      throw staleSnapshot();
  }
  async capture(windowId?: string): Promise<SnapshotHandle> {
    const { page, window } = await this.windows.select(windowId);
    const before = await documentState(page);
    const raw = await page.ariaSnapshotJSON({ mode: "ai", boxes: true, timeout: 5000 });
    const document = await documentState(page);
    if (
      !sameObservation(before, document) ||
      !sameObservation(window, await this.windows.describe(page))
    )
      throw staleSnapshot();
    const normalized = normalizeAria(raw);
    const snapshot: GuiSnapshot = {
      snapshotId: randomUUID(),
      sessionId: this.session.sessionId,
      runId: this.session.runId,
      buildId: this.session.buildId,
      time: new Date().toISOString(),
      window,
      document,
      nodes: normalized.nodes,
      truncated: normalized.truncated,
      coordinateSystem: "viewport-css-pixels",
    };
    const handle = { snapshot, page, targets: normalized.targets };
    await atomicJson(
      join(
        await agentFile(this.root, runHome(this.root, this.session.runId)),
        `aria-${snapshot.snapshotId}.json`,
      ),
      snapshot,
    );
    this.snapshots.set(snapshot.snapshotId, handle);
    while (this.snapshots.size > 8) this.snapshots.delete(this.snapshots.keys().next().value!);
    return handle;
  }
  async observe(input: Input<"observe">) {
    if (input.mode === "windows")
      return {
        windows: await this.windows.list(),
        sessionId: this.session.sessionId,
        runId: this.session.runId,
      };
    if (input.cursor && !input.snapshotId)
      throw new ToolError(
        "GUI_PAGINATION_ID_REQUIRED",
        "继续分页需要原 snapshotId",
        "使用上一页快照身份",
        "blocked",
      );
    const handle = input.snapshotId
      ? await this.current(input.snapshotId, input.windowId)
      : await this.capture(input.windowId);
    const { snapshot } = handle;
    let nodes = snapshot.nodes;
    if (input.regionRef) {
      const region = nodes.find((n) => n.ref === input.regionRef);
      if (!region)
        throw new ToolError(
          "GUI_REF_UNKNOWN",
          "快照内没有此区域",
          "查询同一 snapshotId 的元素引用",
          "blocked",
        );
      const start = nodes.indexOf(region);
      const end = nodes.findIndex((n, i) => i > start && n.depth <= region.depth);
      nodes = nodes.slice(start, end < 0 ? undefined : end);
    }
    const { nodes: _all, ...identity } = snapshot;
    return {
      ...identity,
      nodes: nodes.slice(input.cursor, input.cursor + input.limit),
      total: nodes.length,
      cursor: input.cursor,
      nextCursor: input.cursor + input.limit < nodes.length ? input.cursor + input.limit : null,
      focusedRef: snapshot.nodes.find((n) => n.state.active)?.ref,
      dialogs: snapshot.nodes
        .filter((n) => ["dialog", "alertdialog"].includes(n.role))
        .map((n) => n.ref),
      alerts: snapshot.nodes.filter((n) => ["alert", "status"].includes(n.role)).map((n) => n.ref),
      image: input.image
        ? await captureImage(this.root, this.session, this, handle, input)
        : { status: "not-requested" },
    };
  }
}
