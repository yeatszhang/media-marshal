import type { SnapshotHandle } from "./gui-types.ts";
import type { GuiObserver } from "./gui-observe.ts";
import { ToolError, type Input } from "./protocol.ts";
import { selectTarget } from "./gui-target.ts";
type Condition = NonNullable<Input<"act">["after"]>;
export function validateCondition(input: Condition) {
  if (!!input.targetRef === !!input.target)
    throw new ToolError(
      "GUI_TARGET_REQUIRED",
      "条件需要唯一引用或语义目标",
      "明确一个条件目标",
      "blocked",
    );
  if (
    (["text", "value"].includes(input.state) && typeof input.value !== "string") ||
    (input.state === "checked" && typeof input.value !== "boolean")
  )
    throw new ToolError(
      "GUI_CONDITION_VALUE_REQUIRED",
      "条件缺少匹配值",
      "文本／值使用字符串，checked 使用布尔值",
      "blocked",
    );
}
async function matches(handle: SnapshotHandle, condition: Condition) {
  const locator = selectTarget(handle, condition),
    count = await locator.count();
  if (count > 1)
    throw new ToolError(
      "GUI_TARGET_AMBIGUOUS",
      "等待条件命中多个元素",
      "重新观察并明确唯一目标",
      "blocked",
    );
  if (condition.state === "hidden") return !count || !(await locator.isVisible());
  if (!count) return false;
  if (condition.state === "visible") return locator.isVisible();
  if (condition.state === "enabled") return locator.isEnabled();
  if (condition.state === "disabled") return !(await locator.isEnabled());
  if (condition.state === "checked") return (await locator.isChecked()) === condition.value;
  if (condition.state === "value")
    return (await locator.inputValue({ timeout: 500 })) === condition.value;
  return (await locator.textContent({ timeout: 500 }))?.includes(String(condition.value)) ?? false;
}
export async function waitCondition(
  observer: Pick<GuiObserver, "sameDocument">,
  handle: SnapshotHandle,
  condition: Condition,
  timeoutMs: number,
) {
  validateCondition(condition);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    await observer.sameDocument(handle);
    if (await matches(handle, condition))
      return { status: "passed", state: condition.state, expectedValueRecorded: false };
    if (Date.now() >= deadline)
      throw new ToolError(
        "GUI_CONDITION_TIMEOUT",
        "预期界面条件尚未成立",
        "查询原动作和业务状态，不自动重放确认",
        "unknown",
      );
    await new Promise((done) => setTimeout(done, 100));
  }
}
