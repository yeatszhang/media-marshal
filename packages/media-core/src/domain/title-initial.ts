import { pinyinInitialGroups } from "./pinyin-initials.js";

/** 与原规则相同：空标题无值，数字/标点为 #，中文取固定字典首读音，不推断上下文。 */
export function titleInitial(title: string | null): string | null {
  const first = [...(title?.trim() ?? "")][0]; if (!first) return null;
  if (/^[A-Za-z]$/.test(first)) return first.toUpperCase();
  const point = first.codePointAt(0)!; if (point < 0x4e00 || point > 0x9fff) return "#";
  for (const [initial, characters] of Object.entries(pinyinInitialGroups)) if (characters.includes(first)) return initial;
  return "#";
}
