import type { Page } from "@playwright/test";
export const sensitiveSelector =
  "iframe, [data-agent-sensitive='true'], canvas, img[alt*='二维码'], [aria-label*='二维码'], img[alt*='qr' i], [data-qr-code]";
const binding = "__marshalAgentSensitiveContext";
interface Guard {
  listeners: Set<() => void>;
}
const guards = new WeakMap<Page, Promise<Guard>>();
/** 页面只安装一个守卫。回调只传达敏感状态，不把 DOM 或输入值传给 Node。 */
function browserGuard({ selector, binding }: { selector: string; binding: string }) {
  const context = globalThis as unknown as Record<string, unknown>;
  if (context[binding + "Observer"]) return Boolean(document.querySelector(selector));
  const sensitive = (records: MutationRecord[] = []) => {
    const transient = records.some((record) => {
      if (record.type === "childList")
        return [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element && (node.matches(selector) || node.querySelector(selector)),
        );
      if (record.attributeName === "data-agent-sensitive") return record.oldValue === "true";
      if (record.attributeName === "data-qr-code") return record.oldValue !== null;
      return /二维码|qr/i.test(record.oldValue ?? "");
    });
    if (transient || document.querySelector(selector)) {
      const notify = context[binding] as (() => Promise<void>) | undefined;
      void notify?.().catch(() => {});
    }
  };
  const observer = new MutationObserver(sensitive);
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-agent-sensitive", "alt", "aria-label", "data-qr-code"],
  });
  context[binding + "Observer"] = observer;
  sensitive();
  return Boolean(document.querySelector(selector));
}
async function install(page: Page) {
  const guard: Guard = { listeners: new Set() };
  await page.exposeBinding(binding, () => {
    for (const listener of guard.listeners) listener();
  });
  await page.addInitScript(browserGuard, { selector: sensitiveSelector, binding });
  return guard;
}
export async function watchSensitive(page: Page, listener: () => void) {
  let pending = guards.get(page);
  if (!pending) {
    pending = install(page);
    guards.set(page, pending);
  }
  const guard = await pending;
  guard.listeners.add(listener);
  try {
    if (await page.evaluate(browserGuard, { selector: sensitiveSelector, binding })) listener();
  } catch (error) {
    guard.listeners.delete(listener);
    throw error;
  }
  return () => {
    guard.listeners.delete(listener);
  };
}
export async function sensitivePage(page: Page) {
  return (await page.locator(sensitiveSelector).count()) > 0;
}
