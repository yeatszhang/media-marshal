/** Rclone 路径 glob 的有界子集。只解析数据，不接受原始正则或命令参数。 */
type Token = { kind: "literal"; value: string } | { kind: "star" } | { kind: "deep" } | { kind: "any" } | { kind: "class"; test: RegExp };
function alternatives(pattern: string): string[] {
  let escaped = false, bracket = false, start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === "[") bracket = true;
    if (c === "]") bracket = false;
    if (bracket) continue;
    if (c === "{") { if (start >= 0) throw new Error("暂不支持嵌套花括号或原始正则"); start = i; }
    if (c === "}") {
      if (start < 0) throw new Error("花括号不配对");
      const group = pattern.slice(start + 1, i);
      if (!group || /[\\/]/.test(group) || group.includes("**")) throw new Error("花括号仅支持同一路径段内的逗号备选");
      const values = group.split(",");
      if (values.length < 2 || values.some((value) => !value)) throw new Error("花括号需要至少两个非空备选");
      const result = values.flatMap((value) => alternatives(pattern.slice(0, start) + value + pattern.slice(i + 1)));
      if (result.length > 32) throw new Error("通配备选不能超过 32 个");
      return result;
    }
  }
  if (start >= 0) throw new Error("花括号不配对");
  return [pattern];
}
function tokenize(pattern: string, caseSensitive: boolean): Token[] {
  const result: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const value = pattern[++i];
      if (!value || !/[\\*?\[\]{}.,+()|^$-]/.test(value)) throw new Error("反斜杠只能转义 glob 特殊字符");
      result.push({ kind: "literal", value });
    } else if (c === "*") {
      if (pattern[i + 1] === "*") { i++; if (pattern[i + 1] === "*") throw new Error("连续星号最多两个"); result.push({ kind: "deep" }); }
      else result.push({ kind: "star" });
    } else if (c === "?") result.push({ kind: "any" });
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1), value = pattern.slice(i + 1, end);
      if (end < 0 || !value || /[\\/\[!]/.test(value)) throw new Error("字符组仅支持字符、范围和 ^ 排除，不支持 POSIX 字符组");
      let test: RegExp; try { test = new RegExp(`^[${value}]$`, caseSensitive ? "u" : "iu"); } catch { throw new Error("字符组或范围无效"); }
      result.push({ kind: "class", test }); i = end;
    } else if (c === "]" || c === "{" || c === "}") throw new Error("glob 括号不配对");
    else { const value = String.fromCodePoint(pattern.codePointAt(i)!); result.push({ kind: "literal", value }); i += value.length - 1; }
  }
  return result;
}

export function compileSyncGlob(pattern: string, caseSensitive = true): (path: string) => boolean {
  if (!pattern || pattern.length > 4096 || /[\0\r\n]/.test(pattern) || pattern.includes("//")) throw new Error("过滤表达式必须是有效的单行相对路径 glob");
  const anchored = pattern.startsWith("/"), body = anchored ? pattern.slice(1) : pattern;
  const patterns = alternatives(body).map((value) => tokenize(value, caseSensitive));
  return (path) => {
    if (path.length > 4096 || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) return false;
    const chars = [...path];
    return patterns.some((tokens) => {
      // 动态规划避免多个 * 在长文件名上触发正则回溯。
      let previous = new Uint8Array(chars.length + 1); previous[0] = 1;
      if (!anchored) chars.forEach((c, index) => { if (c === "/") previous[index + 1] = 1; });
      for (const token of tokens) {
        const next = new Uint8Array(chars.length + 1);
        for (let i = 0; i <= chars.length; i++) {
          if (token.kind === "star" || token.kind === "deep") {
            if (previous[i] || i > 0 && next[i - 1] && (token.kind === "deep" || chars[i - 1] !== "/")) next[i] = 1;
          } else if (i > 0 && previous[i - 1]) {
            const c = chars[i - 1]!;
            if (token.kind === "any" ? c !== "/" : token.kind === "class" ? c !== "/" && token.test.test(c) : caseSensitive ? c === token.value : c.toLowerCase() === token.value.toLowerCase()) next[i] = 1;
          }
        }
        previous = next;
      }
      return previous[chars.length] === 1;
    });
  };
}

export function syncGlobIssue(pattern: string, action: "include" | "exclude"): string | null {
  try {
    if (pattern.endsWith("/") && action === "include") throw new Error("包含规则请指定文件 glob；暂不支持仅目录包含");
    compileSyncGlob(pattern.endsWith("/") ? pattern + "**" : pattern);
    return null;
  } catch (error) { return error instanceof Error ? error.message : "过滤表达式无效"; }
}

export function compileSyncFilters(rules: readonly { action: "include" | "exclude"; pattern: string; caseSensitive?: boolean }[]): (path: string) => boolean {
  const compiled = rules.map((rule) => {
    const issue = syncGlobIssue(rule.pattern, rule.action); if (issue) throw new Error(issue);
    return { include: rule.action === "include", match: compileSyncGlob(rule.pattern.endsWith("/") ? rule.pattern + "**" : rule.pattern, rule.caseSensitive ?? true) };
  });
  return (path) => compiled.find((rule) => rule.match(path))?.include ?? true;
}
