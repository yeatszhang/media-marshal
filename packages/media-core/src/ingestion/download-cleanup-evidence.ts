import { DesktopError, embyTargetBindingSchema } from "@media-marshal/contracts";
import {
  managedRootGrantSchema,
  localFileEvidenceSchema,
  type ManagedRootGrant,
} from "@media-marshal/contracts/internal";
import { ManagedRoot, sameVolumeRoot } from "../files/index.js";
import { SourceRoot } from "../files/source-root.js";
import { CoreDatabase } from "../infrastructure/database.js";
import { EmbyLibraryFiles } from "../sources/emby-library-files.js";
import { embyServerPath, serverContains, serverStyle } from "./emby-paths.js";
import { DownloadCleanupJournal, type DownloadCleanupPlan } from "./download-cleanup-journal.js";

const changed = () =>
  new DesktopError(
    "CONFLICT",
    "原件、媒体库内容或 Emby 绑定已变化；保留下载副本，请恢复原目录并重新预览清理范围",
  );
export const sameCleanupEvidence = (
  a: DownloadCleanupPlan["source"]["evidence"],
  b: DownloadCleanupPlan["source"]["evidence"],
) =>
  a.volumeId === b.volumeId &&
  a.inode === b.inode &&
  a.birthtimeNs === b.birthtimeNs &&
  a.modifiedNs === b.modifiedNs &&
  a.size === b.size &&
  a.sha256 === b.sha256;
export async function openCleanupRoot(grant: ManagedRootGrant) {
  try {
    return await ManagedRoot.open(grant);
  } catch {
    throw new DesktopError(
      "LOCAL_UNAVAILABLE",
      `原目录 ${grant.path.slice(-180)} 尚不可用；保留原阶段，等待原卷及目录授权恢复`,
      true,
    );
  }
}

/** 每次领取和删除均重新打开原卷并完整读取；不使用会话摘要缓存或弱去重凭据。 */
export class DownloadCleanupEvidence {
  constructor(
    private readonly database: CoreDatabase,
    readonly journal = new DownloadCleanupJournal(database),
  ) {}
  sourceGrant(id: string): ManagedRootGrant {
    const row = this.database.connection
      .prepare(
        "SELECT canonical_path,volume_identity FROM managed_download_root WHERE id=? AND state='AVAILABLE'",
      )
      .get(id) as { canonical_path: string; volume_identity: string } | undefined;
    if (!row)
      throw new DesktopError(
        "LOCAL_UNAVAILABLE",
        "受管下载原目录未授权或离线；恢复原卷后重试清理",
        true,
      );
    return managedRootGrantSchema.parse({
      id,
      path: row.canonical_path,
      volume: JSON.parse(row.volume_identity),
    });
  }
  private binding(targetId: string) {
    const row = this.database.connection
      .prepare(
        "SELECT l.binding_json,l.connection_id,c.version,c.valid,t.available,t.grant_json FROM emby_library l JOIN emby_connection c ON c.id=l.connection_id JOIN media_target_root t ON t.id=coalesce(json_extract(l.binding_json,'$.targetDirectory.id'),l.target_root_id) WHERE (l.target_root_id=? OR l.target_root_id=(SELECT directory_id FROM recognition_target_identity WHERE id=?)) ORDER BY (l.target_root_id=?) DESC,c.verified_at DESC LIMIT 1",
      )
      .get(targetId, targetId, targetId) as
      | {
          binding_json: string;
          connection_id: string;
          version: number;
          valid: number;
          available: number;
          grant_json: string;
        }
      | undefined;
    if (!row || !row.valid) throw changed();
    if (!row.available)
      throw new DesktopError(
        "LOCAL_UNAVAILABLE",
        "媒体目标原卷尚未恢复授权；保留下载副本，等待目录恢复",
        true,
      );
    const grant = managedRootGrantSchema.parse(JSON.parse(row.grant_json)),
      binding = embyTargetBindingSchema.parse(JSON.parse(row.binding_json));
    if (
      binding.connectionVersion !== row.version ||
      binding.targetDirectory.id !== grant.id ||
      binding.targetDirectory.path !== grant.path
    )
      throw changed();
    const conversion = binding.conversion
      ? {
          localRoot: binding.conversion.localRoot.path,
          serverRoot: binding.conversion.serverRoot,
          serverPathStyle: binding.conversion.serverPathStyle,
        }
      : null;
    const path = embyServerPath(grant.path, conversion);
    if (
      !serverContains(binding.libraryRoot, path, conversion?.serverPathStyle ?? serverStyle(path))
    )
      throw changed();
    return {
      grant,
      binding: row.binding_json,
      targetId,
      connectionId: row.connection_id,
      connectionVersion: row.version,
    };
  }
  async prepare(
    receiptId: string,
    taskId: string | null,
    authorization: DownloadCleanupPlan["authorization"],
    target?: { id: string; segments: string[] },
    signal?: AbortSignal,
  ): Promise<DownloadCleanupPlan> {
    const row = this.database.connection
      .prepare(
        "SELECT r.*,e.evidence_json FROM sync_receipt r JOIN sync_receipt_evidence e ON e.receipt_id=r.id WHERE r.id=?",
      )
      .get(receiptId) as
      | { target_directory_id: string; target_segments_json: string; evidence_json: string }
      | undefined;
    if (!row) throw changed();
    const grant = this.sourceGrant(row.target_directory_id),
      segments = ["completed", ...JSON.parse(row.target_segments_json)],
      source = await openCleanupRoot(grant);
    let readSource: SourceRoot | undefined, destination: ManagedRoot | undefined;
    const library = new EmbyLibraryFiles(this.database, signal);
    try {
      const original = localFileEvidenceSchema.parse(JSON.parse(row.evidence_json)),
        current = await source.inspectForRelocation(segments, signal);
      if (!sameCleanupEvidence(current.evidence, original)) throw changed();
      if (!target) {
        readSource = await SourceRoot.open(grant);
        const file = await library.find(segments.at(-1)!, current.evidence.size, {
          root: readSource,
          segments,
          snapshot: await readSource.inspect(segments),
        });
        if (!file || file.comparison !== "CONTENT" || file.sha256 !== current.evidence.sha256)
          throw changed();
        target = { id: file.targetId, segments: file.segments };
      }
      const binding = this.binding(target.id);
      destination = await openCleanupRoot(binding.grant);
      const result = await destination.inspectForRelocation(target.segments, signal);
      if (
        result.evidence.sha256 !== current.evidence.sha256 ||
        result.evidence.size !== current.evidence.size
      )
        throw changed();
      const plan: DownloadCleanupPlan = {
        source: { grant, segments, evidence: current.evidence },
        target: { grant: binding.grant, segments: target.segments, evidence: result.evidence },
        binding: binding.binding,
        targetId: binding.targetId,
        connectionId: binding.connectionId,
        connectionVersion: binding.connectionVersion,
        authorization,
      };
      await this.verifyTarget(plan, signal);
      await source.confirmRelocation(segments, current.evidence, signal);
      return plan;
    } finally {
      library.cancel();
      await destination?.close();
      await readSource?.close();
      await source.close();
    }
  }
  async verifyTarget(plan: DownloadCleanupPlan, signal?: AbortSignal) {
    const current = this.binding(plan.targetId);
    if (
      current.binding !== plan.binding ||
      current.connectionId !== plan.connectionId ||
      current.connectionVersion !== plan.connectionVersion ||
      current.grant.path !== plan.target.grant.path ||
      !sameVolumeRoot(current.grant.volume, plan.target.grant.volume)
    )
      throw changed();
    const root = await openCleanupRoot(current.grant);
    try {
      await root.confirmRelocation(plan.target.segments, plan.target.evidence, signal);
    } finally {
      await root.close();
    }
    // 完整读取期间配置也可能更新，读取结束后再次核对绑定版本。
    if (this.binding(plan.targetId).binding !== plan.binding) throw changed();
  }
  assertAuthorization(plan: DownloadCleanupPlan) {
    const source = this.sourceGrant(plan.source.grant.id),
      target = this.binding(plan.targetId);
    if (
      source.path !== plan.source.grant.path ||
      !sameVolumeRoot(source.volume, plan.source.grant.volume) ||
      target.binding !== plan.binding ||
      target.connectionId !== plan.connectionId ||
      target.connectionVersion !== plan.connectionVersion ||
      target.grant.path !== plan.target.grant.path ||
      !sameVolumeRoot(target.grant.volume, plan.target.grant.volume)
    )
      throw changed();
  }
  /** 显式重试可以重新核对同一物理副本的当前绑定，不能借重试更换文件或目录。 */
  async reviewBinding(plan: DownloadCleanupPlan, signal?: AbortSignal) {
    const current = this.binding(plan.targetId);
    if (
      current.grant.path !== plan.target.grant.path ||
      !sameVolumeRoot(current.grant.volume, plan.target.grant.volume)
    )
      throw changed();
    const root = await openCleanupRoot(current.grant);
    let evidence;
    try {
      evidence = (await root.inspectForRelocation(plan.target.segments, signal)).evidence;
    } finally {
      await root.close();
    }
    const expected = plan.target.evidence;
    if (
      evidence.volumeId !== expected.volumeId ||
      evidence.inode !== expected.inode ||
      evidence.birthtimeNs !== expected.birthtimeNs ||
      evidence.size !== expected.size ||
      evidence.sha256 !== expected.sha256
    )
      throw changed();
    const reviewed = {
      ...plan,
      target: { ...plan.target, evidence },
      binding: current.binding,
      connectionId: current.connectionId,
      connectionVersion: current.connectionVersion,
    };
    await this.verifyTarget(reviewed, signal);
    this.assertAuthorization(reviewed);
    return reviewed;
  }
  async verifySource(plan: DownloadCleanupPlan, signal?: AbortSignal) {
    const grant = this.sourceGrant(plan.source.grant.id);
    if (
      grant.path !== plan.source.grant.path ||
      !sameVolumeRoot(grant.volume, plan.source.grant.volume)
    )
      throw changed();
    const root = await openCleanupRoot(grant);
    try {
      await root.confirmRelocation(plan.source.segments, plan.source.evidence, signal);
    } finally {
      await root.close();
    }
  }
}
