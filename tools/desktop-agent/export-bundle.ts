import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { agentDirectory } from "./paths.ts";
import { readEvidence } from "./evidence-store.ts";
import { ownEvidence } from "./evidence-owner.ts";
import { exportArtifact, exportHash } from "./export-artifact.ts";
import { redactExport } from "./export-redaction.ts";
import { artifactKinds } from "./evidence-kinds.ts";
import { ToolError, type Input } from "./protocol.ts";
import { reserveEvidence } from "./storage-reservation.ts";
import { exportRegistry } from "./retention-exports.ts";
export async function exportBundle(root: string, runId: string, input: Input<"collect">) {
  await ownEvidence(root, runId);
  const manifest = await readEvidence(root, runId);
  const selected = new Set(input.kinds ?? artifactKinds);
  const files: Record<string, Uint8Array> = Object.create(null);
  const entries: object[] = [];
  let missing = 0,
    total = 0;
  for (const artifact of manifest.artifacts.filter((item) => selected.has(item.kind))) {
    if (artifact.status !== "available") {
      missing++;
      entries.push({
        id: artifact.id,
        kind: artifact.kind,
        source: artifact.source,
        status: artifact.status,
        reason: artifact.reason,
      });
      continue;
    }
    try {
      const safe = await exportArtifact(root, runId, artifact);
      total += safe.bytes.length;
      if (total > 64 * 1024 * 1024)
        throw new ToolError(
          "EXPORT_CAPACITY_LIMIT",
          "单次导出超过 64 MiB",
          "通过 kinds 缩小证据选择",
          "blocked",
        );
      const name = "files/" + artifact.name!;
      files[name] = safe.bytes;
      entries.push({
        id: artifact.id,
        kind: artifact.kind,
        source: artifact.source,
        status: safe.truncated ? "partial" : "available",
        snapshotId: artifact.snapshotId,
        windowId: artifact.windowId,
        requestId: artifact.requestId,
        name,
        bytes: safe.bytes.length,
        sha256: exportHash(safe.bytes),
        sourceSha256: artifact.sha256,
        redactions: safe.redactions,
      });
      if (safe.truncated) missing++;
    } catch (error) {
      missing++;
      entries.push({
        id: artifact.id,
        kind: artifact.kind,
        source: artifact.source,
        status: "blocked",
        reason: error instanceof ToolError ? error.code : "EXPORT_ARTIFACT_UNAVAILABLE",
      });
    }
  }
  const index = {
    format: 1,
    runId,
    sessionId: manifest.sessionId,
    buildId: manifest.buildId,
    selectedKinds: [...selected],
    sourceAssertions: manifest.assertions,
    sourceLifecycle: manifest.lifecycle,
    sourceFailures: manifest.failures,
    historyComplete: false,
    rawUserDataIncluded: false,
    complete: missing === 0,
    artifacts: entries,
  };
  files["manifest.json"] = strToU8(JSON.stringify(redactExport(root, index).value, null, 2));
  const bytes = zipSync(files, { level: 1 });
  const stored = await persistBundle(root, runId, manifest.sessionId, bytes);
  return {
    status: missing ? "partial" : "completed",
    runId,
    ...stored,
    complete: missing === 0,
    omittedOrPartial: missing,
    pinned: manifest.retention?.pinned ?? Boolean(manifest.primaryFailureId),
    historyComplete: false,
  };
}
async function persistBundle(root: string, runId: string, sessionId: string, bytes: Uint8Array) {
  const name = `${runId}-${randomUUID()}.zip`;
  const registry = exportRegistry.parse({
    format: 1,
    runId,
    sessionId: sessionId,
    name,
    bytes: bytes.length,
    sha256: exportHash(bytes),
    createdAt: new Date().toISOString(),
  });
  const metadata = JSON.stringify(registry);
  const release = await reserveEvidence(root, runId, bytes.length + Buffer.byteLength(metadata));
  let written = 0;
  try {
    const path = join(await agentDirectory(root, "exports"), name);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    written = bytes.length;
    await writeFile(path + ".json", metadata, { flag: "wx", mode: 0o600 });
    written += Buffer.byteLength(metadata);
    return { path, bytes: bytes.length, sha256: exportHash(bytes) };
  } finally {
    await release(written);
  }
}
