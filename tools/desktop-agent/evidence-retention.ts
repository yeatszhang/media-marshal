import { readdir } from "node:fs/promises";
import { agentBase, agentFile, agentRunHome } from "./paths.ts";
import { readEvidence, lockEvidenceWriter, updateEvidence } from "./evidence-store.ts";
import { evidenceUsage, EVIDENCE_BUDGET, RETENTION_MS } from "./storage-meter.ts";
import { evidencePinned, reclaimRun } from "./retention-run.ts";
import { reclaimExports } from "./retention-exports.ts";
import type { EvidenceWriter } from "./evidence-owner.ts";
import { invalidateStorage } from "./storage-reservation.ts";
export interface RetentionPolicy {
  now?: () => number;
  maxBytes?: number;
  alive?: (writer: EvidenceWriter) => boolean;
}
export async function pinEvidence(root: string, runId: string, pinned: boolean) {
  return updateEvidence(root, runId, (value) => {
    value.retention = { pinned, reason: "manual", updatedAt: new Date().toISOString() };
  });
}
export async function gcEvidence(root: string, dryRun = false, policy: RetentionPolicy = {}) {
  const base = await agentBase(root),
    unlock = await lockEvidenceWriter(base, ".storage.lock");
  try {
    const usage = await evidenceUsage(root),
      maximum = policy.maxBytes ?? EVIDENCE_BUDGET,
      now = (policy.now ?? Date.now)();
    const candidates: { runId: string; createdAt: number; pinned: boolean }[] = [],
      protectedRuns: object[] = [];
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      try {
        await agentFile(root, agentRunHome(root, entry.name));
        const value = await readEvidence(root, entry.name);
        candidates.push({
          runId: entry.name,
          createdAt: Date.parse(value.createdAt),
          pinned: evidencePinned(value),
        });
      } catch {
        protectedRuns.push({ runId: entry.name, reason: "UNKNOWN_OWNERSHIP" });
      }
    }
    candidates.sort((a, b) => a.createdAt - b.createdAt);
    let used = usage.bytes;
    const runs: object[] = [];
    for (const candidate of candidates) {
      const expired = now - candidate.createdAt >= RETENTION_MS;
      if (!expired && used <= maximum) continue;
      try {
        const result = await reclaimRun(
          root,
          candidate.runId,
          expired ? "expired" : "budget",
          dryRun,
          now,
          policy.alive,
        );
        used -= result.bytes;
        runs.push({ runId: candidate.runId, ...result });
      } catch {
        protectedRuns.push({ runId: candidate.runId, reason: "WRITER_OR_FILE_UNKNOWN" });
      }
    }
    const exports = await reclaimExports(root, { dryRun, now, used, maximum, alive: policy.alive });
    used -= exports.bytes;
    const actual = dryRun ? usage : await evidenceUsage(root);
    const remaining = dryRun ? used : actual.bytes;
    // 持有全局锁，失效缓存后下一次预留必须重新测量。
    if (!dryRun) await invalidateStorage(root);
    return {
      status:
        remaining > maximum || actual.unknownRoots ? "blocked" : dryRun ? "planned" : "completed",
      dryRun,
      scope: usage.scope,
      beforeBytes: usage.bytes,
      projectedBytes: used,
      ...(dryRun ? {} : { actualBytes: actual.bytes }),
      budgetBytes: maximum,
      runs,
      exports,
      protectedRuns,
      runtimeDataDeleted: false,
      historyComplete: false,
    };
  } finally {
    await unlock();
  }
}
