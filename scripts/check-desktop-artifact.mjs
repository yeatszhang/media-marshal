import { listPackage, extractFile } from "@electron/asar";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";

const directory =
  process.platform === "win32"
    ? "win-unpacked/resources"
    : `${process.arch === "arm64" ? "mac-arm64" : "mac"}/Media Marshal.app/Contents/Resources`;
const archive = resolve("apps/desktop/release", directory, "app.asar");
const files = listPackage(archive);
for (const file of [
  "/resources/framework-origin.json",
  "/resources/app-framework.LICENSE",
  "/resources/media-marshal.LICENSE",
  "/out/main/worker.js",
])
  assert(files.includes(file), `产物缺少 ${file}`);
assert(
  !files.some((file) =>
    /^\/(backend|frontend|parser|jre|dev-data|dev-media)(?:\/|$)/.test(file),
  ),
  "产物包含旧工程或开发数据",
);
assert(
  !files.some((file) => file.includes("/node_modules/@media-marshal/")),
  "产物不应携带编译前的私有工作区源码",
);
const native = `/node_modules/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`;
assert(files.includes(native), "缺少目标平台的 SQLite 模块");
assert(existsSync(archive + ".unpacked" + native), "SQLite 原生模块未正确解包");
const provenance = JSON.parse(
  extractFile(archive, "resources/framework-origin.json").toString(),
);
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
assert.equal(
  provenance.integrity,
  lock.packages["node_modules/@yeatz/app-framework"].integrity,
);
for (const entry of Object.values(lock.packages)) {
  if (!entry.resolved) continue;
  assert(
    !/^file:|^\/(?:Users|tmp)\/|wenger-repo/.test(entry.resolved),
    "锁文件包含个人目录或跨仓依赖",
  );
}
console.log(
  `桌面产物检查通过：${process.platform}/${process.arch}，${files.length} 个条目，原生库、框架来源及许可完整，无旧工程运行依赖`,
);
