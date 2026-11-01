import type { Page } from "@playwright/test";
import type { DocumentState } from "./gui-types.ts";
import { ToolError } from "./protocol.ts";
import { trustedPage } from "./collector.ts";
export interface AgentDocumentContext {
  __marshalAgentDocument?: {
    id: string;
    revision: number;
    observer: MutationObserver;
    toolNodes: WeakSet<Node>;
    mask?: HTMLElement;
    relevant: (records: MutationRecord[]) => boolean;
  };
}
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
  const result = await page.evaluate(() => {
    const context = globalThis as unknown as AgentDocumentContext;
    if (!context.__marshalAgentDocument) {
      const toolNodes = new WeakSet<Node>();
      const relevant = (records: MutationRecord[]) =>
        records.some((record) => {
          if (toolNodes.has(record.target)) return false;
          if (record.type !== "childList") return true;
          return [...record.addedNodes, ...record.removedNodes].some(
            (node) => !toolNodes.has(node),
          );
        });
      const state = {
        id: crypto.randomUUID(),
        revision: 0,
        observer: null as unknown as MutationObserver,
        toolNodes,
        relevant,
      };
      state.observer = new MutationObserver((records) => {
        if (relevant(records)) state.revision++;
      });
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
    if (state.relevant(state.observer.takeRecords())) state.revision++;
    const elements = [...document.querySelectorAll("*")].filter(
      (node) => !state.toolNodes.has(node),
    );
    let layout = 2166136261;
    for (const element of elements.slice(0, 6000)) {
      const box = element.getBoundingClientRect();
      for (const value of [box.x, box.y, box.width, box.height])
        layout = Math.imul(layout ^ Math.round(value * 100), 16777619);
    }
    return {
      documentId: state.id,
      revision: state.revision,
      layoutDigest: (layout >>> 0).toString(16),
      layoutComplete: elements.length <= 6000,
      url: location.origin + location.pathname,
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      scroll: { x: scrollX, y: scrollY },
      focused: document.hasFocus(),
    };
  });
  if (!result.layoutComplete)
    throw new ToolError(
      "GUI_LAYOUT_LIMIT",
      "页面超过可核验布局预算",
      "缩小页面内容后重新观察",
      "blocked",
    );
  return result;
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
