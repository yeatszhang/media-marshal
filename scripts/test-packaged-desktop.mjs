import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

const buildEnv = { ...process.env };
delete buildEnv.ELECTRON_RUN_AS_NODE;
// 外部只读映像必须沿用生成它时的当前构建清单，不能先重建一个不同的参考包。
if (!process.env.MARSHAL_APP_PATH) {
  const built = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--experimental-strip-types",
      "tools/desktop-agent/test-build.ts",
      "packaged",
    ],
    { env: buildEnv, stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const relative =
  process.platform === "win32"
    ? "win-unpacked/Media Marshal.exe"
    : `${process.arch === "arm64" ? "mac-arm64" : "mac"}/Media Marshal.app/Contents/MacOS/Media Marshal`;
// 允许直接验收只读 DMG 中的应用，未指定时仍检查本地目录包。
const executable = process.env.MARSHAL_APP_PATH
  ? resolve(process.env.MARSHAL_APP_PATH)
  : resolve("apps/desktop/release", relative);
if (!existsSync(executable)) throw new Error("尚未生成当前平台的桌面目录包，请先运行 desktop:pack");
const env = {
  ...process.env,
  MARSHAL_APP_PATH: executable,
  MARSHAL_EXECUTABLE: "1",
  MARSHAL_ARTIFACT_RESOURCES:
    process.env.MARSHAL_ARTIFACT_RESOURCES ??
    (process.platform === "darwin"
      ? resolve(dirname(executable), "../Resources")
      : join(dirname(executable), "resources")),
};
delete env.ELECTRON_RUN_AS_NODE;
const checked = spawnSync(process.execPath, ["scripts/check-desktop-artifact.mjs"], {
  env,
  stdio: "inherit",
});
if (checked.status !== 0) process.exit(checked.status ?? 1);
const result = spawnSync(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "apps/desktop/playwright.config.ts",
    ...process.argv.slice(2),
  ],
  { env, stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
