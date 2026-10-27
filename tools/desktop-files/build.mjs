import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { readFile, mkdir, realpath, writeFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) { const flag = args[i]; if (!["--arch", "--headers", "--out"].includes(flag) || !args[i + 1] || flag in options) throw new Error("参数仅允许 --arch、--headers、--out，且不可重复"); options[flag] = args[i + 1]; }
if (process.platform !== "darwin") throw new Error("此构建只支持 macOS，不生成其他平台的假兼容产物");
const arch = options["--arch"] ?? process.arch; if (!["arm64", "x64"].includes(arch)) throw new Error("目标架构必须为 arm64 或 x64");
const electron = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8")).devDependencies.electron;
const headers = await realpath(options["--headers"] ?? join(homedir(), ".electron-gyp", electron, "include/node")).catch(() => { throw new Error("缺少固定 Electron 的 Node-API 头文件，请先运行 npm run desktop:prepare-native-files；也可用 --headers 指定已校验 SDK"); });
const output = resolve(options["--out"] ?? join(root, "build-artifacts/desktop-files", `darwin-${arch}`)), source = join(root, "tools/desktop-files/rename-exclusive.c");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"), headerNames = ["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h"];
const sourceHash = hash(await readFile(source));
const headerHashes = Object.fromEntries(await Promise.all(headerNames.map(async (name) => [name, hash(await readFile(join(headers, name)))])));
const run = promisify(execFile), compiler = (await run("/usr/bin/xcrun", ["--find", "clang"], { timeout: 10000 })).stdout.trim(); await mkdir(output, { recursive: true });
const sdk = (await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], { timeout: 10000 })).stdout.trim();
const binary = join(output, "rename-exclusive.node"), temporary = binary + "." + randomUUID();
try {
  await run(compiler, ["-isysroot", sdk, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fvisibility=hidden", "-mmacosx-version-min=11.0", "-arch", arch === "x64" ? "x86_64" : arch, "-bundle", "-undefined", "dynamic_lookup", "-I", headers, source, "-o", temporary], { timeout: 30000, maxBuffer: 65536 });
  const bytes = await readFile(temporary), cpu = arch === "arm64" ? 0x100000c : 0x1000007;
  if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu) throw new Error("原生产物的 Mach-O 架构不符");
  if (hash(await readFile(source)) !== sourceHash || (await Promise.all(headerNames.map(async (name) => hash(await readFile(join(headers, name))) === headerHashes[name]))).some((value) => !value)) throw new Error("构建期间源码或头文件变化，请重新构建");
  await rename(temporary, binary);
  const manifest = { format: 1, target: `darwin-${arch}`, napi: 8, sdk: (await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"], { timeout: 10000 })).stdout.trim(), electronHeaders: electron, source: { path: "tools/desktop-files/rename-exclusive.c", sha256: sourceHash }, headers: headerHashes, binary: { name: "rename-exclusive.node", size: bytes.length, sha256: hash(bytes) }, compiler: (await run(compiler, ["--version"], { timeout: 10000 })).stdout.split("\n")[0], releaseStatus: "unintegrated-development" };
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n"); console.log(JSON.stringify({ target: manifest.target, napi: manifest.napi, size: bytes.length, sha256: manifest.binary.sha256 }));
} finally { await rm(temporary, { force: true }); }
