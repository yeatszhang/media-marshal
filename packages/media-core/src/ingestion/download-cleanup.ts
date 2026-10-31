import { join } from "node:path";
import { DesktopError } from "@media-marshal/contracts";
import { ManagedRoot, sameVolumeRoot } from "../files/index.js";
import type { NativeRenameApi } from "../files/native-rename.js";
import { localFileEvidenceSchema } from "@media-marshal/contracts/internal";
import {
  DownloadCleanupEvidence,
  sameCleanupEvidence,
  openCleanupRoot,
} from "./download-cleanup-evidence.js";
import { DownloadCleanupDemands } from "./download-cleanup-demands.js";
import { downloadCleanupPlanSchema, type CleanupRow } from "./download-cleanup-journal.js";

/** 只消费显式登记的持久计划；构造、查询、重启不会把历史成功成果自动加入清理。 */
export class DownloadCleanup {
  private readonly flights = new Map<string, Promise<CleanupRow>>();
  private readonly controller = new AbortController();
  readonly journal;
  readonly demands;
  constructor(
    readonly evidence: DownloadCleanupEvidence,
    private readonly native?: NativeRenameApi,
    private readonly cleanupOwnedCaches: (row: CleanupRow) => Promise<void> = async () => {},
  ) {
    this.journal = evidence.journal;
    this.demands = new DownloadCleanupDemands(this.journal);
  }
  run(id: string) {
    const previous = this.flights.get(id);
    if (previous) return previous;
    const work = this.execute(id).finally(() => this.flights.delete(id));
    this.flights.set(id, work);
    return work;
  }
  private async execute(id: string) {
    const signal = this.controller.signal;
    let plan = downloadCleanupPlanSchema.parse(JSON.parse(this.journal.get(id).plan_json));
    let source: ManagedRoot | undefined;
    try {
      if (["DONE", "NEEDS_ATTENTION"].includes(this.journal.get(id).phase))
        return this.journal.get(id);
      if (!this.native)
        throw new DesktopError(
          "UNSUPPORTED_CAPABILITY",
          "当前平台未加载可信独占改名组件；下载原件已保留，请使用已验证的 macOS 客户端重试",
        );
      const db = this.journal.database.connection,
        approved = db
          .prepare(
            "SELECT proof_json FROM download_cleanup_binding_review WHERE cleanup_id=? AND state='APPROVED' ORDER BY id DESC LIMIT 1",
          )
          .get(id) as { proof_json: string } | undefined;
      if (approved) {
        const proof = JSON.parse(approved.proof_json);
        plan = downloadCleanupPlanSchema.parse({
          ...plan,
          binding: proof.binding,
          connectionId: proof.connectionId,
          connectionVersion: proof.connectionVersion,
          target: { ...plan.target, evidence: localFileEvidenceSchema.parse(proof.targetEvidence) },
        });
      }
      const review = db
        .prepare(
          "SELECT id FROM download_cleanup_binding_review WHERE cleanup_id=? AND state='PENDING'",
        )
        .get(id) as { id: number } | undefined;
      if (review) {
        plan = await this.evidence.reviewBinding(plan, signal);
        db.prepare(
          "UPDATE download_cleanup_binding_review SET state='APPROVED',proof_json=?,approved_at=? WHERE id=? AND state='PENDING'",
        ).run(
          JSON.stringify({
            binding: plan.binding,
            connectionId: plan.connectionId,
            connectionVersion: plan.connectionVersion,
            targetEvidence: plan.target.evidence,
          }),
          new Date().toISOString(),
          review.id,
        );
      }
      const grant = this.evidence.sourceGrant(plan.source.grant.id);
      if (
        grant.path !== plan.source.grant.path ||
        !sameVolumeRoot(grant.volume, plan.source.grant.volume)
      )
        throw new DesktopError(
          "LOCAL_UNAVAILABLE",
          "受管下载目录或原卷身份变化；请恢复原授权后重试清理",
          true,
        );
      source = await openCleanupRoot(grant);
      const quarantine = source.relocationSegments(id);
      for (;;) {
        signal.throwIfAborted();
        const row = this.journal.get(id);
        if (["DONE", "NEEDS_ATTENTION"].includes(row.phase)) return row;
        if (["PENDING", "WAITING_REFERENCES"].includes(row.phase)) {
          const retained = this.demands.reasons(row);
          if (retained.length) {
            const reason = retained.join("；").slice(0, 500);
            return row.phase === "PENDING"
              ? this.journal.advance(id, "PENDING", "WAITING_REFERENCES", reason)
              : this.journal.wait(id, reason);
          }
          // 先避开仍被使用的原件；完整读取后领取事务仍须重新检查需求，防止读取期间新增消费者。
          await source.confirmRelocation(plan.source.segments, plan.source.evidence, signal);
          await this.evidence.verifyTarget(plan, signal);
          if (this.demands.claim(id).phase === "WAITING_REFERENCES") return this.journal.get(id);
          continue;
        }
        if (row.phase === "CLAIMED") {
          await this.evidence.verifyTarget(plan, signal);
          let isolated = false;
          try {
            await source.confirmRelocation(quarantine, plan.source.evidence, signal);
            isolated = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (!isolated) {
            const current = await source.inspectForRelocation(plan.source.segments, signal);
            if (!sameCleanupEvidence(current.evidence, plan.source.evidence))
              throw new DesktopError(
                "CONFLICT",
                "受管原件已被替换；已保留现存文件，请核对清理记录",
              );
            signal.throwIfAborted();
            const result = await source.renameForRelocation(
              plan.source.segments,
              source,
              quarantine,
              current.snapshot,
              this.native,
              signal,
            );
            if (result.state !== "RENAMED")
              throw new DesktopError(
                "LOCAL_UNAVAILABLE",
                "原件独占隔离结果待核对；恢复原卷后重试，不会删除同名替代文件",
                true,
              );
          }
          await source.confirmRelocation(quarantine, plan.source.evidence, signal);
          this.journal.advance(id, "CLAIMED", "QUARANTINED");
          continue;
        }
        if (row.phase === "QUARANTINED") {
          await source.confirmRelocation(quarantine, plan.source.evidence, signal);
          await this.evidence.verifyTarget(plan, signal);
          this.journal.advance(id, "QUARANTINED", "REMOVING");
          continue;
        }
        if (row.phase === "REMOVING") {
          try {
            await source.removeRelocation(
              id,
              plan.source.evidence,
              () => this.evidence.verifyTarget(plan, signal),
              signal,
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await source.check();
            await this.evidence.verifyTarget(plan, signal);
            // 删除已发生但未记账时只补事实；原路径重新出现同一原件则不能声称已经删除。
            try {
              const original = await source.inspectForRelocation(plan.source.segments, signal);
              if (sameCleanupEvidence(original.evidence, plan.source.evidence))
                throw new DesktopError(
                  "CONFLICT",
                  "隔离证据缺失且原件仍存在；保留文件，请核对原清理作业",
                );
            } catch (probe) {
              if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe;
            }
          }
          this.journal.advance(id, "REMOVING", "SOURCE_REMOVED");
          continue;
        }
        if (row.phase === "SOURCE_REMOVED") {
          this.journal.advance(id, "SOURCE_REMOVED", "CACHE_PENDING");
          continue;
        }
        if (row.phase === "CACHE_PENDING") {
          await this.cleanupOwnedCaches(row);
          await source.cleanupEmptyCompletedParents(plan.source.segments);
          this.journal.advance(id, "CACHE_PENDING", "DONE");
          continue;
        }
        throw new DesktopError("CONFLICT", "无法恢复下载清理阶段；请查询原作业并核对文件记录");
      }
    } catch (error) {
      if (signal.aborted) return this.journal.get(id);
      const object = join(plan.source.grant.path, ...plan.source.segments).slice(-230);
      if ((error as { code?: string }).code === "LOCAL_UNAVAILABLE")
        return this.journal.wait(
          id,
          `${object}：${error instanceof DesktopError ? error.message : "原卷或目录暂不可用，保留原阶段等待授权恢复"}`,
        );
      return this.journal.fail(
        id,
        `${object}：${error instanceof DesktopError ? error.message.slice(0, 190) : "清理未完成，原件或隔离副本已保留；请恢复原卷及目录后重试原作业"}`,
      );
    } finally {
      await source?.close();
    }
  }
  async close() {
    this.controller.abort();
    await Promise.allSettled(this.flights.values());
  }
}
