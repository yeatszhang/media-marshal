import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { atomicJson } from "./build.ts";
import { sessionsHome, inspectSession, readSession, type Session } from "./session-store.ts";
import { ToolError, type Request } from "./protocol.ts";
export interface ActionReceipt {
  jobId: string;
  requestId: string;
  sessionId: string;
  runId: string;
  buildId?: string;
  snapshotId: string;
  imageId?: string;
  action: string;
  status: "running" | "completed" | "failed" | "blocked" | "unknown";
  inputStatus: "not-sent" | "sending" | "sent" | "unknown";
  inputValueRecorded: false;
  result?: unknown;
  error?: unknown;
}
export async function actionPath(root: string, session: Session, requestId: string) {
  const directory = join(sessionsHome(root), session.sessionId, "requests");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return join(directory, requestId + ".json");
}
export const actionSignature = (session: Session, request: Request) =>
  createHmac("sha256", session.token)
    .update(JSON.stringify({ command: request.command, payload: request.payload }))
    .digest("hex");
export async function previousAction(path: string, signature: string) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.signature !== signature)
      throw new ToolError(
        "REQUEST_CONFLICT",
        "同一请求已用于不同动作或参数",
        "查询原收据；新动作使用新请求身份",
        "blocked",
      );
    if (!value.result?.jobId) throw new Error("收据未完成");
    return value.result as ActionReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      "ACTION_RESULT_UNKNOWN",
      "原动作记录不完整",
      "保留证据并查询业务结果，不自动重放",
      "unknown",
    );
  }
}
export async function reserveAction(path: string, signature: string, receipt: ActionReceipt) {
  const entries = await readdir(join(path, ".."));
  if (entries.length >= 512)
    throw new ToolError(
      "RECEIPTS_FULL",
      "本会话动作收据已满",
      "停止后创建新会话；不删除旧确认身份",
      "blocked",
    );
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ signature, result: receipt }));
    await file.sync();
  } finally {
    await file.close();
  }
}
export const saveAction = (path: string, signature: string, result: ActionReceipt) =>
  atomicJson(path, { signature, result });
export async function actionStatus(root: string, sessionId: string, jobId: string) {
  const session = inspectSession(await readSession(root, sessionId));
  let value;
  try {
    value = JSON.parse(await readFile(await actionPath(root, session, jobId), "utf8"));
  } catch {
    throw new ToolError(
      "ACTION_NOT_FOUND",
      "没有可查询的动作收据",
      "核对原会话和 jobId，不据此重放动作",
      "unknown",
    );
  }
  const result = value.result as ActionReceipt;
  if (result?.jobId !== jobId || result.sessionId !== sessionId)
    throw new ToolError(
      "ACTION_NOT_FOUND",
      "身份不匹配的动作收据",
      "核对原会话和 jobId",
      "unknown",
    );
  if (
    ["running", "unknown"].includes(result.status) &&
    (session.status !== "running" || result.runId !== session.runId)
  )
    return {
      ...result,
      status: "unknown",
      inputStatus: result.inputStatus === "not-sent" ? "not-sent" : "unknown",
    };
  return result;
}
