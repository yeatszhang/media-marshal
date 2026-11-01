import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { readManifest } from "./fingerprint.ts";
import { digestFile } from "./resources.ts";
import { ToolError } from "./protocol.ts";
export async function assertPackagedCopy(root: string, manifest: string, executable: string) {
  const expectedRoot =
    process.platform === "darwin"
      ? `apps/desktop/release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/Media Marshal.app`
      : "apps/desktop/release/win-unpacked";
  const actualRoot =
    process.platform === "darwin"
      ? resolve(dirname(executable), "../..")
      : dirname(resolve(executable));
  const record = await readManifest(manifest);
  const expected = record.artifact.files;
  const entries: string[] = [];
  const walk = async (path: string) => {
    const info = await lstat(join(actualRoot, path));
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const name of (await readdir(join(actualRoot, path))).sort())
        await walk(path ? `${path}/${name}` : name);
    } else entries.push(path);
    if (entries.length > 20000) throw new Error("目标包超出文件预算");
  };
  try {
    const main =
      process.platform === "darwin" ? "Contents/MacOS/Media Marshal" : "Media Marshal.exe";
    if (record.artifact.target !== "packaged" || resolve(executable) !== resolve(actualRoot, main))
      throw new Error("不是目录包主程序");
    if ((await realpath(actualRoot)) === (await realpath(join(root, expectedRoot)))) return;
    if (resolve(actualRoot) !== (await realpath(actualRoot))) throw new Error("包根包含链接");
    await walk("");
    const prefix = expectedRoot + "/";
    const files = expected.map((item) => {
      if (!item.path.startsWith(prefix)) throw new Error("清单不是当前平台的目录包");
      return { ...item, path: item.path.slice(prefix.length) };
    });
    if (JSON.stringify(entries.sort()) !== JSON.stringify(files.map((item) => item.path).sort()))
      throw new Error("文件集合不一致");
    for (const item of files) {
      const path = join(actualRoot, item.path),
        info = await lstat(path);
      if (item.link !== undefined) {
        const physical = await realpath(path);
        if (
          !info.isSymbolicLink() ||
          (await readlink(path)) !== item.link ||
          !(physical === actualRoot || physical.startsWith(actualRoot + "/"))
        )
          throw new Error("包内链接不匹配或越界");
      } else {
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) !== item.mode)
          throw new Error("文件类型或执行权限变化");
        const digest = await digestFile(path);
        if (digest.sha256 !== item.sha256 || digest.size !== item.size) throw new Error("内容变化");
      }
    }
  } catch {
    throw new ToolError(
      "TEST_PACKAGED_TARGET_MISMATCH",
      "测试目标不是当前构建的完整目录包副本",
      "核对本轮构建和只读映像，不使用旧包冒充当前源码",
      "blocked",
    );
  }
}
