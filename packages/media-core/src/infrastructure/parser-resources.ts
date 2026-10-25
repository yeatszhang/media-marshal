import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath, readdir, access, open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { parserLaunchSchema, type ParserLaunch } from "@media-marshal/contracts/internal";
import { DesktopError } from "@media-marshal/contracts";

/** 可执行文件和动态依赖均以 ASAR 内清单核验，不从 PATH 查找解释器。 */
export async function verifyParserResources(input: ParserLaunch): Promise<string> {
  const invalid = () => new DesktopError("COMPONENT_UNAVAILABLE", "离线名称解析器资源不完整或与当前平台不兼容", true);
  try {
    const { root, manifest } = parserLaunchSchema.parse(input); if (!isAbsolute(root) || manifest.target !== `${process.platform}-${process.arch}`) throw invalid();
    const canonical = await realpath(root), observed = new Set<string>(); let total = 0;
    const walk = async (relative: string) => {
      for (const entry of await readdir(join(canonical, relative), { withFileTypes: true })) {
        const path = relative ? relative + "/" + entry.name : entry.name, file = join(canonical, path);
        if (entry.isDirectory()) { if (path.split("/").length > 64 || !Object.keys(manifest.files).some((file) => file.startsWith(path + "/"))) throw invalid(); await walk(path); continue; }
        if (observed.size >= 4096) throw invalid(); const expected = manifest.files[path]; if (!expected) throw invalid(); observed.add(path);
        const info = await lstat(file);
        if ("link" in expected) {
          if (!info.isSymbolicLink() || await readlink(file) !== expected.link || !(await realpath(file)).startsWith(canonical + sep)) throw invalid();
        } else {
          if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.size || (total += info.size) > 512 * 1024 * 1024) throw invalid();
          const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); if (hash.digest("hex") !== expected.sha256) throw invalid();
        }
      }
    };
    await walk(""); if (observed.size !== Object.keys(manifest.files).length || !observed.has(manifest.entryPoint) || "link" in manifest.files[manifest.entryPoint]!) throw invalid();
    const executable = join(canonical, manifest.entryPoint); await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    const handle = await open(executable, "r");
    try {
      const header = Buffer.alloc(64); if ((await handle.read(header, 0, 64, 0)).bytesRead !== 64) throw invalid();
      if (process.platform === "darwin") { if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== (process.arch === "arm64" ? 0x100000c : 0x1000007)) throw invalid(); }
      else { const offset = header.readUInt32LE(0x3c), pe = Buffer.alloc(6); if (header.toString("ascii", 0, 2) !== "MZ" || offset > 1024 * 1024 || (await handle.read(pe, 0, 6, offset)).bytesRead !== 6 || pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664) throw invalid(); }
    } finally { await handle.close(); }
    return executable;
  } catch { throw invalid(); }
}
