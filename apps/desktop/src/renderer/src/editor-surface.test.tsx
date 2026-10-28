// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EditorSurface } from "./components/EditorSurface";
import { i18nReady } from "./i18n";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(HTMLDialogElement.prototype, { showModal() { this.setAttribute("open", ""); }, close() { this.removeAttribute("open"); } });
const cleanup: (() => void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await act(close); document.body.innerHTML = ""; });
async function mount(dirty: boolean, busy = false) {
  await i18nReady;
  const trigger = document.createElement("button"), host = document.createElement("div"); document.body.append(trigger, host); trigger.focus();
  const root = createRoot(host), close = vi.fn(); cleanup.push(() => root.unmount());
  await act(async () => root.render(<EditorSurface title="编辑来源" dirty={dirty} busy={busy} onClose={close}>{(requestClose) => <><input aria-label="名称" defaultValue="保留输入" /><button onClick={requestClose}>关闭</button></>}</EditorSurface>));
  return { close, trigger, root };
}
it("脏草稿 Escape 先确认，继续编辑保留内容，明确放弃才关闭", async () => {
  const { close } = await mount(true);
  const field = document.querySelector("input")!; expect(document.activeElement).toBe(field);
  await act(async () => document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
  expect(close).not.toHaveBeenCalled(); expect(document.querySelectorAll("dialog[open]")).toHaveLength(2);
  await act(async () => [...document.querySelectorAll("button")].find((node) => node.textContent === "继续编辑")!.click());
  expect(field.value).toBe("保留输入"); expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
  await act(async () => document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
  await act(async () => [...document.querySelectorAll("button")].find((node) => node.textContent === "放弃修改")!.click());
  expect(close).toHaveBeenCalledTimes(1);
});
it("未修改可直接关闭，卸载恢复入口焦点", async () => {
  const { close, trigger, root } = await mount(false);
  await act(async () => document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
  expect(close).toHaveBeenCalledTimes(1); await act(async () => { root.unmount(); await new Promise(requestAnimationFrame); }); expect(document.activeElement).toBe(trigger); cleanup.length = 0;
});
it("提交期间 Escape 不关闭也不清理输入", async () => {
  const { close } = await mount(true, true);
  await act(async () => document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
  expect(close).not.toHaveBeenCalled(); expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
});
