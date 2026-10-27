import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath, statfs, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CloudError } from "@media-marshal/contracts";
import { managedRootGrantSchema, type ManagedRootGrant } from "@media-marshal/contracts/internal";

const run = promisify(execFile);
// Darwin PATH_MAX 的保守字节预算；只读来源不依赖卷对 pathconf 的实现（exFAT 可返回 EINVAL）。
const DARWIN_PATH_MAX_BYTES = 1024;
const command = async (file: string, args: string[]) => (await run(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true, shell: false })).stdout;
const plistValue = (xml: string, key: string) => xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];

/** 平台策略入口；其他系统必须提供经过独立验收的卷身份和命名探测。 */
export async function probeManagedVolume(selectedPath: string, id: string = randomUUID()): Promise<ManagedRootGrant> {
  return probeVolume(selectedPath, id, true);
}
export async function probeReadOnlyVolume(selectedPath: string, id: string = randomUUID()): Promise<ManagedRootGrant> {
  return probeVolume(selectedPath, id, false);
}
async function probeVolume(selectedPath: string, id: string, writable: boolean): Promise<ManagedRootGrant> {
  if (process.platform !== "darwin") throw new CloudError("UNSUPPORTED_CAPABILITY", undefined, { reason: "UNSUPPORTED_FILESYSTEM" });
  try {
    const path = await realpath(selectedPath), initial = await lstat(path, { bigint: true });
    if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error();
    const device = (await command("/bin/df", ["-P", path])).trim().split("\n").at(-1)?.trim().split(/\s+/)[0];
    if (!device || !/^\/dev\/disk\d+(?:s\d+)*$/.test(device)) throw new CloudError("UNSUPPORTED_CAPABILITY", undefined, { reason: "UNSUPPORTED_FILESYSTEM" });
    const info = await command("/usr/sbin/diskutil", ["info", "-plist", device]);
    const fsType = plistValue(info, "FilesystemType"), volumeId = plistValue(info, "VolumeUUID")?.toLowerCase();
    if (!fsType || !volumeId || (writable && !["apfs", "hfs"].includes(fsType))) throw new CloudError("UNSUPPORTED_CAPABILITY", undefined, { reason: "UNSUPPORTED_FILESYSTEM" });
    const pathMaxBytes = writable ? Number((await command("/usr/bin/getconf", ["PATH_MAX", path])).trim()) : DARWIN_PATH_MAX_BYTES;
    const nonce = `.media-marshal-probe-${randomUUID()}`, casePath = join(path, nonce + "-A"), unicodePath = join(path, nonce + "-é");
    const owned: string[] = [];
    const aliases = async (created: string, other: string) => {
      const a = await lstat(created, { bigint: true });
      try { const b = await lstat(other, { bigint: true }); return a.dev === b.dev && a.ino === b.ino; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    };
    // 只读来源采用保守的名称等价策略，不通过写文件推断客户端完成状态。
    let caseSensitive = false, unicodeEquivalent = true;
    try { if (writable) {
      await writeFile(casePath, "", { flag: "wx", mode: 0o600 }); owned.push(casePath);
      caseSensitive = !await aliases(casePath, join(path, nonce + "-a"));
      await writeFile(unicodePath, "", { flag: "wx", mode: 0o600 }); owned.push(unicodePath);
      unicodeEquivalent = await aliases(unicodePath, join(path, nonce + "-e\u0301")); }
    } finally { await Promise.all(owned.map((file) => unlink(file))); }
    const current = await lstat(path, { bigint: true }), volume = await statfs(path, { bigint: true });
    if (initial.dev !== current.dev || initial.ino !== current.ino || initial.birthtimeNs !== current.birthtimeNs || await realpath(path) !== path) throw new Error();
    return managedRootGrantSchema.parse({ id, path, volume: { volumeId, rootInode: String(current.ino), rootBirthtimeNs: String(current.birthtimeNs), observedDevice: String(current.dev), fsTypeCode: String(volume.type), fsType, caseSensitive, unicodeEquivalent, pathMaxBytes } });
  } catch (error) { if (error instanceof CloudError) throw error; throw new CloudError("LOCAL_UNAVAILABLE", undefined, { reason: ["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "") ? "PERMISSION_DENIED" : "DIRECTORY_UNAVAILABLE" }); }
}
