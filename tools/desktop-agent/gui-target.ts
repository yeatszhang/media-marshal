import type { Locator } from "@playwright/test";
import type { SnapshotHandle } from "./gui-types.ts";
import { ToolError, type Input } from "./protocol.ts";
type Target = Pick<Input<"act">, "targetRef" | "target">;
export function selectTarget(handle: SnapshotHandle, input: Target): Locator {
  if (!!input.targetRef === !!input.target)
    throw new ToolError(
      "GUI_TARGET_REQUIRED",
      "需明确一个元素引用或语义目标",
      "从当前快照选择目标；不能提供任意 selector",
      "blocked",
    );
  if (input.target)
    return handle.page.getByRole(input.target.role, { name: input.target.name, exact: true });
  const ref = handle.targets.get(input.targetRef!);
  if (!ref)
    throw new ToolError(
      "GUI_REF_UNKNOWN",
      "快照内不存在可定位引用",
      "重新观察并选择有效元素",
      "blocked",
    );
  return handle.page.locator(`aria-ref=${ref}`);
}
export async function uniqueTarget(handle: SnapshotHandle, input: Target, actionable = false) {
  const locator = selectTarget(handle, input),
    count = await locator.count();
  if (count !== 1) {
    const candidates = handle.snapshot.nodes
      .filter(
        (node) =>
          input.target && node.role === input.target.role && node.name === input.target.name,
      )
      .map((node) => node.ref);
    throw new ToolError(
      "GUI_TARGET_AMBIGUOUS",
      "目标未命中唯一元素",
      `重新观察并消歧，候选引用：${candidates.join("、") || "无"}`,
      "blocked",
    );
  }
  if (actionable) {
    const nodes = handle.snapshot.nodes.filter((node) =>
      input.targetRef
        ? node.ref === input.targetRef
        : node.role === input.target?.role && node.name === input.target?.name,
    );
    if (nodes.length !== 1 || !nodes[0]!.actionable)
      throw new ToolError(
        "GUI_TARGET_NOT_ACTIONABLE",
        "目标缺少可核验的名称、角色或操作能力",
        "选择快照中标记 actionable 的控件",
        "blocked",
      );
    if (!(await locator.isVisible()) || !(await locator.isEnabled()))
      throw new ToolError(
        "GUI_TARGET_DISABLED",
        "控件当前不可见或禁用",
        "等待条件满足后重新观察",
        "blocked",
      );
  }
  return locator;
}
