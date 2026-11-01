import type { Page } from "@playwright/test";
import type { DocumentState } from "./gui-types.ts";
import { ToolError } from "./protocol.ts";
import { trustedPage } from "./collector.ts";
export interface AgentDocumentContext {
  __marshalAgentDocument?: {
    id: string;
    revision: number;
    lastChange: string;
    observer: MutationObserver;
    toolNodes: WeakSet<Node>;
    mask?: HTMLElement;
    relevant: (records: MutationRecord[]) => boolean;
  };
}
function readBrowserDocument(): DocumentState {
  const context = globalThis as unknown as AgentDocumentContext;
  if (!context.__marshalAgentDocument) {
    const toolNodes = new WeakSet<Node>();
    const relevant = (records: MutationRecord[]) => {
      const attributes = new Map<Element, Map<string, string | null>>();
      const texts = new Map<Node, string | null>();
      for (const record of records) {
        if (toolNodes.has(record.target)) continue;
        if (record.type === "childList") {
          if ([...record.addedNodes, ...record.removedNodes].some((node) => !toolNodes.has(node)))
            return true;
        } else if (record.type === "attributes") {
          const element = record.target as Element;
          let first = attributes.get(element);
          if (!first) {
            first = new Map();
            attributes.set(element, first);
          }
          if (!first.has(record.attributeName!)) first.set(record.attributeName!, record.oldValue);
        } else if (!texts.has(record.target)) texts.set(record.target, record.oldValue);
      }
      for (const [element, first] of attributes)
        for (const [name, old] of first) if (element.getAttribute(name) !== old) return true;
      for (const [node, old] of texts) if (node.textContent !== old) return true;
      return false;
    };
    const state = {
      id: crypto.randomUUID(),
      revision: 0,
      lastChange: "initial",
      observer: null as unknown as MutationObserver,
      toolNodes,
      relevant,
    };
    state.observer = new MutationObserver((records) => {
      if (relevant(records)) {
        state.revision++;
        state.lastChange = `mutation:${records.at(-1)?.type}`;
      }
    });
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    });
    for (const event of ["input", "change", "focusin", "focusout"])
      document.addEventListener(
        event,
        () => {
          state.revision++;
          state.lastChange = event;
        },
        true,
      );
    context.__marshalAgentDocument = state;
  }
  const state = context.__marshalAgentDocument;
  const pending = state.observer.takeRecords();
  if (state.relevant(pending)) {
    state.revision++;
    state.lastChange = `mutation:${pending.at(-1)?.type}`;
  }
  const elements = [...document.querySelectorAll("*")].filter((node) => !state.toolNodes.has(node));
  let layout = 2166136261;
  for (const element of elements.slice(0, 6000)) {
    const box = element.getBoundingClientRect();
    for (const value of [box.x, box.y, box.width, box.height])
      layout = Math.imul(layout ^ Math.round(value * 100), 16777619);
  }
  return {
    documentId: state.id,
    revision: state.revision,
    changeReason: state.lastChange,
    layoutDigest: (layout >>> 0).toString(16),
    layoutComplete: elements.length <= 6000,
    url: location.origin + location.pathname,
    viewport: { width: innerWidth, height: innerHeight },
    devicePixelRatio,
    scroll: { x: scrollX, y: scrollY },
    focused: document.hasFocus(),
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
  const result = await page.evaluate(readBrowserDocument);
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
export const staleSnapshot = (reason = "") =>
  new ToolError(
    "GUI_SNAPSHOT_STALE",
    `窗口、文档、焦点或布局已变化，旧引用失效${reason ? `（${reason}）` : ""}`,
    "重新 observe，再根据新快照操作；不自动重放确认动作",
    "blocked",
  );
