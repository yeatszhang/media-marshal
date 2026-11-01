import { randomUUID } from "node:crypto";
import { join, basename, resolve } from "node:path";
import { agentFile, agentRunHome } from "./paths.ts";
import { atomicJson } from "./build.ts";
import { initializeEvidence, updateEvidence } from "./evidence-store.ts";
import { recordArtifact, recordFailure, type ArtifactInput } from "./evidence-artifacts.ts";
import { ToolError } from "./protocol.ts";
import type { RunIdentity, EvidenceManifest, Failure } from "./evidence-model.ts";

export async function collectionFailure(root: string, run: RunIdentity, error: unknown) {
  const reason = error instanceof ToolError ? error.code : "EVIDENCE_COLLECTION_FAILED";
  try {
    await recordFailure(root, run.runId, { kind: "collection", code: reason });
  } catch {
    // 索引本身不可写时，响应中的 missing 是最后的可信结果，不能掩盖业务原失败。
  }
  return { status: "missing" as const, reason };
}
export async function captureArtifact(root: string, run: RunIdentity, input: ArtifactInput) {
  try {
    await initializeEvidence(root, run);
    const artifact = await recordArtifact(root, run.runId, input);
    return { status: "indexed" as const, artifactId: artifact.id };
  } catch (error) {
    try {
      await recordArtifact(root, run.runId, {
        kind: input.kind,
        source: input.source,
        status: "missing",
        reason: "ARTIFACT_UNAVAILABLE",
        requestId: input.requestId,
        snapshotId: input.snapshotId,
        windowId: input.windowId,
      });
    } catch {
      // 无法更新索引时仍向调用方返回缺失。
    }
    return collectionFailure(root, run, error);
  }
}
/** 仅供内部已投影的数据使用；不得传入原始响应、凭据或任意 userData。 */
export async function captureJson(
  root: string,
  run: RunIdentity,
  input: Omit<ArtifactInput, "status" | "name">,
  value: unknown,
) {
  try {
    await initializeEvidence(root, run);
    const directory = await agentFile(root, agentRunHome(root, run.runId));
    const name = `${input.kind}-${randomUUID()}.json`;
    await atomicJson(join(directory, name), value);
    return { ...(await captureArtifact(root, run, { ...input, name, status: "available" })), name };
  } catch (error) {
    return collectionFailure(root, run, error);
  }
}
export async function captureExisting(
  root: string,
  run: RunIdentity,
  path: string,
  input: Omit<ArtifactInput, "status" | "name">,
) {
  if (resolve(path) !== join(agentRunHome(root, run.runId), basename(path)))
    return collectionFailure(
      root,
      run,
      new ToolError(
        "EVIDENCE_ARTIFACT_PATH",
        "文件不属于当前运行根目录",
        "核对运行身份",
        "blocked",
      ),
    );
  return captureArtifact(root, run, { ...input, status: "available", name: basename(path) });
}

export async function lifecycleEvidence(
  root: string,
  run: RunIdentity,
  lifecycle: EvidenceManifest["lifecycle"],
  problem?: Omit<Failure, "id" | "time">,
) {
  try {
    await initializeEvidence(root, run);
    if (problem) await recordFailure(root, run.runId, problem);
    await updateEvidence(root, run.runId, (value) => {
      value.lifecycle = lifecycle;
      if (run.buildId) value.buildId = run.buildId;
    });
    return { status: "indexed" as const };
  } catch (error) {
    return collectionFailure(root, run, error);
  }
}
