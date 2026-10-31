import { readSession, publicSession, inspectSession } from "./session-store.ts";
import { collectionState, recentObservations } from "./observations.ts";
import { callController } from "./transport.ts";
import { recentLogs } from "./log-reader.ts";
import { ToolError, failure, type Request } from "./protocol.ts";
import { sanitizeLogValue } from "../../apps/desktop/src/logging/shared.ts";

export async function diagnoseSession(root: string, request: Request) {
  if (!request.sessionId)
    throw new ToolError("SESSION_REQUIRED", "诊断需要会话标识", "使用 --session 指定自有会话");
  const session = inspectSession(await readSession(root, request.sessionId));
  let live: unknown = { status: "unavailable", reason: "会话不在运行状态" };
  const collection = await collectionState(root, session);
  if (session.status === "running") {
    try {
      live = await callController(session, request);
    } catch (error) {
      live = failure(error);
    }
  }
  const failures = await recentLogs(root, session.sessionId, { level: "warn", limit: 30 });
  return sanitizeLogValue({
    session: publicSession(session),
    health: live && typeof live === "object" && "health" in live ? live.health : live,
    collection:
      live && typeof live === "object" && "collection" in live ? live.collection : collection,
    failures,
    observations: await recentObservations(root, session),
    assertions: "未执行；健康查询不代表业务成功",
    historyComplete: false,
  });
}
