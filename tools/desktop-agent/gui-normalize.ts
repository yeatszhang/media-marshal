import type { GuiNode } from "./gui-types.ts";
import { sanitizeLogValue } from "../../apps/desktop/src/logging/shared.ts";
const editable = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const controls = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "option",
  "slider",
  ...editable,
]);
const clean = (value: unknown) =>
  typeof value === "string" ? String(sanitizeLogValue(value)).slice(0, 500) : undefined;
export function normalizeAria(value: unknown, maximum = 4000) {
  const nodes: GuiNode[] = [],
    targets = new Map<string, string>();
  let truncated = false;
  function visit(raw: unknown, depth: number, parent?: string) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    if (nodes.length >= maximum || depth > 50) {
      truncated = true;
      return;
    }
    const row = raw as Record<string, unknown>;
    const role = clean(row.role) ?? "unknown",
      ref = `n${nodes.length + 1}`;
    const name = clean(row.name),
      masked = editable.has(role);
    const hasReference = typeof row.ref === "string" && /^e\d+$/.test(row.ref);
    const actionable = !!name?.trim() && controls.has(role) && hasReference;
    const node: GuiNode = { ref, parent, depth, role, name, actionable, state: {} };
    for (const key of [
      "checked",
      "disabled",
      "expanded",
      "active",
      "invalid",
      "level",
      "pressed",
      "selected",
    ])
      if (["boolean", "number"].includes(typeof row[key]) || row[key] === "mixed")
        node.state[key] = row[key] as boolean | number | string;
    if (masked) node.valueMasked = true;
    else node.text = clean(row.text);
    node.placeholder = clean(row.placeholder);
    const box = row.box as GuiNode["box"];
    if (
      box &&
      [box.x, box.y, box.width, box.height].every(
        (n) => typeof n === "number" && Number.isFinite(n),
      )
    )
      node.box = { x: box.x, y: box.y, width: box.width, height: box.height };
    nodes.push(node);
    if (hasReference) targets.set(ref, row.ref as string);
    if (!masked && Array.isArray(row.children))
      for (const child of row.children) visit(child, depth + 1, ref);
  }
  for (const row of Array.isArray(value) ? value : []) visit(row, 0);
  const counts = new Map<string, number>();
  for (const node of nodes.filter((n) => n.actionable)) {
    const key = `${node.role}:${node.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const node of nodes)
    if (node.actionable && counts.get(`${node.role}:${node.name}`)! > 1) node.duplicateName = true;
  return { nodes, targets, truncated };
}
