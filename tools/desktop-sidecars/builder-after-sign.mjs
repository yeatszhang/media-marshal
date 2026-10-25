import { Arch } from "builder-util";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
// 签名改变 Go 二进制后必须先完善受信最终摘要流程，不能产出会被运行时拒绝的安装包。
export default async function verifyBundle(context) {
  const resources = context.electronPlatformName === "darwin" ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app/Contents/Resources`) : join(context.appOutDir, "resources");
  const manifest = JSON.parse(await readFile(join(resources, "sidecars/distribution.json"), "utf8"));
  if (manifest.target !== `${context.electronPlatformName}-${Arch[context.arch]}` || manifest.releaseStatus !== "unsigned-preview") throw new Error("组件清单平台或发行状态无效");
  for (const binary of Object.values(manifest.binaries)) {
    const hash = createHash("sha256").update(await readFile(join(resources, binary.path))).digest("hex");
    if (hash !== binary.packagedSha256 || binary.developerIdSignedSha256 !== null) throw new Error("签名改变了组件摘要；须先完成正式签名清单流程");
  }
  if (context.electronPlatformName === "darwin") {
    const directory = join(resources, "native-files"), files = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")), distribution = JSON.parse(await readFile(join(directory, "distribution.json"), "utf8")), binary = await readFile(join(directory, "rename-exclusive.node"));
    const digest = createHash("sha256").update(binary).digest("hex");
    if (files.target !== manifest.target || files.releaseStatus !== "unsigned-preview" || distribution.releaseStatus !== "unsigned-preview" || distribution.target !== files.target || distribution.originalSha256 !== digest || distribution.packagedSha256 !== digest || distribution.developerIdSignedSha256 !== null || files.binary.name !== "rename-exclusive.node" || files.binary.sha256 !== digest || files.binary.size !== binary.length) throw new Error("安全修正组件的签名或最终摘要不符；须完善受信签名清单后才能发行");
  }
}
