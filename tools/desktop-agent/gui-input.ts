import type { Locator } from "@playwright/test";
import { ToolError, type Input } from "./protocol.ts";
export function validateInput(input: Input<"act">) {
  if (
    input.position &&
    (input.action !== "click" ||
      !input.imageId ||
      input.target ||
      input.targetRef ||
      input.value !== undefined ||
      !input.after)
  )
    throw new ToolError(
      "GUI_COORDINATE_INPUT",
      "截图坐标点击需要 imageId 和后置条件，且不能混入语义目标或值",
      "重新 observe image，明确同快照的图像像素坐标与条件",
      "blocked",
    );
  if (!input.position && input.imageId)
    throw new ToolError(
      "GUI_COORDINATE_INPUT",
      "图片身份仅用于坐标点击",
      "同时指定图像像素 position",
      "blocked",
    );
  if (
    (["fill", "select", "key", "scroll"].includes(input.action) &&
      typeof input.value !== "string") ||
    (input.action === "check" && typeof input.value !== "boolean")
  )
    throw new ToolError(
      "GUI_ACTION_VALUE_REQUIRED",
      "动作缺少有效参数",
      "fill／select／key／scroll 使用字符串，check 使用布尔值",
      "blocked",
    );
  if (
    input.action === "key" &&
    !/^(Enter|Escape|Tab|Shift\+Tab|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Backspace|Delete|Space|ControlOrMeta\+A)$/.test(
      String(input.value),
    )
  )
    throw new ToolError(
      "GUI_KEY_UNSUPPORTED",
      "按键不在受限列表",
      "使用 help 与工具文档中的导航／编辑按键",
      "blocked",
    );
  if (input.action === "scroll" && !["up", "down", "left", "right"].includes(String(input.value)))
    throw new ToolError(
      "GUI_SCROLL_UNSUPPORTED",
      "滚动方向无效",
      "使用 up／down／left／right",
      "blocked",
    );
}
export async function sendInput(locator: Locator, input: Input<"act">) {
  const options = { timeout: input.timeoutMs };
  if (input.action === "click") await locator.click(options);
  else if (input.action === "fill") await locator.fill(input.value as string, options);
  else if (input.action === "select") await locator.selectOption(input.value as string, options);
  else if (input.action === "check") await locator.setChecked(input.value as boolean, options);
  else if (input.action === "key") await locator.press(input.value as string, options);
  else
    await locator.evaluate(
      (element, direction) => {
        element.scrollBy({
          left: direction === "left" ? -300 : direction === "right" ? 300 : 0,
          top: direction === "up" ? -300 : direction === "down" ? 300 : 0,
          behavior: "instant",
        });
      },
      String(input.value),
      options,
    );
}
