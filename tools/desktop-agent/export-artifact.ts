import { open, constants } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { agentFile, agentRunHome } from "./paths.ts";
import { ToolError } from "./protocol.ts";
import { redactExport } from "./export-redaction.ts";
import { exportTrace } from "./export-trace.ts";
import type { Artifact } from "./evidence-model.ts";
export const exportHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function readArtifact(root: string, runId: string, artifact: Artifact) {
  if (/(?:credential|rclone|storage.?state|cookies|^config\.|^\.env)/i.test(artifact.name ?? ""))
    throw new Error("敏感资料不属于导出范围");
  const path = await agentFile(root, join(agentRunHome(root, runId), artifact.name!));
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)
      throw new Error("证据类型或大小变化");
    const bytes = await file.readFile();
    if (bytes.length !== artifact.bytes || exportHash(bytes) !== artifact.sha256)
      throw new Error("证据摘要变化");
    return bytes;
  } finally {
    await file.close();
  }
}
function assertImage(bytes: Uint8Array, artifact: Artifact) {
  if (
    !["masked", "safe-synthetic"].includes(artifact.privacy ?? "") ||
    !artifact.snapshotId ||
    !artifact.windowId
  )
    throw new ToolError(
      "IMAGE_PRIVACY_UNVERIFIED",
      "图像缺少可信的遮罩／合成上下文与窗口关联",
      "保留原图在本地，不默认导出未知图像",
      "blocked",
    );
  const image = Buffer.from(bytes);
  if (image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("不是 PNG");
  let offset = 8,
    ended = false;
  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset),
      kind = image.subarray(offset + 4, offset + 8).toString("ascii");
    if (offset + length + 12 > image.length || ["tEXt", "zTXt", "iTXt", "eXIf"].includes(kind))
      throw new Error("PNG 含未知元数据");
    offset += length + 12;
    if (kind === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== image.length) throw new Error("PNG 结构或尾部不可信");
}
export async function exportArtifact(root: string, runId: string, artifact: Artifact) {
  const bytes = await readArtifact(root, runId, artifact);
  if (artifact.kind === "trace") {
    if (artifact.privacy !== "safe-synthetic")
      throw new ToolError(
        "TRACE_PRIVACY_UNVERIFIED",
        "trace 未声明可信合成上下文",
        "不导出未知录制",
        "blocked",
      );
    return exportTrace(root, bytes);
  }
  if (artifact.name!.endsWith(".png")) {
    assertImage(bytes, artifact);
    return { bytes, redactions: 0, truncated: false };
  }
  if (!/\.(?:json|jsonl)$/.test(artifact.name!))
    throw new ToolError(
      "EXPORT_FILE_TYPE_BLOCKED",
      "证据类型未在导出清单内",
      "只导出结构化结果、关联 PNG 和合成 trace",
      "blocked",
    );
  const lines = artifact.name!.endsWith(".jsonl")
    ? bytes.toString("utf8").split("\n").filter(Boolean)
    : [bytes.toString("utf8")];
  let redactions = 0,
    truncated = false;
  const values = lines.map((line) => {
    const safe = redactExport(root, JSON.parse(line));
    redactions += safe.redactions;
    truncated ||= safe.truncated;
    return JSON.stringify(safe.value);
  });
  return { bytes: Buffer.from(values.join("\n") + "\n"), redactions, truncated };
}
