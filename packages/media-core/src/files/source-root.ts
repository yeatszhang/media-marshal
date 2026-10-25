import { constants, type BigIntStats } from "node:fs";
import { access, lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DesktopError } from "@media-marshal/contracts";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import { ManagedRoot, isManagedPrivatePath } from "./index.js";

const numeric = z.string().regex(/^-?\d+$/).max(40);
export const sourceSnapshotSchema = z.strictObject({ device: numeric, inode: numeric, birthtimeNs: numeric, modifiedNs: numeric, changedNs: numeric, size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
// dev 是一次挂载分配的编号；原卷由目录授权另行核验，不能把换设备号当成新媒体版本。
export const sourceVersion = (value: SourceSnapshot) => { const { device: _device, ...identity } = sourceSnapshotSchema.parse(value); return createHash("sha256").update(JSON.stringify(identity)).digest("hex"); };
export const sameSnapshot = (a: SourceSnapshot, b: SourceSnapshot) => sourceVersion(a) === sourceVersion(b);
const unavailable = () => new DesktopError("LOCAL_UNAVAILABLE", "来源文件或原卷不可用，请重新核验目录", true);
const changed = () => new DesktopError("CONFLICT", "来源文件已变化，请重新观察并预览");

/** 只读来源不建立标记或探针。整个生命周期持有原目录句柄，重新挂载必须经宿主再次核验。 */
export class SourceRoot {
  private constructor(readonly grant: ManagedRootGrant, private readonly root: ManagedRoot) {}
  static async open(grant: ManagedRootGrant) { return new SourceRoot(grant, await ManagedRoot.open(grant)); }
  check() { return this.root.check(); }
  private snapshot(info: BigIntStats): SourceSnapshot {
    if (!info.isFile() || String(info.dev) !== this.grant.volume.observedDevice) throw unavailable();
    return sourceSnapshotSchema.parse({ device: String(info.dev), inode: String(info.ino), birthtimeNs: String(info.birthtimeNs), modifiedNs: String(info.mtimeNs), changedNs: String(info.ctimeNs), size: Number(info.size) });
  }
  async path(segments: readonly string[]) {
    this.root.segments(segments); await this.check(); let path = this.grant.path;
    for (const [index, part] of segments.entries()) {
      path = join(path, part); const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink() || String(info.dev) !== this.grant.volume.observedDevice || (index < segments.length - 1 && !info.isDirectory()) || await realpath(path) !== path) throw unavailable();
    }
    await this.check(); return path;
  }
  async inspect(segments: readonly string[]): Promise<SourceSnapshot> { const path = await this.path(segments); await access(path, constants.R_OK); return this.snapshot(await lstat(path, { bigint: true })); }
  async read(segments: readonly string[], expected: SourceSnapshot, consume: (handle: FileHandle, path: string) => Promise<void>) {
    const path = await this.path(segments), handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameSnapshot(this.snapshot(await handle.stat({ bigint: true })), expected)) throw changed();
      await consume(handle, path);
      if (!sameSnapshot(this.snapshot(await handle.stat({ bigint: true })), expected) || !sameSnapshot(await this.inspect(segments), expected)) throw changed();
    } finally { await handle.close(); }
  }
  async digest(handle: FileHandle, expectedSize: number, signal: AbortSignal, consume?: (buffer: Buffer) => Promise<void>) {
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
    for (;;) {
      if (signal.aborted) throw new DesktopError("INTERRUPTED", "操作已中断，请查询任务状态", true);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break;
      position += bytesRead; if (position > expectedSize) throw changed();
      const bytes = buffer.subarray(0, bytesRead); hash.update(bytes); await consume?.(bytes);
    }
    if (position !== expectedSize) throw changed(); return hash.digest("hex");
  }
  async discover(prefix: readonly string[] = [], limit = 10000, ignored: (parts: readonly string[]) => boolean = () => false): Promise<string[][]> {
    await this.check(); const files: string[][] = [], directories = [[...prefix]]; let count = 0;
    while (directories.length) {
      const parts = directories.shift()!; if (parts.length >= 64) throw new DesktopError("CONFLICT", "来源目录层级过深，请缩小扫描范围");
      const path = parts.length ? await this.path(parts) : this.grant.path;
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        if (++count > limit) throw new DesktopError("CONFLICT", "本次扫描超过一万项，请选择更小的来源目录");
        const relative = [...parts, entry.name];
        if (entry.isSymbolicLink() || isManagedPrivatePath(relative) || ignored(relative)) continue;
        if (entry.isDirectory()) directories.push(relative); else if (entry.isFile()) files.push(relative);
      }
    }
    await this.check(); return files;
  }
  async filesIn(parts: readonly string[]) {
    await this.check(); const path = parts.length ? await this.path(parts) : this.grant.path, entries = await readdir(path, { withFileTypes: true });
    if (entries.length > 10000) throw new DesktopError("CONFLICT", "目录超过一万项，请缩小来源范围");
    return entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && !isManagedPrivatePath([entry.name])).map((entry) => [...parts, entry.name]);
  }
  close() { return this.root.close(); }
}
