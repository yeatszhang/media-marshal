import { spawnSync } from "node:child_process";
import electron from "electron";
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
