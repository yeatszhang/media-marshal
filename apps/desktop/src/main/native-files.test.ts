import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeFilesLaunch } from "./native-files";
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(packaged = false) {
  const root = await mkdtemp(join(tmpdir(), "marshal-native-launch-")); directories.push(root);
  const app = join(root, "中文 app.asar"), resources = join(root, "资源目录"), directory = join(app, "resources/native-files", ...(packaged ? [] : ["darwin-arm64"])); await mkdir(directory, { recursive: true });
  const data = JSON.stringify({ format: 1, target: "darwin-arm64", napi: 8, sdk: "fixture", electronHeaders: "44.9.0", source: { path: "tools/desktop-files/rename-exclusive.c", sha256: "a".repeat(64) }, headers: {}, binary: { name: "rename-exclusive.node", size: 100, sha256: "b".repeat(64) }, compiler: "fixture clang", releaseStatus: "unsigned-preview" }), path = join(directory, "manifest.json"); await writeFile(path, data);
  return { root, app, resources, directory, data, path };
}
describe("Main 的原生资源私有定位", () => {
  it("开发态只从当前架构固定目录读清单，路径不来自 Renderer", async () => {
    const f = await fixture(), result = await nativeFilesLaunch(f.app, f.resources, false, "darwin-arm64"); expect(result).toEqual({ manifestPath: f.path, manifestSha256: createHash("sha256").update(f.data).digest("hex") }); expect(await nativeFilesLaunch(f.app, f.resources, false, "darwin-x64")).toBeUndefined(); expect(await nativeFilesLaunch(f.app, f.resources, false, "win32-x64")).toBeUndefined();
  });
  it("打包态摘要来自 ASAR 内清单，Core 加载位置固定在外部资源目录", async () => {
    const f = await fixture(true), result = await nativeFilesLaunch(f.app, f.resources, true, "darwin-arm64"); expect(result).toEqual({ manifestPath: join(f.resources, "native-files/manifest.json"), manifestSha256: createHash("sha256").update(f.data).digest("hex") });
    await mkdir(join(f.resources, "native-files"), { recursive: true }); await writeFile(join(f.resources, "native-files/manifest.json"), "外部不可信清单"); expect(await nativeFilesLaunch(f.app, f.resources, true, "darwin-arm64")).toEqual(result);
  });
  it("未知字段、超限、架构不符和符号链接不能成为受信清单", async () => {
    const f = await fixture(); for (const data of [JSON.stringify({ ...JSON.parse(f.data), binaryPath: "/不可信模块.node" }), JSON.stringify({ ...JSON.parse(f.data), target: "darwin-x64" }), "x".repeat(65537)]) { await writeFile(f.path, data); expect(await nativeFilesLaunch(f.app, f.resources, false, "darwin-arm64")).toBeUndefined(); }
    await rm(f.path); const other = join(f.root, "other.json"); await writeFile(other, f.data); await symlink(other, f.path); expect(await nativeFilesLaunch(f.app, f.resources, false, "darwin-arm64")).toBeUndefined();
  });
});
