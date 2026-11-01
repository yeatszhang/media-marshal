import { readdir, open, constants, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentDirectory, agentFile } from "./paths.ts";
import { readEvidence } from "./evidence-store.ts";
import { runWriters, writerAlive, type EvidenceWriter } from "./evidence-owner.ts";
import { evidencePinned, deleteRecorded } from "./retention-run.ts";
import { RETENTION_MS } from "./storage-meter.ts";
import { exportHash } from "./export-artifact.ts";
export const exportRegistry = z.strictObject({
  format: z.literal(1),
  runId: z.uuid(),
  sessionId: z.uuid(),
  name: z.string().regex(/^[a-f0-9-]{36}-[a-f0-9-]{36}\.zip$/),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(80 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
});
export async function reclaimExports(
  root: string,
  policy: {
    dryRun: boolean;
    now: number;
    used: number;
    maximum: number;
    alive?: (writer: EvidenceWriter) => boolean;
  },
) {
  const directory = await agentDirectory(root, "exports");
  const candidates: { record: z.output<typeof exportRegistry>; metadata: Buffer; path: string }[] =
    [];
  const protectedFiles: { name: string; reason: string }[] = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".zip.json")) {
      if (!name.endsWith(".zip")) protectedFiles.push({ name, reason: "UNREGISTERED_EXPORT" });
      continue;
    }
    try {
      const path = await agentFile(root, join(directory, name));
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let metadata: Buffer;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 4096)
          throw new Error("登记文件所有权变化");
        metadata = await file.readFile();
      } finally {
        await file.close();
      }
      const record = exportRegistry.parse(JSON.parse(metadata.toString("utf8")));
      if (name !== record.name + ".json" || !record.name.startsWith(record.runId + "-"))
        throw new Error("导出身份不匹配");
      candidates.push({ record, metadata, path });
    } catch {
      protectedFiles.push({ name, reason: "EXPORT_REGISTRY_UNKNOWN" });
    }
  }
  candidates.sort((a, b) => Date.parse(a.record.createdAt) - Date.parse(b.record.createdAt));
  let bytes = 0;
  const removed: string[] = [];
  for (const { record, metadata, path } of candidates) {
    if (
      policy.now - Date.parse(record.createdAt) < RETENTION_MS &&
      policy.used - bytes <= policy.maximum
    )
      continue;
    try {
      const run = await readEvidence(root, record.runId);
      if (
        run.sessionId !== record.sessionId ||
        evidencePinned(run) ||
        !["closed", "failed", "crashed", "blocked", "unknown"].includes(run.lifecycle)
      )
        throw new Error("受保护运行");
      if ((await runWriters(root, run.runId)).some(policy.alive ?? writerAlive))
        throw new Error("活跃写入者");
      bytes += await deleteRecorded(
        root,
        join(directory, record.name),
        record.sha256,
        policy.dryRun,
        80 * 1024 * 1024,
      );
      bytes += await deleteRecorded(root, path, exportHash(metadata), policy.dryRun, 4096);
      removed.push(record.name);
    } catch {
      protectedFiles.push({ name: record.name, reason: "PINNED_ACTIVE_OR_CHANGED" });
    }
  }
  return { bytes, removed, protectedFiles };
}
