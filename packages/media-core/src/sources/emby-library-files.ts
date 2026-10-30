import { createHash } from "node:crypto";
import { join } from "node:path";
import { DesktopError, embyTargetBindingSchema, type VersionEvidence } from "@media-marshal/contracts";
import { managedRootGrantSchema, type ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import { SourceRoot, sameSnapshot, type SourceSnapshot } from "../files/source-root.js";
import { embyServerPath, serverContains, serverStyle } from "../ingestion/emby-paths.js";

export interface LibraryFileEvidence {
  targetId: string; binding: string; connectionId: string; connectionVersion: number;
  grant: ManagedRootGrant; segments: string[]; snapshot: SourceSnapshot; sha256: string; comparison: "CONTENT" | "NAME_SIZE";
}
interface Target { target_root_id: string; binding_json: string; connection_id: string; version: number; grant_json: string }
const video = /\.(?:mkv|mp4|avi|mov|wmv|m4v|ts|m2ts|mpg|mpeg|webm|iso)$/i;
const key = (name: string, size: number) => JSON.stringify([name.normalize("NFC"), size]);
const changed = () => new DesktopError("CONFLICT", "预览中的媒体库文件或 Emby 目录关联已变化，请重新预览同步范围");
export const libraryFileReason = (file: LibraryFileEvidence) => file.comparison === "NAME_SIZE" ? "已在媒体库，按完整文件名和大小跳过同步；远端无内容摘要，无法检测同尺寸内容替换" : "已在媒体库，内容摘要一致，跳过同步";
export const libraryFilePath = (file: LibraryFileEvidence) => join(file.grant.path, ...file.segments);

/** 只读取已授权且关联 Emby 的本机目标，不把服务端路径直接当作本机路径。 */
export class EmbyLibraryFiles {
  private index?: Promise<Map<string, Omit<LibraryFileEvidence, "sha256" | "comparison">[]>>;
  constructor(private readonly database: CoreDatabase) {}
  private targets() {
    return this.database.connection.prepare("SELECT l.target_root_id,l.binding_json,l.connection_id,c.version,t.grant_json FROM emby_library l JOIN emby_connection c ON c.id=l.connection_id AND c.valid=1 JOIN media_target_root t ON t.id=coalesce(json_extract(l.binding_json,'$.targetDirectory.id'),l.target_root_id) WHERE l.binding_json IS NOT NULL AND t.available=1").all() as Target[];
  }
  private valid(target: Target, grant: ManagedRootGrant) {
    const binding = embyTargetBindingSchema.parse(JSON.parse(target.binding_json));
    if (binding.connectionVersion !== target.version || binding.targetDirectory.id !== grant.id || binding.targetDirectory.path !== grant.path) throw changed();
    const conversion = binding.conversion ? { localRoot: binding.conversion.localRoot.path, serverRoot: binding.conversion.serverRoot, serverPathStyle: binding.conversion.serverPathStyle } : null;
    const path = embyServerPath(grant.path, conversion);
    if (!serverContains(binding.libraryRoot, path, conversion?.serverPathStyle ?? serverStyle(path))) throw changed();
  }
  private async scan() {
    const result = new Map<string, Omit<LibraryFileEvidence, "sha256" | "comparison">[]>();
    for (const target of this.targets()) {
      let root: SourceRoot | undefined;
      try {
        const grant = managedRootGrantSchema.parse(JSON.parse(target.grant_json)); this.valid(target, grant);
        root = await SourceRoot.open(grant);
        const files: Omit<LibraryFileEvidence, "sha256" | "comparison">[] = [];
        for (const segments of await root.discover()) {
          if (!video.test(segments.at(-1)!)) continue;
          const snapshot = await root.inspect(segments); if (!snapshot.size) continue;
          files.push({ targetId: target.target_root_id, binding: target.binding_json, connectionId: target.connection_id, connectionVersion: target.version, grant, segments, snapshot });
        }
        for (const file of files) { const slot = key(file.segments.at(-1)!, file.snapshot.size); result.set(slot, [...(result.get(slot) ?? []), file]); }
      } catch { /* 不完整、离线或失效的目标不能提供跳过同步的证据。 */ }
      finally { await root?.close(); }
    }
    return result;
  }
  async find(name: string, size: number, source?: { root: SourceRoot; segments: string[]; snapshot: SourceSnapshot }, version?: VersionEvidence): Promise<LibraryFileEvidence | undefined> {
    if (!video.test(name) || size <= 0) return;
    const candidates = (await (this.index ??= this.scan())).get(key(name, size)) ?? [];
    let sourceDigest: string | undefined;
    for (const candidate of candidates) {
      let root: SourceRoot | undefined;
      try {
        root = await SourceRoot.open(candidate.grant);
        let sha256 = "", remoteDigest = "";
        await root.read(candidate.segments, candidate.snapshot, async (handle) => {
          const remoteHash = version?.kind === "hash" ? createHash(version.algorithm) : null;
          sha256 = await root!.digest(handle, size, new AbortController().signal, async (bytes) => { remoteHash?.update(bytes); });
          remoteDigest = remoteHash?.digest("hex") ?? "";
        });
        if (source && !sourceDigest) await source.root.read(source.segments, source.snapshot, async (handle) => { sourceDigest = await source.root.digest(handle, size, new AbortController().signal); });
        if (sourceDigest && sourceDigest !== sha256 || version?.kind === "hash" && remoteDigest !== version.value) continue;
        return { ...candidate, sha256, comparison: source || version?.kind === "hash" ? "CONTENT" : "NAME_SIZE" };
      } catch { /* 变化或不可读的候选不命中，继续普通同步。 */ }
      finally { await root?.close(); }
    }
  }
  async verify(file: LibraryFileEvidence) {
    const target = this.targets().find((target) => target.target_root_id === file.targetId && target.connection_id === file.connectionId && target.version === file.connectionVersion && target.binding_json === file.binding);
    if (!target || JSON.stringify(managedRootGrantSchema.parse(JSON.parse(target.grant_json))) !== JSON.stringify(file.grant)) throw changed();
    this.valid(target, file.grant);
    const root = await SourceRoot.open(file.grant);
    try {
      if (!sameSnapshot(file.snapshot, await root.inspect(file.segments))) throw changed();
      await root.read(file.segments, file.snapshot, async (handle) => { if (await root.digest(handle, file.snapshot.size, new AbortController().signal) !== file.sha256) throw changed(); });
    } catch { throw changed(); } finally { await root.close(); }
  }
}
