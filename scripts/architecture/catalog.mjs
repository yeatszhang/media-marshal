import ts from "typescript";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sources, readSource, parse } from "./source.mjs";

/** 只登记静态 DDL 声明，不将此检查解释为 SQL 写入语义分析。 */
export function declaredTables(file, source) {
  const tables = new Set(),
    ast = parse(file, source);
  function visit(node) {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const match of node.text.matchAll(
        /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([a-z][a-z0-9_]*)/gi,
      ))
        tables.add(match[1]);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return [...tables].sort();
}

export async function tableCatalog(root) {
  const result = new Set();
  for (const file of await sources(root)) {
    if (!file.startsWith("packages/media-core/src/") || file.includes(".test.")) continue;
    for (const name of declaredTables(file, await readSource(root, file))) result.add(name);
  }
  return [...result].sort();
}

export async function verifyCatalog(root) {
  const owners = JSON.parse(
    await readFile(resolve(root, "scripts/architecture/tables.json"), "utf8"),
  );
  const tables = await tableCatalog(root),
    errors = [];
  const valid = new Set([
    "configuration",
    "library",
    "sync",
    "ingestion",
    "corrections",
    "delivery",
    "retention",
    "storage",
  ]);
  for (const table of tables)
    if (!valid.has(owners[table])) errors.push(`表 ${table} 缺少唯一有效所有者`);
  for (const table of Object.keys(owners))
    if (!tables.includes(table)) errors.push(`表 ${table} 登记已过期`);
  if (errors.length) throw new Error(errors.join("\n"));
  return tables.length;
}
