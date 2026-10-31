import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, dependencies, structure, createResolver } from "./source.mjs";
import { edgeReason } from "./policy.mjs";
import { cycles, applyExceptions, keyOf, scan } from "./check.mjs";
import { declaredTables } from "./catalog.mjs";

const from = "packages/media-core/src/modules/sync/service.ts";
const to = "packages/media-core/src/modules/library/public.ts";
test("依赖矩阵接受公开入口，拒绝深层、反向、共享反向与数据库越界", () => {
  assert.equal(edgeReason(from, to), undefined);
  assert.match(edgeReason(from, to.replace("public", "private")), /公开入口/);
  assert.match(edgeReason(to, from), /方向/);
  assert.match(
    edgeReason(
      "apps/desktop/src/renderer/src/shared/a.ts",
      "apps/desktop/src/renderer/src/features/sync/public.ts",
    ),
    /反向/,
  );
  assert.match(edgeReason(from, "packages/media-core/src/storage/database.ts", true), /数据库/);
  assert.equal(
    edgeReason(
      from.replace("service", "persistence/store"),
      "packages/media-core/src/storage/database.ts",
    ),
    undefined,
  );
  assert.match(
    edgeReason("apps/desktop/src/main/index.ts", "tools/desktop-agent/control.ts"),
    /开发控制/,
  );
});

test("模块解析覆盖别名、相对路径和转发后的真实目标，未解析的内部入口失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-architecture-"));
  async function put(file, text) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
  }
  try {
    await put(
      "apps/desktop/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          moduleResolution: "bundler",
          module: "esnext",
          baseUrl: ".",
          paths: { "@private/*": ["../../packages/contracts/src/internal/*"] },
        },
      }),
    );
    await put("packages/contracts/src/internal/private.ts", "export const privateValue = 1;");
    await put(
      "packages/contracts/src/public.ts",
      'export { privateValue } from "@private/private";',
    );
    const resolve = createResolver(root);
    assert.equal(
      resolve("packages/contracts/src/public.ts", "@private/private"),
      "packages/contracts/src/internal/private.ts",
    );
    assert.equal(
      resolve("packages/contracts/src/public.ts", "./internal/private.js"),
      "packages/contracts/src/internal/private.ts",
    );
    assert.throws(() => resolve("packages/contracts/src/public.ts", "./missing.js"), /无法解析/);
    const result = await scan(root, "boundaries");
    assert(
      result.some((v) => v.rule === "module-boundary" && v.symbol.includes("internal/private")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("导入分析覆盖类型、转发、require 与字面量或动态 import", () => {
  const ast = parse(
    "a.ts",
    'import { type A } from "a"; export type { B } from "b"; export * from "c"; const d = require("d"); import("e"); import(variable);',
  );
  const values = dependencies(ast);
  assert.deepEqual(
    values.filter((v) => !v.dynamic).map((v) => [v.name, v.typeOnly]),
    [
      ["a", true],
      ["b", true],
      ["c", false],
      ["d", false],
      ["e", false],
    ],
  );
  assert.equal(values.filter((v) => v.dynamic).length, 1);
});

test("循环检查不把合法有向图误报为环，完整报告强连通组", () => {
  assert.deepEqual(
    cycles([
      ["a", "b"],
      ["b", "c"],
    ]),
    [],
  );
  assert.deepEqual(
    cycles([
      ["a", "b"],
      ["b", "a"],
      ["b", "c"],
    ]),
    [["a", "b"]],
  );
});

test("单行压缩不能绕过函数预算，纯声明数据不按可执行文件计算", async () => {
  const result = await structure(
    "sample.ts",
    `export function oversized() {${Array.from({ length: 130 }, (_, n) => `work(${n});`).join("")} }`,
  );
  assert(result.some((v) => v.rule === "function-lines"));
  const classes = await structure(
    "sample.ts",
    `class Large {${Array.from({ length: 21 }, (_, n) => `m${n}(){return ${n};}`).join("")}}`,
  );
  assert(classes.some((v) => v.rule === "class-methods"));
  assert.deepEqual(
    await structure(
      "data.ts",
      `export type Data = {${Array.from({ length: 700 }, (_, n) => `p${n}: string;`).join("")}};`,
    ),
    [],
  );
});

const now = Date.UTC(2026, 10, 1);
const violation = {
  file: "a.ts",
  rule: "function-lines",
  symbol: "work",
  value: 120,
  maximum: 100,
};
const exception = {
  ...violation,
  reason: "按任务拆分状态所有权",
  owner: "维护者",
  task: "6.1",
  expires: "2026-11-20",
};
test("精确例外只能缩减，新增、扩大、延期、陈旧、到期、改名均失败", () => {
  assert.deepEqual(applyExceptions([violation], [exception], [exception], now), []);
  assert(applyExceptions([violation], [{ ...exception, value: 130 }], [exception], now).length);
  assert(
    applyExceptions([violation], [{ ...exception, expires: "2026-11-21" }], [exception], now)
      .length,
  );
  assert(applyExceptions([violation], [exception], [], now).length);
  assert(applyExceptions([], [exception], [exception], now).length);
  assert(applyExceptions([violation], [{ ...exception, file: "*.ts" }], [exception], now).length);
  assert(applyExceptions([violation], [exception], [exception], Date.UTC(2026, 11, 1)).length);
  assert(
    applyExceptions([{ ...violation, file: "renamed.ts" }], [exception], [exception], now).length,
  );
  assert.notEqual(keyOf(violation), keyOf({ ...violation, symbol: "another" }));
});

test("表登记只识别 DDL 字符串，不将注释中的示例当成真实表", () => {
  assert.deepEqual(
    declaredTables(
      "a.ts",
      "// CREATE TABLE comment_table (x);\nexport const ddl = `CREATE TABLE IF NOT EXISTS real_table (id TEXT);`;",
    ),
    ["real_table"],
  );
});

// 验证真实 CLI 的结果，避免只测试规则函数却漏掉退出码与基点处理。
test("检查 CLI 的成功、缺失基点与错误基点具有不同退出状态", () => {
  const root = resolve(import.meta.dirname, "../..");
  const script = resolve(root, "scripts/architecture/check.mjs");
  const env = { ...process.env };
  delete env.CI;
  delete env.ARCHITECTURE_BASE_REF;
  const pass = spawnSync(process.execPath, [script, "boundaries"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).mode, "boundaries");
  const missing = spawnSync(process.execPath, [script, "boundaries"], {
    cwd: root,
    env: { ...env, CI: "true" },
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /基点/);
  const invalid = spawnSync(process.execPath, [script, "boundaries"], {
    cwd: root,
    env: { ...env, ARCHITECTURE_BASE_REF: "does-not-exist-ref" },
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
});
