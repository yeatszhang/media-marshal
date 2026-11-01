import type { Page } from "@playwright/test";
import type { DocumentState } from "./gui-types.ts";
import { ToolError } from "./protocol.ts";
import { trustedPage } from "./collector.ts";
export async function documentState(page: Page): Promise<DocumentState> {
  if (!trustedPage(page))
    throw new ToolError("GUI_ORIGIN_BLOCKED", "窗口来源不可观察", "选择自有主窗口", "blocked");
  if (await page.locator("iframe, [data-agent-sensitive='true']").count())
    throw new ToolError(
      "GUI_SENSITIVE_CONTEXT",
      "嵌入页面或明确敏感上下文禁止采集",
      "返回可信主页面后重新观察",
      "blocked",
    );
  return page.evaluate(() => {
    const context = globalThis as unknown as {
      __marshalAgentDocument?: { id: string; revision: number; observer: MutationObserver };
    };
    if (!context.__marshalAgentDocument) {
      const state = {
        id: crypto.randomUUID(),
        revision: 0,
        observer: null as unknown as MutationObserver,
      };
      state.observer = new MutationObserver(() => state.revision++);
      state.observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      for (const event of ["input", "change", "focusin", "focusout"])
        document.addEventListener(event, () => state.revision++, true);
      context.__marshalAgentDocument = state;
    }
    const state = context.__marshalAgentDocument;
    if (state.observer.takeRecords().length) state.revision++;
    return {
      documentId: state.id,
      revision: state.revision,
      url: location.origin + location.pathname,
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      scroll: { x: scrollX, y: scrollY },
      focused: document.hasFocus(),
    };
  });
}
export function sameObservation(before: unknown, after: unknown) {
  return JSON.stringify(before) === JSON.stringify(after);
}
export const staleSnapshot = () =>
  new ToolError(
    "GUI_SNAPSHOT_STALE",
    "窗口、文档、焦点或布局已变化，旧引用失效",
    "重新 observe，再根据新快照操作；不自动重放确认动作",
    "blocked",
  );
