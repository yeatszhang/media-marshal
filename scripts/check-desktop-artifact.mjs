import { listPackage, extractFile } from "@electron/asar";
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";

const directory =
  process.platform === "win32"
    ? "win-unpacked/resources"
    : `${process.arch === "arm64" ? "mac-arm64" : "mac"}/Media Marshal.app/Contents/Resources`;
const resources = process.env.MARSHAL_ARTIFACT_RESOURCES ? resolve(process.env.MARSHAL_ARTIFACT_RESOURCES) : resolve("apps/desktop/release", directory);
const archive = join(resources, "app.asar");
const files = listPackage(archive);
for (const file of [
  "/resources/framework-origin.json",
  "/resources/app-framework.LICENSE",
  "/resources/media-marshal.LICENSE",
  "/out/main/worker.js",
  "/out/main/sidecar-host.js",
  "/resources/sidecars/guardian.json",
  "/resources/sidecars/manifest.json",
  "/resources/sidecars/distribution.json",
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
assert.deepEqual(files.filter((file) => file.endsWith(".node")), [native], "安装包包含非目标平台的原生模块");
assert(existsSync(archive + ".unpacked" + native), "SQLite 原生模块未正确解包");
const provenance = JSON.parse(
  extractFile(archive, "resources/framework-origin.json").toString(),
);
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const sidecars = join(resources, "sidecars"), target = `${process.platform}-${process.arch}`;
const distribution = JSON.parse(extractFile(archive, "resources/sidecars/distribution.json").toString());
assert.equal(distribution.target, target); assert.equal(distribution.releaseStatus, "unsigned-preview");
assert.deepEqual(JSON.parse(readFileSync(join(sidecars, "distribution.json"), "utf8")), distribution, "包内外组件清单不一致");
const extension = process.platform === "win32" ? ".exe" : "";
assert.deepEqual(readdirSync(join(resources, "bin")).sort(), ["guardian", "openlist", "rclone"].map((name) => name + extension).sort(), "组件目录只允许当前目标的三个可执行文件");
const componentLock = JSON.parse(readFileSync("tools/desktop-sidecars/sidecars.lock.json", "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const [name, binary] of Object.entries(distribution.binaries)) {
  const path = join(resources, binary.path), bytes = readFileSync(path), info = lstatSync(path);
  assert(info.isFile() && !info.isSymbolicLink()); assert.equal(bytes.length, binary.size); assert.equal(sha(bytes), binary.packagedSha256);
  assert.equal(binary.developerIdSignedSha256, null); assert.equal(binary.originalSha256, binary.packagedSha256, "当前内测不应改变原始组件摘要");
  if (name !== "guardian") assert.equal(binary.originalSha256, componentLock.components[name].assets[target].binary.sha256);
  if (process.platform === "darwin") { assert.equal(bytes.readUInt32LE(0), 0xfeedfacf); assert.equal(bytes.readUInt32LE(4), process.arch === "arm64" ? 0x100000c : 0x1000007); }
}
const preparedManifest = JSON.parse(extractFile(archive, "resources/sidecars/manifest.json").toString());
for (const component of Object.values(preparedManifest.components)) {
  assert(component.source.localArchive?.startsWith("sources/")); assert.equal(sha(readFileSync(join(sidecars, component.source.localArchive))), component.source.sha256);
}
for (const [file, checksum] of Object.entries(distribution.materials)) { assert(!file.includes("..") && !file.startsWith("/")); assert.equal(sha(readFileSync(join(sidecars, file))), checksum, `许可/源码材料摘要不符：${file}`); }
assert(!files.some((file) => /sidecars\/(?:darwin-|win32-)|credentials(?:\.enc)?\.json|\.sqlite3?(?:$|-)|rclone\.conf|config\.json|app-update\.yml/.test(file)), "ASAR 混入其他平台或用户配置/更新入口");
assert(!existsSync(join(resources, "app-update.yml")));
const walk = (root) => readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(root, entry.name)) : [join(root, entry.name)]);
assert(walk(sidecars).every((file) => !/\.exe$|\.dll$|\.sqlite3?$|credentials|rclone\.conf/.test(file)), "Mac 组件材料混入其他平台二进制或个人配置");
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
