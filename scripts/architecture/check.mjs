import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { dependencyViolation } from "../desktop-boundary-rules.mjs";
import { edgeReason, moduleOf, nativeModules, allowedCore, rendererFeatures } from "./policy.mjs";
import { sources, readSource, parse, dependencies, createResolver, structure } from "./source.mjs";

export const keyOf = (issue) => `${issue.file}|${issue.rule}|${issue.symbol}`;
const production = (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
const issue = (file, rule, symbol, reason) => ({
  file,
  rule,
  symbol,
  value: 1,
  maximum: 0,
  reason,
});

/** 保留图中的真实文件路径；barrel 的所有出口和类型出口均参与遍历。 */
export function cycles(edges) {
  const graph = new Map();
  for (const [a, b] of edges) {
    if (!graph.has(a)) graph.set(a, new Set());
    graph.get(a).add(b);
    if (!graph.has(b)) graph.set(b, new Set());
  }
  const indices = new Map(),
    low = new Map(),
    stack = [],
    active = new Set(),
    result = [];
  let next = 0;
  function visit(v) {
    indices.set(v, next);
    low.set(v, next++);
    stack.push(v);
    active.add(v);
    for (const w of graph.get(v)) {
      if (!indices.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (active.has(w)) low.set(v, Math.min(low.get(v), indices.get(w)));
    }
    if (indices.get(v) !== low.get(v)) return;
    const component = [];
    let w;
    do {
      w = stack.pop();
      active.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1 || graph.get(component[0]).has(component[0]))
      result.push(component.sort());
  }
  for (const v of graph.keys()) if (!indices.has(v)) visit(v);
  return result;
}

function areaOf(file) {
  return (
    [
      "packages/contracts/src",
      "packages/media-core/src",
      "apps/desktop/src/renderer",
      "apps/desktop/src/preload",
    ].find((area) => file.startsWith(area)) ?? "host"
  );
}

function registrationIssues(file, ast, module) {
  const violations = [];
  if (
    file.startsWith("packages/media-core/src/modules/") &&
    !["core:bootstrap", ...Object.keys(allowedCore).map((name) => `core:${name}`)].includes(module)
  )
    violations.push(issue(file, "unregistered-module", module, "新增业务模块必须登记依赖矩阵"));
  if (
    file.includes("/renderer/src/features/") &&
    !rendererFeatures.includes(module.slice("renderer:".length))
  )
    violations.push(issue(file, "unregistered-module", module, "新增前端功能必须登记"));
  for (const node of ast.statements) {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      /\/(public|index)\.ts$/.test(file) &&
      /persistence/.test(node.moduleSpecifier.text)
    )
      violations.push(
        issue(file, "private-export", node.moduleSpecifier.text, "公开出口不能转发持久化实现"),
      );
  }
  return violations;
}

export async function scan(root, mode = "all") {
  const files = await sources(root),
    resolver = createResolver(root),
    violations = [],
    runtime = [],
    moduleEdges = [];
  for (const file of files) {
    const text = await readSource(root, file),
      ast = parse(file, text);
    if (!production(file)) continue;
    if (mode !== "boundaries") violations.push(...(await structure(file, text)));
    if (mode === "structure") continue;
    const area = areaOf(file),
      module = moduleOf(file);
    violations.push(...registrationIssues(file, ast, module));
    for (const dep of dependencies(ast)) {
      if (dep.dynamic) {
        if (/^(core:|renderer:|contracts:)/.test(module) && !/\/native-rename\.ts$/.test(file))
          violations.push(
            issue(file, "dynamic-import", "动态模块", "受限区域不得使用非字面量模块加载"),
          );
        continue;
      }
      const existing = dependencyViolation(area, resolve(root, file), dep.name);
      if (existing) violations.push(issue(file, "process-boundary", dep.name, existing));
      if (
        ["core:domain", "portable:logging"].includes(module) &&
        (nativeModules.has(dep.name) || /app-framework/.test(dep.name))
      )
        violations.push(issue(file, "domain-purity", dep.name, "纯规则不得导入宿主或框架"));
      let target;
      try {
        target = resolver(file, dep.name);
      } catch (error) {
        violations.push(issue(file, "unresolved-import", dep.name, error.message));
        continue;
      }
      if (!target) continue;
      const reason = edgeReason(file, target, dep.typeOnly);
      if (reason) violations.push(issue(file, "module-boundary", target, reason));
      const b = moduleOf(target);
      if (/^renderer:/.test(module) && !/^renderer:|^contracts:public$|^portable:logging$/.test(b))
        violations.push(issue(file, "renderer-host", target, "Renderer 不得取得宿主或私有契约"));
      if (!dep.typeOnly) runtime.push([file, target]);
      if (module !== b && module.startsWith("core:") && b.startsWith("core:"))
        moduleEdges.push([module, b]);
    }
    if (
      module.startsWith("core:") &&
      module !== "core:storage" &&
      !file.includes("/persistence/")
    ) {
      const calls = new Set();
      function visit(node) {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ["prepare", "exec"].includes(node.expression.name.text)
        )
          calls.add(node.expression.expression.getText(ast));
        ts.forEachChild(node, visit);
      }
      visit(ast);
      for (const receiver of calls)
        violations.push(issue(file, "sql-access", receiver, "业务用例不能调用原始 SQL 入口"));
    }
  }
  if (mode !== "structure") {
    for (const group of cycles(runtime))
      violations.push(issue(group[0], "runtime-cycle", group.join(" → "), "运行时依赖存在循环"));
    for (const group of cycles(moduleEdges))
      violations.push(
        issue(
          "packages/media-core/src",
          "module-cycle",
          group.join(" → "),
          "跨业务模块存在包括类型在内的循环",
        ),
      );
  }
  return [...new Map(violations.map((v) => [keyOf(v), v])).values()].sort((a, b) =>
    keyOf(a).localeCompare(keyOf(b)),
  );
}

export function applyExceptions(violations, exceptions, previous, now = Date.now()) {
  const errors = [],
    observed = new Map(violations.map((v) => [keyOf(v), v])),
    allowed = new Map();
  for (const entry of exceptions) {
    const key = keyOf(entry),
      before = previous?.find((v) => keyOf(v) === key);
    if (allowed.has(key)) errors.push(`${key}: 例外重复`);
    allowed.set(key, entry);
    const expiry = Date.parse(entry.expires);
    if (
      !entry.reason ||
      !entry.owner ||
      !entry.task ||
      !Number.isFinite(expiry) ||
      expiry <= now ||
      expiry > now + 60 * 86400000 ||
      /[*?]/.test(entry.file)
    )
      errors.push(`${key}: 例外须精确、说明责任和任务，且在六十天内到期`);
    if (previous && (!before || before.value < entry.value || Date.parse(before.expires) < expiry))
      errors.push(`${key}: 不允许增加、扩大或延期例外`);
    const current = observed.get(key);
    if (!current) errors.push(`${key}: 已无违规，请删除陈旧例外`);
    else if (current.value > entry.value)
      errors.push(`${key}: 超出登记上限 ${entry.value}，当前 ${current.value}`);
  }
  for (const v of violations)
    if (!allowed.has(keyOf(v)))
      errors.push(`${keyOf(v)}: ${v.reason ?? `当前 ${v.value}，预算 ${v.maximum}`}`);
  return errors;
}

export async function run(root, mode = "all", base = process.env.ARCHITECTURE_BASE_REF) {
  if (!["all", "boundaries", "structure"].includes(mode)) throw new Error("未知架构检查模式");
  const violations = await scan(root, mode);
  const path = "scripts/architecture/exceptions.json";
  const current = JSON.parse(await readFile(resolve(root, path), "utf8"));
  if (process.env.CI && !base)
    throw new Error("CI 必须显式提供 ARCHITECTURE_BASE_REF，不能跳过基点核对");
  const ref = base ?? "HEAD";
  // 先确认基点有效；不存在的 ref 与浅克隆不能被当作初次接入。
  const commit = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const listing = execFileSync("git", ["ls-tree", commit, path], { cwd: root, encoding: "utf8" });
  let previous;
  if (listing.trim())
    previous = JSON.parse(
      execFileSync("git", ["show", `${commit}:${path}`], { cwd: root, encoding: "utf8" }),
    ).entries;
  else {
    // 首次 PR 的基点尚无清单时，仍与历史上第一次加入的清单比较，不能借初始化扩大例外。
    const additions = execFileSync(
      "git",
      ["log", "--diff-filter=A", "--format=%H", "HEAD", "--", path],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    const first = additions.at(-1);
    if (first) {
      execFileSync("git", ["merge-base", "--is-ancestor", commit, first], { cwd: root });
      previous = JSON.parse(
        execFileSync("git", ["show", `${first}:${path}`], { cwd: root, encoding: "utf8" }),
      ).entries;
    } else if (process.env.CI || commit !== current.initialBase) {
      throw new Error("基点未包含架构例外清单，且不是明确的首次接入基点");
    }
  }
  const choose = (v) =>
    mode === "structure"
      ? ["function-lines", "file-lines", "class-methods"].includes(v.rule)
      : mode === "boundaries"
        ? !["function-lines", "file-lines", "class-methods"].includes(v.rule)
        : true;
  const exceptions = current.entries.filter(choose);
  const errors = applyExceptions(violations, exceptions, previous?.filter(choose));
  if (errors.length) throw new Error(errors.join("\n"));
  return { mode, violations: violations.length, temporaryExceptions: exceptions.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(resolve(import.meta.dirname, "../.."), process.argv[2] ?? "all").then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
