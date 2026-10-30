import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = args[0] === "--foreground" || args[0] === "--background" ? args.shift() : undefined;
const mode = flag?.slice(2) ?? process.env.MARSHAL_E2E_MODE ?? "background";
if (mode !== "background" && mode !== "foreground") throw new Error("MARSHAL_E2E_MODE 仅支持 background 或 foreground");
console.log(`桌面 E2E：${mode === "background" ? "后台模式（不显示窗口、不请求焦点）" : "前台模式（显示窗口）"}`);
const env = { ...process.env, MARSHAL_E2E_MODE: mode };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "apps/desktop/playwright.config.ts", ...args], { env, stdio: "inherit" });
process.exitCode = result.status ?? 1;
