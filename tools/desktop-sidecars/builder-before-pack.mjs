import { Arch } from "builder-util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareParser } from "../desktop-parser/prepare.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), run = promisify(execFile), sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export default async function prepareBundle(context) {
  const target = `${context.electronPlatformName}-${Arch[context.arch]}`;
  if (!["darwin-arm64", "darwin-x64", "win32-x64"].includes(target)) throw new Error("此架构尚未配置随包组件");
  await prepareParser(target);
  await run("python3", [join(root, "tools/desktop-sidecars/prepare.py"), "--target", target, "--include-sources"], { cwd: root, timeout: 180000, maxBuffer: 1024 * 1024, shell: false });
  await run("python3", [join(root, "tools/desktop-sidecars/prepare_guardian.py"), "--target", target], { cwd: root, timeout: 120000, maxBuffer: 1024 * 1024, shell: false });
  const prepared = join(root, "apps/desktop/resources/sidecars", target), manifest = JSON.parse(await readFile(join(prepared, "manifest.json"), "utf8")), guardian = JSON.parse(await readFile(join(prepared, "guardian.json"), "utf8"));
  await mkdir(join(prepared, "sources"), { recursive: true });
  await copyFile(join(root, "apps/desktop/resources/media-marshal.LICENSE"), join(prepared, "licenses/guardian.LICENSE"));
  const guardianSource = join(root, "tools/desktop-sidecars/guardian"), sourceFiles = (await readdir(guardianSource)).filter((file) => /\.go$|^go\.(?:mod|sum)$/.test(file)).sort();
  await run("/usr/bin/tar", ["-czf", join(prepared, "sources/guardian-source.tar.gz"), "-C", guardianSource, ...sourceFiles], { timeout: 30000, shell: false });
  const binaries = {};
  for (const [name, binary] of [...Object.entries(manifest.components).map(([name, value]) => [name, value.binary]), ["guardian", guardian.binary]]) {
    const bytes = await readFile(join(prepared, binary.path));
    if (sha(bytes) !== binary.sha256 || bytes.length !== binary.size) throw new Error("随包组件完整性失败");
    binaries[name] = { path: binary.path, size: bytes.length, originalSha256: binary.sha256, packagedSha256: sha(bytes), developerIdSignedSha256: null };
  }
  const materials = {};
  for (const component of Object.values(manifest.components)) for (const file of [component.license.path, component.source.localArchive]) materials[file] = sha(await readFile(join(prepared, file)));
  for (const file of ["licenses/guardian.LICENSE", "sources/guardian-source.tar.gz"]) materials[file] = sha(await readFile(join(prepared, file)));
  const notice = "Media Marshal 内测组件包\n\n此构建尚未通过 Developer ID 签名与公证，不作为正式公开发行。\nOpenList 与 Rclone 使用锁定 release 的原始二进制，未修改其源码；对应源码归档和许可随包提供，精确 commit/来源/摘要见 manifest.json。\nGuardian 为本项目自有代码，完整 Go 源码与 GPL-3.0 许可随包提供。构建使用 Go 1.26.0，CGO_ENABLED=0、-trimpath、-buildvcs=false；平台与架构见 distribution.json。\n组件随应用整包升级，运行时不执行组件自更新。\n";
  await writeFile(join(prepared, "SOURCE-NOTICE.txt"), notice);
  materials["SOURCE-NOTICE.txt"] = sha(Buffer.from(notice));
  const distribution = { schemaVersion: 1, target, releaseStatus: "unsigned-preview", binaries, materials, guardian: { goVersion: guardian.goVersion, buildFlags: ["-trimpath", "-buildvcs=false"], sourceFiles: Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, sha(await readFile(join(guardianSource, file)))]))) } };
  await writeFile(join(prepared, "distribution.json"), JSON.stringify(distribution, null, 2) + "\n");
  console.log(`随包组件及对应源码已核验：${target}（未签名内测）`);
}
