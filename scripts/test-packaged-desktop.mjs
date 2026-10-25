import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const relative =
  process.platform === "win32"
    ? "win-unpacked/Media Marshal.exe"
    : `${process.arch === "arm64" ? "mac-arm64" : "mac"}/Media Marshal.app/Contents/MacOS/Media Marshal`;
// 允许直接验收只读 DMG 中的应用，未指定时仍检查本地目录包。
const executable = process.env.MARSHAL_APP_PATH ? resolve(process.env.MARSHAL_APP_PATH) : resolve("apps/desktop/release", relative);
if (!existsSync(executable))
  throw new Error("尚未生成当前平台的桌面目录包，请先运行 desktop:pack");
const env = {
  ...process.env,
  MARSHAL_APP_PATH: executable,
  MARSHAL_EXECUTABLE: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "apps/desktop/playwright.config.ts",
  ],
  { env, stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
