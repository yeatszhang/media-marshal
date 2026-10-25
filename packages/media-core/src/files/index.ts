import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, lstat, realpath, mkdir, readFile, writeFile, rm, link, statfs, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { CloudError, type VersionEvidence } from "@media-marshal/contracts";
import { managedRootGrantSchema, localFileEvidenceSchema, type ManagedRootGrant, type LocalFileEvidence } from "@media-marshal/contracts/internal";

export function sameVolumeRoot(a: ManagedRootGrant["volume"], b: ManagedRootGrant["volume"]) {
  return a.volumeId === b.volumeId && a.rootInode === b.rootInode && a.rootBirthtimeNs === b.rootBirthtimeNs && a.fsType === b.fsType;
}
export function pathsOverlap(first: string, second: string, volume: Pick<ManagedRootGrant["volume"], "unicodeEquivalent" | "caseSensitive">) {
  const normalize = (value: string) => { const canonical = volume.unicodeEquivalent ? value.normalize("NFC") : value; return volume.caseSensitive ? canonical : canonical.toLowerCase(); };
  const contains = (parent: string, child: string) => { const part = relative(normalize(parent), normalize(child)); return !part || (part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part)); };
  return contains(first, second) || contains(second, first);
}
const fingerprint = (a: LocalFileEvidence, b: LocalFileEvidence) => a.volumeId === b.volumeId && a.inode === b.inode && a.birthtimeNs === b.birthtimeNs && a.modifiedNs === b.modifiedNs && a.size === b.size && a.sha256 === b.sha256;
const noFollow = constants.O_NOFOLLOW ?? 0;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** 所有发现入口都忽略内部元数据与暂存区，completed 使用专有接入入口。 */
export function isManagedPrivatePath(segments: readonly string[]) { return segments.some((part) => part.normalize("NFC").toLowerCase() === ".media-marshal"); }
export function assertSpaceBudget(availableBytes: number, expectedBytes: number, reservedBytes = 0, mediaCopyBytes = 0) {
  if (![availableBytes, expectedBytes, reservedBytes, mediaCopyBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new CloudError("LOCAL_UNAVAILABLE");
  // staging 与 completed 用同卷硬链接共享内容；额外预留目录/日志及可选媒体 COPY。
  if (BigInt(availableBytes) < BigInt(expectedBytes) + BigInt(reservedBytes) + BigInt(mediaCopyBytes) + 16n * 1024n * 1024n) throw new CloudError("LOCAL_UNAVAILABLE");
}

/** 不包含数据库或业务调度；Core 与宿主共用目录/卷校验，只有 Core 调用校验与提交。 */
export class ManagedRoot {
  private closed = false;
  private constructor(readonly grant: ManagedRootGrant, private readonly handle: FileHandle, private readonly layout: "completed" | "direct") {}
  static async open(value: ManagedRootGrant, layout: "completed" | "direct" = "completed"): Promise<ManagedRoot> {
    const grant = managedRootGrantSchema.parse(value);
    if (!isAbsolute(grant.path) || await realpath(grant.path) !== grant.path) throw new CloudError("LOCAL_UNAVAILABLE");
    const handle = await open(grant.path, constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
    const root = new ManagedRoot(grant, handle, layout);
    try { await root.check(); return root; } catch (error) { await handle.close(); throw error; }
  }
  async check(): Promise<number> {
    if (this.closed) throw new CloudError("LOCAL_UNAVAILABLE");
    try {
      const original = await this.handle.stat({ bigint: true }), current = await lstat(this.grant.path, { bigint: true }), volume = await statfs(this.grant.path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino || String(current.ino) !== this.grant.volume.rootInode || String(current.birthtimeNs) !== this.grant.volume.rootBirthtimeNs || String(current.dev) !== this.grant.volume.observedDevice || String(volume.type) !== this.grant.volume.fsTypeCode || await realpath(this.grant.path) !== this.grant.path) throw new Error();
      const free = volume.bavail * volume.bsize; return Number(free > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : free);
    } catch { throw new CloudError("LOCAL_UNAVAILABLE"); }
  }
  segments(input: readonly string[]): string[] {
    if (!input.length || input.length > 128) throw new CloudError("INVALID_REQUEST");
    for (const part of input) {
      if (!part || /[\0/]/.test(part) || part === "." || part === ".." || isManagedPrivatePath([part]) || Buffer.byteLength(part) > 255) throw new CloudError("UNSUPPORTED_CAPABILITY");
      if (process.platform === "win32" && (/[\\:<>"|?*\x01-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new CloudError("UNSUPPORTED_CAPABILITY");
    }
    if (Buffer.byteLength(join(this.grant.path, ".media-marshal", "staging", "0".repeat(36), ...input)) >= this.grant.volume.pathMaxBytes) throw new CloudError("UNSUPPORTED_CAPABILITY");
    return [...input];
  }
  slotKey(input: readonly string[]) {
    const normalized = this.segments(input).map((part) => { const value = this.grant.volume.unicodeEquivalent ? part.normalize("NFC") : part; return this.grant.volume.caseSensitive ? value : value.toLowerCase(); });
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  }
  assertMappings(items: readonly (readonly string[])[]) {
    const keys = new Set<string>(), prefixes = new Map<string, string>();
    for (const item of items) {
      const key = this.slotKey(item);
      if (keys.has(key)) throw new CloudError("CONFLICT"); keys.add(key);
      for (let length = 1; length <= item.length; length++) {
        const prefix = item.slice(0, length), normalized = this.slotKey(prefix), exact = JSON.stringify(prefix), previous = prefixes.get(normalized);
        if (previous && previous !== exact) throw new CloudError("CONFLICT"); prefixes.set(normalized, exact);
      }
    }
    for (const item of items) for (let length = 1; length < item.length; length++) if (keys.has(this.slotKey(item.slice(0, length)))) throw new CloudError("CONFLICT");
  }
  private async directory(parts: readonly string[], create: boolean) {
    await this.check(); let path = this.grant.path;
    for (const part of parts) {
      path = join(path, part);
      if (create) await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const info = await lstat(path, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== this.grant.volume.observedDevice || await realpath(path) !== path) throw new CloudError("LOCAL_UNAVAILABLE");
    }
    await this.check(); return path;
  }
  async initialize() {
    const metadata = await this.directory([".media-marshal"], true), owner = join(metadata, "owner.json");
    const contents = JSON.stringify({ version: 1, grantId: this.grant.id, volumeId: this.grant.volume.volumeId });
    try { await writeFile(owner, contents, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new CloudError("LOCAL_UNAVAILABLE");
      const info = await lstat(owner);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 || await readFile(owner, "utf8") !== contents) throw new CloudError("CONFLICT");
    }
    await this.directory([".media-marshal", "staging"], true); await this.directory([".media-marshal", "attempts"], true); if (this.layout === "completed") await this.directory(["completed"], true);
  }
  async verifyCommitSupport() {
    const directory = await this.directory([".media-marshal"], false), source = join(directory, "probe-" + randomUUID()), target = source + ".linked";
    let created = false, linked = false;
    try {
      await writeFile(source, "", { flag: "wx", mode: 0o600 }); created = true;
      await link(source, target); linked = true;
      const a = await lstat(source, { bigint: true }), b = await lstat(target, { bigint: true });
      if (a.dev !== b.dev || a.ino !== b.ino || a.nlink !== 2n) throw new Error();
      try { await link(source, target); throw new Error(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await this.syncDirectory(directory);
    } catch { throw new CloudError("UNSUPPORTED_CAPABILITY"); }
    finally { if (linked) await rm(target); if (created) await rm(source); }
  }
  private async syncDirectory(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private attempt(id: string) { if (!uuid.test(id)) throw new CloudError("INVALID_REQUEST"); return id; }
  async prepareStage(attemptId: string): Promise<string> {
    this.attempt(attemptId); await this.initialize();
    const parent = await this.directory([".media-marshal", "staging"], false), path = join(parent, attemptId), marker = join(this.grant.path, ".media-marshal", "attempts", attemptId + ".json");
    await writeFile(marker, JSON.stringify({ grantId: this.grant.id, attemptId }), { flag: "wx", mode: 0o600 });
    try { await mkdir(path, { mode: 0o700 }); await this.directory([".media-marshal", "staging", attemptId], false); return path; }
    catch { throw new CloudError("CONFLICT"); }
  }
  private async marker(attemptId: string) {
    this.attempt(attemptId); await this.directory([".media-marshal", "attempts"], false);
    const file = join(this.grant.path, ".media-marshal", "attempts", attemptId + ".json"), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 || await readFile(file, "utf8") !== JSON.stringify({ grantId: this.grant.id, attemptId })) throw new CloudError("CONFLICT");
  }
  private async filePath(kind: "staging" | "completed", segments: readonly string[], attemptId?: string, create = false) {
    const names = this.segments(segments);
    if (kind === "staging") await this.marker(attemptId!);
    const prefix = kind === "staging" ? [".media-marshal", "staging", this.attempt(attemptId!)] : this.layout === "completed" ? ["completed"] : [];
    const parent = await this.directory([...prefix, ...names.slice(0, -1)], create); return join(parent, names.at(-1)!);
  }
  private evidence(info: BigIntStats, sha256: string): LocalFileEvidence {
    if (!info.isFile() || String(info.dev) !== this.grant.volume.observedDevice || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new CloudError("LOCAL_UNAVAILABLE");
    return localFileEvidenceSchema.parse({ volumeId: this.grant.volume.volumeId, inode: String(info.ino), birthtimeNs: String(info.birthtimeNs), modifiedNs: String(info.mtimeNs), size: Number(info.size), sha256 });
  }
  private async hash(path: string, remoteHash?: Extract<VersionEvidence, { kind: "hash" }>): Promise<LocalFileEvidence> {
    await this.check(); const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const before = await handle.stat({ bigint: true }); this.evidence(before, "0".repeat(64));
      const digest = createHash("sha256"), upstream = remoteHash ? createHash(remoteHash.algorithm) : null, buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
      for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break; digest.update(buffer.subarray(0, bytesRead)); upstream?.update(buffer.subarray(0, bytesRead)); position += bytesRead; }
      const after = await handle.stat({ bigint: true });
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(position) !== after.size) throw new CloudError("CONFLICT");
      if (remoteHash && upstream!.digest("hex") !== remoteHash.value) throw new CloudError("REMOTE_CHANGED");
      const current = await lstat(path, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || current.birthtimeNs !== after.birthtimeNs || current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs || await realpath(path) !== path) throw new CloudError("CONFLICT");
      await handle.sync();
      await this.check(); return this.evidence(after, digest.digest("hex"));
    } finally { await handle.close(); }
  }
  async verifyStage(attemptId: string, segments: readonly string[], expectedSize: number, remoteHash?: Extract<VersionEvidence, { kind: "hash" }>) {
    const result = await this.hash(await this.filePath("staging", segments, attemptId), remoteHash);
    if (result.size !== expectedSize) throw new CloudError("REMOTE_CHANGED"); return result;
  }
  async inspectCompleted(segments: readonly string[]) { return this.hash(await this.filePath("completed", segments)); }
  async assertVacant(segments: readonly string[]) {
    try { await lstat(await this.filePath("completed", segments)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    throw new CloudError("CONFLICT");
  }
  completedDirectory() { return this.directory(this.layout === "completed" ? ["completed"] : [], false); }
  stageFilePath(attemptId: string, segments: readonly string[]) { return this.filePath("staging", segments, attemptId, true); }
  async commit(attemptId: string, segments: readonly string[], expected: LocalFileEvidence) {
    const target = await this.filePath("completed", segments, undefined, true);
    try {
      const metadata = await lstat(target, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink() || String(metadata.dev) !== this.grant.volume.observedDevice || String(metadata.ino) !== expected.inode || String(metadata.birthtimeNs) !== expected.birthtimeNs || String(metadata.mtimeNs) !== expected.modifiedNs || Number(metadata.size) !== expected.size) throw new CloudError("CONFLICT");
      const existing = await this.hash(target);
      if (!fingerprint(existing, expected)) throw new CloudError("CONFLICT");
      return { path: target, evidence: existing, alreadyCommitted: true };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const source = await this.filePath("staging", segments, attemptId), verified = await this.hash(source);
    if (!fingerprint(verified, expected)) throw new CloudError("CONFLICT");
    await this.filePath("completed", segments, undefined, false); await this.check();
    try { await link(source, target); }
    catch (error) { throw new CloudError((error as NodeJS.ErrnoException).code === "EEXIST" ? "CONFLICT" : "LOCAL_UNAVAILABLE"); }
    await this.syncDirectory(join(target, ".."));
    const result = await this.hash(target);
    if (!fingerprint(result, expected)) throw new CloudError("CONFLICT");
    return { path: target, evidence: result, alreadyCommitted: false };
  }
  async cleanupAttempt(attemptId: string) {
    await this.marker(attemptId);
    let directory: string | undefined;
    try { directory = await this.directory([".media-marshal", "staging", attemptId], false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await this.check(); if (directory) await rm(directory, { recursive: true, force: false });
    await rm(join(this.grant.path, ".media-marshal", "attempts", attemptId + ".json"));
  }
  async close() { if (!this.closed) { this.closed = true; await this.handle.close(); } }
}
export class ManagedRoots {
  private roots = new Map<string, ManagedRoot>();
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly layout: "completed" | "direct" = "completed") {}
  install(grant: ManagedRootGrant): Promise<ManagedRoot> {
    const task = this.pending.catch(() => {}).then(() => { if (this.closed) throw new CloudError("INTERRUPTED"); return this.replace(grant); });
    this.pending = task; return task;
  }
  private async replace(grant: ManagedRootGrant): Promise<ManagedRoot> {
    const previous = this.roots.get(grant.id);
    if (previous && !sameVolumeRoot(previous.grant.volume, grant.volume)) throw new CloudError("LOCAL_UNAVAILABLE");
    if (previous && JSON.stringify(previous.grant) === JSON.stringify(grant)) {
      try { await previous.check(); return previous; }
      catch { /* 原卷重新挂载可能复用设备号，但旧目录句柄已失效；新授权仍须完整重验。 */ }
    }
    const root = await ManagedRoot.open(grant, this.layout);
    try { await root.initialize(); await root.verifyCommitSupport(); } catch (error) { await root.close(); throw error; }
    await previous?.close(); this.roots.set(grant.id, root); return root;
  }
  get(id: string): ManagedRoot { const root = this.roots.get(id); if (!root) throw new CloudError("LOCAL_UNAVAILABLE"); return root; }
  async close() { this.closed = true; await this.pending.catch(() => {}); await Promise.all([...this.roots.values()].map((root) => root.close())); this.roots.clear(); }
}
