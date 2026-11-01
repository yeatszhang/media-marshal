import type { ElectronApplication, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { trustedPage } from "./collector.ts";
import { ToolError } from "./protocol.ts";
import type { GuiWindow } from "./gui-types.ts";
export class GuiWindows {
  private entries = new Map<Page, { id: string; generation: number }>();
  private app: ElectronApplication;
  constructor(app: ElectronApplication) {
    this.app = app;
  }
  private register(page: Page) {
    let entry = this.entries.get(page);
    if (!entry) {
      entry = { id: randomUUID(), generation: 1 };
      this.entries.set(page, entry);
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) entry!.generation++;
      });
      page.on("close", () => this.entries.delete(page));
    }
    return entry;
  }
  async list(): Promise<GuiWindow[]> {
    return Promise.all(
      this.app
        .windows()
        .filter((p) => !p.isClosed())
        .map((p) => this.describe(p)),
    );
  }
  async describe(page: Page): Promise<GuiWindow> {
    const entry = this.register(page);
    const handle = await this.app.browserWindow(page);
    const native = await handle.evaluate((window) => ({
      bounds: window.getBounds(),
      focused: window.isFocused(),
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      zoomFactor: window.webContents.getZoomFactor(),
    }));
    const observable = trustedPage(page);
    return {
      windowId: entry.id,
      generation: entry.generation,
      observable,
      ...(!observable ? { unavailableReason: "非可信主页面，禁止采集内容" } : {}),
      ...native,
    };
  }
  async select(windowId?: string) {
    const windows = await this.list();
    const candidates = windows.filter(
      (w) => w.observable && (!windowId || w.windowId === windowId),
    );
    if (candidates.length !== 1)
      throw new ToolError(
        "GUI_WINDOW_AMBIGUOUS",
        "没有唯一可观察的目标窗口",
        "使用 observe windows 查询候选并明确 windowId",
        "blocked",
      );
    const page = [...this.entries].find(([, entry]) => entry.id === candidates[0]!.windowId)?.[0];
    if (!page || page.isClosed())
      throw new ToolError("GUI_WINDOW_CLOSED", "原窗口已关闭", "重新枚举窗口", "blocked");
    return { page, window: candidates[0]! };
  }
}
