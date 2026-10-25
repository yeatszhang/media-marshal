import { readFile, readdir, realpath, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = new URL("..", import.meta.url);
const lock = JSON.parse(
  await readFile(new URL("package-lock.json", root), "utf8"),
);
const expected = JSON.parse(
  await readFile(
    new URL("apps/desktop/resources/framework-origin.json", root),
    "utf8",
  ),
);
const entry = lock.packages["node_modules/@yeatz/app-framework"];
assert.equal(entry.version, expected.version);
assert.equal(entry.integrity, expected.integrity);
assert.equal(entry.resolved, expected.resolved);
assert.equal(entry.link, undefined, "框架不能使用跨仓符号链接");
const installed = fileURLToPath(new URL("node_modules/@yeatz/app-framework", root));
assert.equal(await realpath(installed), installed, "框架目录必须来自当前项目安装");
const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
assert.equal(manifest.version, expected.version); assert.equal(manifest.license, "MIT");
const packageRequire = createRequire(join(installed, "package.json"));
for (const dependency of Object.keys(manifest.dependencies ?? {})) assert.ok(packageRequire.resolve(dependency), "框架依赖缺失");
for (const value of Object.values(lock.packages)) {
  if (value.resolved) assert(!/^file:|^(?:\/(?:Users|home|tmp)\/|[A-Za-z]:[\\/])/.test(value.resolved), "锁文件包含个人路径");
  if (value.link) assert(/^(?:apps|packages)\/[^/]+$/.test(value.resolved), "锁文件包含跨仓链接");
}
const paths = ["application", "ioc", "command", "registry", "lifecycle"];
for (const path of paths) {
  assert.ok(Object.keys(require(`@yeatz/app-framework/${path}`)).length > 0);
  assert.ok(
    Object.keys(await import(`@yeatz/app-framework/${path}`)).length > 0,
  );
}
assert.equal(
  typeof require("@yeatz/app-framework/application").createApplication,
  "function",
);
assert.equal(lock.packages["node_modules/react"].version, lock.packages["node_modules/react-dom"].version, "React 与 React DOM 必须锁定同版本");
assert.equal(
  typeof require("@yeatz/app-framework/ioc").StatefulService,
  "function",
);
assert.equal(
  typeof (await import("@yeatz/app-framework/react")).useServiceState,
  "function",
);
assert.match(
  await readFile(
    new URL("apps/desktop/resources/app-framework.LICENSE", root),
    "utf8",
  ),
  /MIT License/,
);
for (const workspace of ["apps/desktop", "packages/media-core"]) {
  const manifest = JSON.parse(
    await readFile(new URL(`${workspace}/package.json`, root), "utf8"),
  );
  assert.equal(manifest.dependencies["@yeatz/app-framework"], expected.version);
}
if (process.argv.includes("--verify-contents")) {
  const directory = await mkdtemp(join(tmpdir(), "marshal-framework-check-"));
  try {
    assert(process.env.npm_execpath, "请通过 npm run check:framework -- --verify-contents 运行");
    assert.equal(new URL(expected.resolved).origin, "https://registry.npmjs.org");
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "marshal-framework-verification", private: true }));
    // 隔离安装仅用于验证固定发布包，禁止执行包脚本，不修改项目依赖。
    await promisify(execFile)(process.execPath, [process.env.npm_execpath, "install", "--workspaces=false", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", `${expected.package}@${expected.version}`], { cwd: directory, timeout: 60000, maxBuffer: 1024 * 1024 }).catch(() => { throw new Error("无法取得固定框架发布包，请检查 npm 网络后重试"); });
    const verifiedLock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
    assert.equal(verifiedLock.packages["node_modules/@yeatz/app-framework"]?.integrity, expected.integrity, "固定框架发布包摘要不匹配");
    async function files(directory, prefix = "") {
      const result = [];
      for (const value of await readdir(join(directory, prefix), { withFileTypes: true })) {
        assert(!value.isSymbolicLink(), "框架包中不接受符号链接");
        const path = join(prefix, value.name);
        if (value.isDirectory()) result.push(...await files(directory, path)); else { assert(value.isFile()); result.push(path); }
      }
      return result.sort();
    }
    const verified = join(directory, "node_modules/@yeatz/app-framework"), packagedFiles = await files(verified);
    assert.deepEqual(await files(installed), packagedFiles, "已安装框架的文件清单与固定发布包不一致");
    for (const file of packagedFiles) assert((await readFile(join(installed, file))).equals(await readFile(join(verified, file))), `框架文件与固定发布包不一致：${file}`);
    console.log(`框架固定发布包 ${packagedFiles.length} 个文件逐字节核对通过`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log(
  "框架固定版本、来源、integrity、ESM/CJS/React 公开入口与许可检查通过",
);
