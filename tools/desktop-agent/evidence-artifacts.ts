import { open, constants } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { agentFile, agentRunHome } from "./paths.ts";
import { artifactSchema, type Artifact, type Failure } from "./evidence-model.ts";
import { updateEvidence } from "./evidence-store.ts";
import { ToolError } from "./protocol.ts";
export type ArtifactInput = Pick<Artifact, "kind" | "source" | "status"> &
  Partial<Omit<Artifact, "kind" | "source" | "status" | "id" | "time">>;
async function describe(root: string, runId: string, input: ArtifactInput) {
  if (input.status !== "available")
    return artifactSchema.parse({ id: randomUUID(), time: new Date().toISOString(), ...input });
  // 文件名校验先于路径拼接，避免打开其他运行或用户数据。
  if (!input.name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/.test(input.name))
    throw new ToolError(
      "EVIDENCE_ARTIFACT_PATH",
      "证据文件名越界或无效",
      "仅登记当前 run 根下的工具产物",
      "blocked",
    );
  const file = await open(
    await agentFile(root, join(agentRunHome(root, runId), input.name)),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16 * 1024 * 1024)
      throw new ToolError(
        "EVIDENCE_ARTIFACT_LIMIT",
        "证据文件超出类型或大小预算",
        "缩小采集范围并记录明确缺失",
        "blocked",
      );
    const bytes = await file.readFile();
    return artifactSchema.parse({
      ...input,
      id: randomUUID(),
      time: new Date().toISOString(),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await file.close();
  }
}
export async function recordArtifact(root: string, runId: string, input: ArtifactInput) {
  const artifact = await describe(root, runId, input);
  await updateEvidence(root, runId, (value) => {
    const index = value.artifacts.findIndex(
      (existing) =>
        existing.kind === artifact.kind &&
        (artifact.name
          ? existing.name === artifact.name
          : !existing.name && existing.status === "not-run"),
    );
    const placeholder = value.artifacts.findIndex(
      (existing) =>
        existing.kind === artifact.kind && existing.status === "not-run" && !existing.name,
    );
    if (index >= 0 || placeholder >= 0)
      value.artifacts[index >= 0 ? index : placeholder] = artifact;
    else {
      if (value.artifacts.length >= 2048)
        throw new ToolError(
          "EVIDENCE_INDEX_FULL",
          "本轮证据索引已满",
          "保存当前证据并开始新运行",
          "blocked",
        );
      value.artifacts.push(artifact);
    }
  });
  return artifact;
}
export async function recordFailure(
  root: string,
  runId: string,
  input: Omit<Failure, "id" | "time">,
) {
  const failure = { id: randomUUID(), time: new Date().toISOString(), ...input };
  await updateEvidence(root, runId, (value) => {
    if (value.failures.length >= 256)
      throw new ToolError(
        "EVIDENCE_FAILURE_LIMIT",
        "本轮失败索引已满",
        "保留原失败和收集错误，开始新运行",
        "blocked",
      );
    value.failures.push(failure);
    if (input.kind !== "collection" && !value.primaryFailureId) value.primaryFailureId = failure.id;
    if (input.kind === "assertion") value.assertions = "failed";
  });
  return failure;
}
