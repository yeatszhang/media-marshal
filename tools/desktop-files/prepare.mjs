import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
if (process.platform !== "darwin") throw new Error("独占改名原语只在 macOS 准备，不生成其他平台替身");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), version = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8")).devDependencies.electron;
const arch = process.argv[2] ?? process.arch; if (!["arm64", "x64"].includes(arch) || process.argv.length > 3) throw new Error("只接受 arm64 或 x64 目标架构");
const run = promisify(execFile), gyp = createRequire(import.meta.url).resolve("node-gyp/bin/node-gyp.js");
// 使用锁文件已有 node-gyp 的官方头文件校验与缓存，不在运行时下载构建资源。
await run(process.execPath, [gyp, "install", `--target=${version}`, "--dist-url=https://www.electronjs.org/headers", `--devdir=${join(homedir(), ".electron-gyp")}`, "--ensure"], { cwd: root, timeout: 120000, maxBuffer: 256 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
const result = await run(process.execPath, [join(root, "tools/desktop-files/build.mjs"), "--arch", arch], { cwd: root, timeout: 40000, maxBuffer: 256 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }); process.stdout.write(result.stdout);
