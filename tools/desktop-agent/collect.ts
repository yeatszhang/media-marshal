import { readSession } from "./session-store.ts";
import { exportBundle } from "./export-bundle.ts";
import { pinEvidence } from "./evidence-retention.ts";
import { readEvidence } from "./evidence-store.ts";
import { ToolError, type Input, type Request } from "./protocol.ts";
export async function collect(root: string, request: Request) {
  const input = request.payload as Input<"collect">;
  let runId = input.runId;
  if (request.sessionId) {
    const session = await readSession(root, request.sessionId);
    if (runId && (await readEvidence(root, runId)).sessionId !== session.sessionId)
      throw new ToolError(
        "EVIDENCE_IDENTITY_CONFLICT",
        "运行不属于指定会话",
        "核对 runId 和 sessionId",
        "blocked",
      );
    runId ??= session.runId;
  }
  if (!runId)
    throw new ToolError(
      "RUN_REQUIRED",
      "导出需要运行身份",
      "指定 --session 或输入 runId",
      "blocked",
    );
  if (input.pin !== undefined) await pinEvidence(root, runId, input.pin);
  return exportBundle(root, runId, input);
}
