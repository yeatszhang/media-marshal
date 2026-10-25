import { createReadStream } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { CloudError } from "@media-marshal/contracts";
import lock from "../../../../tools/desktop-sidecars/sidecars.lock.json";

export type SidecarTarget = "darwin-arm64" | "darwin-x64" | "win32-x64";
export type BinaryName = "openlist" | "rclone" | "guardian";
export interface BinaryDefinition { path: string; sha256: string; size: number }
export type BinaryDefinitions = Readonly<Record<BinaryName, BinaryDefinition>>;
export function sidecarTarget(platform: string, arch: string): SidecarTarget {
  const target = `${platform}-${arch}`;
  if (!(["darwin-arm64", "darwin-x64", "win32-x64"] as string[]).includes(target)) throw new CloudError("UNSUPPORTED_CAPABILITY");
  return target as SidecarTarget;
}
export function lockedDefinitions(target: SidecarTarget, guardian: BinaryDefinition): BinaryDefinitions {
  const values = Object.fromEntries((["openlist", "rclone"] as const).map((name) => {
    const asset = lock.components[name].assets[target].binary;
    return [name, { path: `bin/${asset.name}`, sha256: asset.sha256, size: asset.size }];
  }));
  return { ...values, guardian } as BinaryDefinitions;
}
function contained(root: string, file: string): boolean {
  const rest = relative(root, file);
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}
async function verifyHeader(path: string, target: SidecarTarget): Promise<void> {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4096);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (target.startsWith("darwin")) {
      const cpu = target === "darwin-arm64" ? 0x0100000c : 0x01000007;
      if (bytesRead < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu) throw new Error();
    } else {
      if (bytesRead < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error();
      const offset = bytes.readUInt32LE(0x3c);
      if (offset > bytesRead - 6 || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error();
    }
  } finally { await file.close(); }
}
export class SidecarBinaryResolver {
  constructor(private readonly resourceRoot: string, private readonly target: SidecarTarget, private readonly definitions: BinaryDefinitions) {}
  async resolve(): Promise<Readonly<Record<BinaryName, string>>> {
    try {
      if (!isAbsolute(this.resourceRoot)) throw new Error();
      if (this.target !== sidecarTarget(process.platform, process.arch)) throw new Error();
      const root = await realpath(this.resourceRoot);
      const result = {} as Record<BinaryName, string>;
      for (const name of ["guardian", "openlist", "rclone"] as const) {
        const expected = this.definitions[name];
        const filename = name + (this.target.startsWith("win32") ? ".exe" : "");
        if (expected.path !== `bin/${filename}` || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.size) || expected.size <= 0 || expected.size > 512 * 1024 * 1024) throw new Error();
        const path = join(root, "bin", filename);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.size || (process.platform !== "win32" && !(info.mode & 0o111)) || !contained(root, await realpath(path))) throw new Error();
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(path)) digest.update(chunk);
        if (digest.digest("hex") !== expected.sha256) throw new Error();
        await verifyHeader(path, this.target);
        result[name] = path;
      }
      return Object.freeze(result);
    } catch (error) {
      if (error instanceof CloudError) throw error;
      // 路径、原始文件错误和资源内容不进入普通响应。
      throw new CloudError("COMPONENT_UNAVAILABLE");
    }
  }
}
