import { open, constants, unlink } from "node:fs/promises";
import { join } from "node:path";
import { agentFile, agentRunHome } from "./paths.ts";
import { readEvidence, lockEvidenceWriter } from "./evidence-store.ts";
import { runWriters, writerAlive, type EvidenceWriter } from "./evidence-owner.ts";
import { evidenceChecksum, type EvidenceManifest } from "./evidence-model.ts";
import { exportHash } from "./export-artifact.ts";
import { atomicJson } from "./build.ts";
export const evidencePinned = (value: EvidenceManifest) =>
  value.retention?.pinned ??
  Boolean(
    value.primaryFailureId ||
    value.assertions === "failed" ||
    ["failed", "crashed", "unknown"].includes(value.lifecycle),
  );
export async function deleteRecorded(
  root: string,
  path: string,
  sha256: string,
  dryRun: boolean,
  maximum = 16 * 1024 * 1024,
) {
  const safe = await agentFile(root, path);
  const file = await open(safe, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: number;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum)
      throw new Error("文件所有权或大小变化");
    if (exportHash(await file.readFile()) !== sha256) throw new Error("文件摘要变化");
    bytes = info.size;
  } finally {
    await file.close();
  }
  if (!dryRun) await unlink(safe);
  return bytes;
}
export async function reclaimRun(
  root: string,
  runId: string,
  reason: "expired" | "budget",
  dryRun: boolean,
  now: number,
  alive: (writer: EvidenceWriter) => boolean = writerAlive,
) {
  const directory = await agentFile(root, agentRunHome(root, runId));
  const unlockActions = await lockEvidenceWriter(directory, ".actions.lock");
  let unlockManifest: (() => Promise<void>) | undefined;
  try {
    unlockManifest = await lockEvidenceWriter(directory);
    const value = await readEvidence(root, runId);
    if (evidencePinned(value)) return { bytes: 0, protected: "PINNED" };
    if (!["closed", "failed", "crashed", "blocked", "unknown"].includes(value.lifecycle))
      return { bytes: 0, protected: "RUN_NOT_TERMINAL" };
    if ((await runWriters(root, runId)).some(alive))
      return { bytes: 0, protected: "ACTIVE_WRITER" };
    let bytes = 0,
      removed = 0,
      protectedFiles = 0;
    const names = new Set<string>();
    for (const item of value.artifacts) {
      if (item.status !== "available" || !item.name || !item.sha256) continue;
      try {
        if (!names.has(item.name))
          bytes += await deleteRecorded(root, join(directory, item.name), item.sha256, dryRun);
        names.add(item.name);
        item.status = "missing";
        item.reason = reason === "expired" ? "EVIDENCE_EXPIRED" : "EVIDENCE_BUDGET_RECLAIMED";
        removed++;
      } catch {
        protectedFiles++;
      }
    }
    if (!dryRun && removed) {
      const time = new Date(now).toISOString();
      value.retention = {
        pinned: false,
        reason,
        updatedAt: time,
        ...(!protectedFiles ? { reclaimedAt: time } : {}),
      };
      value.updatedAt = time;
      await atomicJson(join(directory, "manifest.json"), {
        ...value,
        checksum: evidenceChecksum(value),
      });
    }
    return { bytes, removed, protectedFiles };
  } finally {
    await unlockManifest?.();
    await unlockActions();
  }
}
