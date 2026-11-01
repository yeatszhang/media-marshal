import { open, constants } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentFile, agentRunHome } from "./paths.ts";
import { lockEvidenceWriter } from "./evidence-store.ts";
import { recordArtifact, recordFailure } from "./evidence-artifacts.ts";
import { ToolError } from "./protocol.ts";
import type { ActionReceipt } from "./action-store.ts";
async function append(root: string, runId: string, source: "dom" | "test", value: object) {
  let unlock: (() => Promise<void>) | undefined;
  try {
    const directory = await agentFile(root, agentRunHome(root, runId));
    unlock = await lockEvidenceWriter(directory, ".actions.lock");
    const line = Buffer.from(
      JSON.stringify({
        id: randomUUID(),
        time: new Date().toISOString(),
        runId,
        source,
        ...value,
      }) + "\n",
    );
    if (line.length > 8192)
      throw new ToolError("ACTION_EVIDENCE_LIMIT", "单条动作摘要超出预算", "缩小摘要", "blocked");
    const file = await open(
      join(directory, "actions.jsonl"),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size + line.length > 2 * 1024 * 1024)
        throw new ToolError(
          "ACTION_EVIDENCE_LIMIT",
          "动作记录已满或不是普通文件",
          "保留当前记录并新建运行",
          "blocked",
        );
      if ((await file.write(line)).bytesWritten !== line.length)
        throw new Error("动作摘要写入不完整");
      await file.sync();
    } finally {
      await file.close();
    }
    const artifact = await recordArtifact(root, runId, {
      kind: "action",
      source,
      name: "actions.jsonl",
      status: "available",
      historyComplete: false,
    });
    return { status: "indexed" as const, artifactId: artifact.id };
  } catch (error) {
    const reason = error instanceof ToolError ? error.code : "ACTION_EVIDENCE_UNAVAILABLE";
    try {
      await recordFailure(root, runId, { kind: "collection", code: reason });
    } catch {
      /* 原失败不覆盖。 */
    }
    return { status: "missing" as const, reason };
  } finally {
    try {
      await unlock?.();
    } catch {
      return { status: "missing" as const, reason: "ACTION_EVIDENCE_UNLOCK_UNKNOWN" };
    }
  }
}
export function recordActionReceipt(root: string, receipt: ActionReceipt) {
  const code =
    receipt.error && typeof receipt.error === "object" && "code" in receipt.error
      ? receipt.error.code
      : undefined;
  return append(root, receipt.runId, "dom", {
    sessionId: receipt.sessionId,
    requestId: receipt.requestId,
    snapshotId: receipt.snapshotId,
    action: receipt.action,
    status: receipt.status,
    inputStatus: receipt.inputStatus,
    inputValuesRecorded: false,
    ...(typeof code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? { errorCode: code } : {}),
  });
}
export function recordTestActions(
  root: string,
  runId: string,
  value: { testId: string; apiSteps: number; failedSteps: number; truncated: boolean },
) {
  return append(root, runId, "test", {
    ...value,
    granularity: "test-step-summary",
    inputValuesRecorded: false,
  });
}
