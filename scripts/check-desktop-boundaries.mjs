import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const forbidden = [];
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (
      /\.tsx?$/.test(path) &&
      !path.endsWith(".test.ts") &&
      !path.endsWith(".test.tsx")
    )
      files.push(path);
  }
  return files;
}
for (const area of [
  "packages/contracts/src",
  "packages/media-core/src",
  "apps/desktop/src/renderer",
  "apps/desktop/src/preload",
]) {
  for (const file of await walk(join(root, area))) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = ts
      .preProcessFile(source.text, true, true)
      .importedFiles.map((item) => item.fileName);
    for (const name of imports) {
      let reason;
      if (
        area === "packages/contracts/src" &&
        (builtins.has(name) ||
          /electron|app-framework|media-core|react/.test(name))
      )
        reason = "契约必须独立于宿主、框架和 UI";
      if (
        area === "packages/media-core/src" &&
        /^(electron|react(?:-dom)?(?:\/|$))|app-framework\/react/.test(name)
      )
        reason = "媒体核心不能依赖 Electron/React";
      if (
        area.includes("renderer") &&
        (builtins.has(name) ||
          /electron|media-core|better-sqlite3/.test(name) ||
          /\.\.\/.*(?:main|worker|infrastructure)/.test(name))
      )
        reason = "Renderer 不能导入原生能力或媒体核心";
      if (
        area.includes("preload") &&
        /app-framework|media-core|better-sqlite3|react/.test(name)
      )
        reason = "Preload 只保留受限桥接";
      if (/app-framework\/(?:src|dist|legacy)/.test(name))
        reason = "框架只使用公开的非 legacy 入口";
      if (reason)
        forbidden.push(`${relative(root, file)}: ${name} — ${reason}`);
    }
  }
}
if (forbidden.length) {
  console.error(forbidden.join("\n"));
  process.exitCode = 1;
} else console.log("桌面契约、媒体核心、Renderer 与 Preload 依赖边界检查通过");
