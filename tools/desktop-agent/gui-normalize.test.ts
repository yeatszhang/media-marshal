import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAria } from "./gui-normalize.ts";

test("语义快照遮罩输入值、保留控件状态和重名候选，不伪造匿名操作目标", () => {
  const normalized = normalizeAria([
    {
      role: "textbox",
      name: "访问令牌",
      ref: "e1",
      text: "secret-one",
      children: [{ role: "text", text: "secret-two" }],
    },
    {
      role: "button",
      ref: "e2",
      name: "保存",
      disabled: true,
      box: { x: 1, y: 2, width: 3, height: 4 },
    },
    { role: "button", ref: "e3", name: "保存" },
    { role: "button", ref: "e4", name: "" },
    { role: "dialog", name: "错误", children: [{ role: "alert", text: "必须选择目录" }] },
  ]);
  assert.equal(JSON.stringify(normalized.nodes).includes("secret"), false);
  assert.equal(normalized.nodes[0]!.valueMasked, true);
  assert.equal(normalized.nodes[1]!.state.disabled, true);
  assert.equal(normalized.nodes[1]!.duplicateName, true);
  assert.equal(normalized.nodes[2]!.duplicateName, true);
  assert.equal(normalized.nodes[3]!.actionable, false);
  assert.equal(normalized.nodes.at(-1)!.parent, normalized.nodes.at(-2)!.ref);
  assert.deepEqual(normalized.nodes[1]!.box, { x: 1, y: 2, width: 3, height: 4 });
});
test("快照只保存合法内部引用与有限节点，不输出任意 ARIA 扩展属性", () => {
  const normalized = normalizeAria(
    [
      { role: "button", name: "正常", ref: "e1", cookies: "秘密" },
      { role: "button", name: "非法引用", ref: "css=body" },
      { role: "text", text: "超出预算" },
    ],
    2,
  );
  assert.equal(normalized.nodes.length, 2);
  assert.equal(normalized.targets.size, 1);
  assert.equal(normalized.nodes[1]!.actionable, false);
  assert.equal(normalized.truncated, true);
  assert.equal(JSON.stringify(normalized.nodes).includes("秘密"), false);
});
