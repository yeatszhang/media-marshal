import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), run = promisify(execFile), hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function prepareNativeFiles(target = `${process.platform}-${process.arch}`) {
  if (!/^(darwin|win32|linux)-(arm64|x64)$/.test(target)) throw new Error("目标平台或架构无效");
  // 保留既有非 Mac 构建入口，不伪造其他平台的修正能力。
  if (!target.startsWith("darwin-")) return undefined;
  if (process.platform !== "darwin" || !["darwin-arm64", "darwin-x64"].includes(target)) throw new Error("安全修正组件只能在 macOS 为 arm64 或 x64 准备");
  const version = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8")).devDependencies.electron;
  const gyp = createRequire(import.meta.url).resolve("node-gyp/bin/node-gyp.js"), arch = target.slice("darwin-".length), output = join(root, "apps/desktop/resources/native-files", target);
  // 使用锁文件已有 node-gyp 的官方头文件校验与缓存，不在运行时下载构建资源。
  await run(process.execPath, [gyp, "install", `--target=${version}`, "--dist-url=https://www.electronjs.org/headers", `--devdir=${join(homedir(), ".electron-gyp")}`, "--ensure"], { cwd: root, timeout: 120000, maxBuffer: 256 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  await run(process.execPath, [join(root, "tools/desktop-files/build.mjs"), "--arch", arch, "--out", output], { cwd: root, timeout: 40000, maxBuffer: 256 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")), binary = await readFile(join(output, "rename-exclusive.node"));
  if (manifest.target !== target || manifest.binary.sha256 !== hash(binary) || manifest.binary.size !== binary.length) throw new Error("安全修正组件构建结果不完整");
  await mkdir(join(output, "sources"), { recursive: true }); await mkdir(join(output, "licenses"), { recursive: true });
  const source = "sources/rename-exclusive.c", license = "licenses/media-marshal.LICENSE";
  await copyFile(join(root, manifest.source.path), join(output, source)); await copyFile(join(root, "apps/desktop/resources/media-marshal.LICENSE"), join(output, license));
  const notice = "Media Marshal 安全修正文件组件（未签名内测）\n\nrename-exclusive.node 为本项目自有代码，完整 C 源码和 GPL-3.0 许可随包提供。构建使用固定 Electron 的 Node-API 8 头文件、macOS SDK 与 clang，版本、架构、头文件及源码摘要见 manifest.json。运行时不下载或编译组件。当前尚未完成 Developer ID 签名与公证，不作为正式发行产物。\n";
  await writeFile(join(output, "SOURCE-NOTICE.txt"), notice);
  const materials = Object.fromEntries(await Promise.all([source, license, "SOURCE-NOTICE.txt"].map(async (path) => [path, hash(await readFile(join(output, path)))])));
  if (materials[source] !== manifest.source.sha256) throw new Error("安全修正组件对应源码已变化，请重新准备");
  await writeFile(join(output, "distribution.json"), JSON.stringify({ format: 1, target, releaseStatus: "unsigned-preview", originalSha256: manifest.binary.sha256, packagedSha256: manifest.binary.sha256, developerIdSignedSha256: null, materials }, null, 2) + "\n");
  manifest.releaseStatus = "unsigned-preview"; await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`安全修正组件、对应源码和许可已核验：${target}（未签名内测）`); return output;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.length > 3) throw new Error("只接受一个目标架构参数");
  const argument = process.argv[2], target = argument && ["arm64", "x64"].includes(argument) ? `darwin-${argument}` : argument;
  await prepareNativeFiles(target);
}
