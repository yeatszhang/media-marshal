import type { Page } from "@playwright/test";
import type { AgentDocumentContext } from "./gui-document.ts";
import { ToolError } from "./protocol.ts";
import { sensitiveSelector } from "./sensitive-context.ts";
export async function maskInputs(page: Page) {
  const blocked = await page.locator(sensitiveSelector).count();
  if (blocked)
    throw new ToolError(
      "GUI_IMAGE_SENSITIVE",
      "验证码、扫码或画布内容禁止截图",
      "返回非敏感页面后观察",
      "blocked",
    );
  await page.evaluate(() => {
    const state = (globalThis as unknown as AgentDocumentContext).__marshalAgentDocument!;
    if (state.mask) throw new Error("截图遮罩仍在使用");
    const host = document.createElement("div");
    state.toolNodes.add(host);
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    for (const input of document.querySelectorAll("input, textarea, [contenteditable]")) {
      const box = input.getBoundingClientRect();
      const mask = document.createElement("div");
      mask.style.cssText = `position:fixed;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;background:#252b36;`;
      shadow.append(mask);
    }
    state.mask = host;
    document.documentElement.append(host);
  });
}
export async function unmaskInputs(page: Page) {
  await page.evaluate(() => {
    const state = (globalThis as unknown as AgentDocumentContext).__marshalAgentDocument;
    state?.mask?.remove();
    if (state) delete state.mask;
  });
}
