import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { DesktopError, embyTargetBindingSchema, type VersionEvidence } from "@media-marshal/contracts";
import { managedRootGrantSchema, type ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import { SourceRoot, sameSnapshot, type SourceSnapshot } from "../files/source-root.js";
import { embyServerPath, serverContains, serverStyle } from "../ingestion/emby-paths.js";
import { conflictingMediaIdentity, libraryMediaIdentity, sameMediaIdentity, type LibraryMediaIdentity } from "./library-media-identity.js";

export interface LibraryFileEvidence {
  targetId: string; binding: string; connectionId: string; connectionVersion: number;
  grant: ManagedRootGrant; segments: string[]; snapshot: SourceSnapshot; sha256: string | null;
  comparison: "CONTENT" | "NAME_SIZE" | "MEDIA_SIZE" | "USER_CONFIRMED"; checkedAt?: string;
  algorithm?: "sha256" | "sha1" | "md5"; digest?: string; identity?: LibraryMediaIdentity;
}
type Candidate = Omit<LibraryFileEvidence, "sha256" | "comparison">;
export interface LibraryReview { candidates: { id: string; file: LibraryFileEvidence }[]; totalCandidates: number }
export class LibraryReviewRequired extends DesktopError {
  constructor(message: string, readonly review: LibraryReview) { super("CONFLICT", message); }
}
export const publicLibraryReview = (review: LibraryReview) => ({ totalCandidates: review.totalCandidates, candidates: review.candidates.map(({ id, file }) => ({ id, path: libraryFilePath(file), size: file.snapshot.size })) });
interface Target { target_root_id: string; binding_json: string; connection_id: string; version: number; grant_json: string; available: number; valid: number }
export const isLibraryVideo = (name: string) => /\.(?:mkv|mp4|avi|mov|wmv|m4v|ts|m2ts|mpg|mpeg|webm|iso)$/i.test(name);
const changed = () => new DesktopError("CONFLICT", "预览中的媒体库文件或 Emby 目录关联已变化，请重新预览同步范围");
export const libraryFileReason = (file: LibraryFileEvidence) => file.comparison === "USER_CONFIRMED" ? "已在媒体库，已由用户核对候选并确认跳过；人工确认属于弱证据，未验证远端内容指纹" : file.comparison === "CONTENT"
  ? `已在媒体库，${(file.algorithm ?? "sha256").toUpperCase()} 内容摘要一致，跳过同步`
  : `已在媒体库，${file.comparison === "MEDIA_SIZE" ? "作品、季集、格式和字节大小一致" : "完整文件名和字节大小一致"}；远端无内容摘要，弱比较无法检测同尺寸内容替换`;
export const libraryFilePath = (file: LibraryFileEvidence) => join(file.grant.path, ...file.segments);
const unavailable = (path: string, error?: unknown) => new DesktopError("LOCAL_UNAVAILABLE", `媒体库检查未完成：${path.slice(-220)}。${error instanceof DesktopError ? error.message.slice(0, 120) : "目录不可读、授权或关联失效"}；请恢复原卷并核验目录和 Emby 关联后重新检查`, true);

/** 会话内只扫描一次；候选按字节大小索引，文件名不阻断内容比较。 */
export class EmbyLibraryFiles {
  private index?: Promise<Map<number, Candidate[]>>;
  private workYears?: Map<string, number>;
  private digests = new Map<string, Promise<{ sha256: string; digest: string }>>();
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  constructor(private readonly database: CoreDatabase, signal?: AbortSignal) { this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal; }
  cancel() { this.controller.abort(); }
  private check() { if (this.signal.aborted) throw new DesktopError("INTERRUPTED", "媒体库核对已中断，请重新预览或查询原任务", true); }
  private targets() {
    return this.database.connection.prepare("SELECT l.target_root_id,l.binding_json,l.connection_id,c.version,t.grant_json,t.available,c.valid FROM emby_library l JOIN emby_connection c ON c.id=l.connection_id JOIN media_target_root t ON t.id=coalesce(json_extract(l.binding_json,'$.targetDirectory.id'),l.target_root_id) WHERE l.binding_json IS NOT NULL").all() as Target[];
  }
  private valid(target: Target, grant: ManagedRootGrant) {
    const binding = embyTargetBindingSchema.parse(JSON.parse(target.binding_json));
    if (!target.available || !target.valid || binding.connectionVersion !== target.version || binding.targetDirectory.id !== grant.id || binding.targetDirectory.path !== grant.path) throw changed();
    const conversion = binding.conversion ? { localRoot: binding.conversion.localRoot.path, serverRoot: binding.conversion.serverRoot, serverPathStyle: binding.conversion.serverPathStyle } : null;
    const path = embyServerPath(grant.path, conversion);
    if (!serverContains(binding.libraryRoot, path, conversion?.serverPathStyle ?? serverStyle(path))) throw changed();
  }
  private async scan() {
    const result = new Map<number, Candidate[]>(), seen = new Set<string>();
    for (const target of this.targets()) {
      this.check(); let root: SourceRoot | undefined, path = target.target_root_id;
      try {
        const grant = managedRootGrantSchema.parse(JSON.parse(target.grant_json)); path = grant.path; this.valid(target, grant);
        root = await SourceRoot.open(grant);
        for (const segments of await root.discover([], 10000, undefined, this.signal)) {
          this.check(); if (!isLibraryVideo(segments.at(-1)!)) continue;
          const snapshot = await root.inspect(segments); if (!snapshot.size) continue;
          const key = JSON.stringify([grant.volume.volumeId, snapshot.inode, snapshot.birthtimeNs]); if (seen.has(key)) continue; seen.add(key);
          const file = { targetId: target.target_root_id, binding: target.binding_json, connectionId: target.connection_id, connectionVersion: target.version, grant, segments, snapshot, identity: libraryMediaIdentity(segments) };
          const bucket = result.get(snapshot.size) ?? []; bucket.push(file); result.set(snapshot.size, bucket);
        }
      } catch (error) { this.check(); throw unavailable(path, error); }
      finally { await root?.close(); }
    }
    return result;
  }
  private uniqueWorkYears(index: Map<number, Candidate[]>) {
    if (this.workYears) return this.workYears;
    const works = new Map<string, { years: Set<number | undefined>; ids: Set<string>; conflict: boolean }>();
    for (const files of index.values()) for (const file of files) {
      const identity = file.identity!; if (!identity.title) continue;
      const work = works.get(identity.title) ?? { years: new Set(), ids: new Set(), conflict: false };
      work.years.add(identity.year); if (identity.tmdbId) work.ids.add(identity.tmdbId); work.conflict ||= identity.conflict; works.set(identity.title, work);
    }
    this.workYears = new Map();
    for (const [title, work] of works) { const year = [...work.years][0]; if (work.years.size === 1 && year !== undefined && work.ids.size <= 1 && !work.conflict) this.workYears.set(title, year); }
    return this.workYears;
  }
  private async openCandidate(candidate: Candidate) {
    try { this.check(); return await SourceRoot.open(candidate.grant); }
    catch (error) { this.check(); throw unavailable(join(candidate.grant.path, ...candidate.segments), error); }
  }
  private async digest(root: SourceRoot, segments: string[], snapshot: SourceSnapshot, algorithm: "sha256" | "sha1" | "md5") {
    this.check();
    const key = JSON.stringify([root.grant.volume.volumeId, snapshot, algorithm]);
    let pending = this.digests.get(key);
    if (!pending) {
      pending = (async () => {
        let sha256 = "", digest = "";
        await root.read(segments, snapshot, async (handle) => {
          const other = algorithm === "sha256" ? null : createHash(algorithm);
          sha256 = await root.digest(handle, snapshot.size, this.signal, async (bytes) => { other?.update(bytes); });
          digest = other?.digest("hex") ?? sha256;
        });
        return { sha256, digest };
      })();
      this.digests.set(key, pending);
    }
    const result = await pending; this.check();
    if (!sameSnapshot(snapshot, await root.inspect(segments))) throw changed();
    return result;
  }
  async find(name: string, size: number, source?: { root: SourceRoot; segments: string[]; snapshot: SourceSnapshot }, version?: VersionEvidence, segments: readonly string[] = source?.segments ?? [name]): Promise<LibraryFileEvidence | undefined> {
    this.check(); if (!isLibraryVideo(name) || size <= 0) return;
    const index = await (this.index ??= this.scan()), candidates = index.get(size) ?? [];
    if (!candidates.length) return;
    if (source || version?.kind === "hash") {
      const algorithm = version?.kind === "hash" ? version.algorithm : "sha256";
      const expected = source ? (await this.digest(source.root, source.segments, source.snapshot, "sha256")).sha256 : version?.kind === "hash" ? version.value : "";
      for (const candidate of candidates) {
        this.check(); const root = await this.openCandidate(candidate);
        try {
          const proof = await this.digest(root, candidate.segments, candidate.snapshot, algorithm);
          if ((source ? proof.sha256 : proof.digest) !== expected) continue;
          return { ...candidate, sha256: proof.sha256, comparison: "CONTENT", algorithm, digest: proof.digest, checkedAt: new Date().toISOString() };
        } catch (error) { this.check(); if (error instanceof DesktopError) throw error; throw unavailable(join(candidate.grant.path, ...candidate.segments), error); }
        finally { await root.close(); }
      }
      return;
    }
    const identity = libraryMediaIdentity(segments), extension = extname(name).toLowerCase();
    if (identity.title && identity.year === undefined && !identity.conflict) {
      // 年份不能从单个同大小文件猜测；只有全库同名作品年份唯一时才补全。
      identity.year = this.uniqueWorkYears(index).get(identity.title);
    }
    const eligible = candidates.filter((file) => extname(file.segments.at(-1)!).toLowerCase() === extension && !conflictingMediaIdentity(identity, libraryMediaIdentity(file.segments)));
    const named = eligible.filter((file) => file.segments.at(-1)!.normalize("NFC") === name.normalize("NFC"));
    const matching = eligible.filter((file) => sameMediaIdentity(identity, libraryMediaIdentity(file.segments)));
    const choices = matching.length ? matching : named;
    if (choices.length !== 1) {
      const review: LibraryReview = { totalCandidates: candidates.length, candidates: candidates.slice(0, 25).map((candidate) => ({ id: createHash("sha256").update(JSON.stringify([candidate.targetId, candidate.binding, candidate.segments, candidate.snapshot])).digest("hex"), file: { ...candidate, sha256: null, comparison: "MEDIA_SIZE" } })) };
      throw new LibraryReviewRequired(`疑似重复，需核对：${segments.join("/").slice(-180)}；有 ${candidates.length} 个同字节大小候选，作品、季集或格式无法唯一对应。请选择库内候选并确认跳过，或选择仍需同步。`, review);
    }
    const candidate = choices[0]!, root = await this.openCandidate(candidate);
    try { if (!sameSnapshot(candidate.snapshot, await root.inspect(candidate.segments))) throw changed(); }
    catch (error) { this.check(); if (error instanceof DesktopError) throw error; throw unavailable(join(candidate.grant.path, ...candidate.segments), error); }
    finally { await root.close(); }
    return { ...candidate, sha256: null, comparison: matching.length ? "MEDIA_SIZE" : "NAME_SIZE", identity, checkedAt: new Date().toISOString() };
  }
  async verify(file: LibraryFileEvidence) {
    this.check();
    const target = this.targets().find((target) => target.target_root_id === file.targetId && target.connection_id === file.connectionId && target.version === file.connectionVersion && target.binding_json === file.binding);
    if (!target || JSON.stringify(managedRootGrantSchema.parse(JSON.parse(target.grant_json))) !== JSON.stringify(file.grant)) throw changed();
    this.valid(target, file.grant);
    const root = await this.openCandidate(file);
    try {
      if (!sameSnapshot(file.snapshot, await root.inspect(file.segments))) throw changed();
      if (file.comparison === "CONTENT" && (await this.digest(root, file.segments, file.snapshot, file.algorithm ?? "sha256")).sha256 !== file.sha256) throw changed();
    } catch { this.check(); throw changed(); } finally { await root.close(); }
  }
}
