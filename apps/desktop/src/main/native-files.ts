import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeFileLaunchSchema, nativeFileManifestSchema, type NativeFileLaunch } from "@media-marshal/contracts/internal";

/** Main 只读取固定位置的受信清单；Core 才加载模块，Renderer 不能指定资源位置。 */
export async function nativeFilesLaunch(appPath: string, resourcesPath: string, packaged: boolean, target = `${process.platform}-${process.arch}`): Promise<NativeFileLaunch | undefined> {
  if (target !== "darwin-arm64" && target !== "darwin-x64") return undefined;
  const trusted = packaged ? join(appPath, "resources/native-files") : join(appPath, "resources/native-files", target);
  try {
    const path = join(trusted, "manifest.json"), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) return undefined;
    const data = await readFile(path), manifest = nativeFileManifestSchema.parse(JSON.parse(data.toString("utf8")));
    if (manifest.target !== target || manifest.releaseStatus !== "unsigned-preview") return undefined;
    return nativeFileLaunchSchema.parse({ manifestPath: packaged ? join(resourcesPath, "native-files/manifest.json") : path, manifestSha256: createHash("sha256").update(data).digest("hex") });
  } catch { return undefined; }
}
