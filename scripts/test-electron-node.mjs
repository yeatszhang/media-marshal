import { spawnSync } from "node:child_process";
import electron from "electron";
// 崩溃测试的自有子进程读取编译产物；先统一构建，避免并行测试覆盖同一 dist。
for (const project of ["packages/contracts/tsconfig.json", "packages/media-core/tsconfig.json"]) {
  const prepared = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", project], { cwd: new URL("..", import.meta.url), stdio: "inherit" });
  if (prepared.status !== 0) process.exit(prepared.status ?? 1);
}
// 原生模块重建给 Electron 后，使用同一 Node ABI 执行核心测试。
const result = spawnSync(
  electron,
  ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)],
  {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  },
);
process.exitCode = result.status ?? 1;
