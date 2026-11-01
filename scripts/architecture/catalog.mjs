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
  verifyTableLifecycle(
    owners,
    JSON.parse(await readFile(resolve(root, "scripts/architecture/table-lifecycle.json"), "utf8")),
  );
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

export function verifyTableLifecycle(owners, lifecycle) {
  const groups = [
    "historicalDdlOnly",
    "legacyTakeoverTables",
    "protectedFacts",
    "retainedIdentities",
  ];
  for (const group of groups) {
    const names = lifecycle[group];
    if (!Array.isArray(names) || new Set(names).size !== names.length)
      throw new Error(`表生命周期 ${group} 缺失或重复`);
    for (const name of names)
      if (!Object.hasOwn(owners, name)) throw new Error(`表生命周期包含未登记表 ${name}`);
  }
  const removed = new Set([...lifecycle.historicalDdlOnly, ...lifecycle.legacyTakeoverTables]);
  if (removed.size !== lifecycle.historicalDdlOnly.length + lifecycle.legacyTakeoverTables.length)
    throw new Error("历史临时表不能同时登记为当前旧配置接管表");
  for (const name of [...lifecycle.protectedFacts, ...lifecycle.retainedIdentities])
    if (removed.has(name)) throw new Error(`当前成功历史、恢复事实或身份不能进入删除集 ${name}`);
  for (const [table, columns] of Object.entries(lifecycle.legacyTakeoverColumns)) {
    if (
      !Object.hasOwn(owners, table) ||
      !Array.isArray(columns) ||
      !columns.length ||
      new Set(columns).size !== columns.length ||
      columns.some((name) => !/^[a-z][a-z0-9_]*$/.test(name))
    )
      throw new Error(`旧接管字段登记无效 ${table}`);
  }
}
