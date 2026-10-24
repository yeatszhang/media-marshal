import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { dependencyViolation } from "./desktop-boundary-rules.mjs";

const root = resolve(import.meta.dirname, "..");
const forbidden = [];
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
      const reason = dependencyViolation(area, file, name);
      if (reason)
        forbidden.push(`${relative(root, file)}: ${name} — ${reason}`);
    }
  }
}
if (forbidden.length) {
  console.error(forbidden.join("\n"));
  process.exitCode = 1;
} else console.log("桌面契约、媒体核心、Renderer 与 Preload 依赖边界检查通过");
