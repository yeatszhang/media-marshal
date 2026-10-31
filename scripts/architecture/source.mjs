import ts from "typescript";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, dirname, extname } from "node:path";
import prettier from "prettier";
import { sourceRoots, limits } from "./policy.mjs";

export const normalized = (path) => path.replaceAll("\\", "/");
export async function sources(root) {
  const result = [];
  async function walk(path) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (["node_modules", "dist", "fixtures", "out", "release"].includes(entry.name)) continue;
      const next = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (
        /\.[cm]?[jt]sx?$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts") &&
        entry.name !== "pinyin-initials.ts"
      )
        result.push(normalized(relative(root, next)));
    }
  }
  for (const path of sourceRoots) await walk(resolve(root, path));
  return result.sort();
}

export function parse(file, source) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : undefined,
  );
}

export function dependencies(ast) {
  const edges = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        edges.push({
          name: node.moduleSpecifier.text,
          typeOnly: !!(
            node.isTypeOnly ||
            node.importClause?.isTypeOnly ||
            (node.importClause &&
              !node.importClause.name &&
              node.importClause.namedBindings &&
              ts.isNamedImports(node.importClause.namedBindings) &&
              node.importClause.namedBindings.elements.length &&
              node.importClause.namedBindings.elements.every((entry) => entry.isTypeOnly))
          ),
        });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      edges.push({ name: node.argument.literal.text, typeOnly: true });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const value = node.arguments[0];
      edges.push(
        value && ts.isStringLiteral(value)
          ? { name: value.text, typeOnly: false }
          : { dynamic: true, typeOnly: false },
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return edges;
}

export function createResolver(root) {
  const config = ts.readConfigFile(resolve(root, "apps/desktop/tsconfig.json"), ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const options = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    resolve(root, "apps/desktop"),
  ).options;
  const cache = ts.createModuleResolutionCache(root, (name) => name, options);
  return (file, name) => {
    const result = ts.resolveModuleName(
      name,
      resolve(root, file),
      options,
      ts.sys,
      cache,
    ).resolvedModule;
    if (!result) {
      if (name.endsWith(".css") && existsSync(resolve(root, dirname(file), name)))
        return normalized(relative(root, resolve(root, dirname(file), name)));
      if (name.startsWith(".") || name.startsWith("@media-marshal/"))
        throw new Error(`${file}: 无法解析 ${name}`);
      return undefined;
    }
    const target = normalized(relative(root, result.resolvedFileName));
    return target.startsWith("../") || target.includes("node_modules/") ? undefined : target;
  };
}

export async function structure(file, source) {
  const formatted = await prettier.format(source, {
    parser: file.endsWith("x")
      ? "typescript"
      : extname(file).includes("ts")
        ? "typescript"
        : "babel",
    printWidth: 100,
  });
  const ast = parse(file, formatted),
    issues = [];
  const lines = (start, end) =>
    formatted
      .slice(start, end)
      .split("\n")
      .filter((line) => line.trim() && !/^\s*(\/\/|\/\*|\*|\*\/)/.test(line)).length;
  const add = (rule, symbol, value, maximum) => {
    if (value > maximum) issues.push({ file, rule, symbol, value, maximum });
  };
  let executable = false;
  function visit(node) {
    if (ts.isFunctionLike(node) && node.body) {
      executable = true;
      const position = ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const symbol =
        node.name?.getText(ast) ??
        (ts.isVariableDeclaration(node.parent)
          ? node.parent.name.getText(ast)
          : `匿名函数@${position}`);
      add("function-lines", symbol, lines(node.getStart(), node.end), limits.function);
    }
    if (ts.isClassDeclaration(node)) {
      executable = true;
      add(
        "class-methods",
        node.name?.text ?? "匿名类",
        node.members.filter(ts.isMethodDeclaration).length,
        limits.methods,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (executable) add("file-lines", "文件", lines(0, formatted.length), limits.file);
  return issues;
}

export async function readSource(root, file) {
  return readFile(resolve(root, file), "utf8");
}
