import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  traceId: string;
  requestId: string;
  parentRequestId?: string;
}
const requests = new AsyncLocalStorage<RequestContext>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validIdentity = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);
export const requestContext = () => requests.getStore();
export const withRequestContext = <T>(context: RequestContext, execute: () => T): T =>
  requests.run(context, execute);
const processGeneration = randomUUID();
const inheritedSession = process.env.MARSHAL_LOG_SESSION_ID;
const fallbackSession = validIdentity(inheritedSession) ? inheritedSession : randomUUID();
// Main 首次生成，之后的自有 Core／Sidecar 继承；各进程仍独立生成 processGeneration。
process.env.MARSHAL_LOG_SESSION_ID = fallbackSession;
let sequence = 0;
/** 仅受信任宿主启动处注入；这些字段不参与业务授权。 */
export function processContext() {
  return {
    sessionId: validIdentity(process.env.MARSHAL_AGENT_SESSION_ID)
      ? process.env.MARSHAL_AGENT_SESSION_ID
      : fallbackSession,
    runId: validIdentity(process.env.MARSHAL_AGENT_RUN_ID)
      ? process.env.MARSHAL_AGENT_RUN_ID
      : undefined,
    buildId: /^[a-f0-9]{64}$/.test(process.env.MARSHAL_AGENT_BUILD_ID ?? "")
      ? process.env.MARSHAL_AGENT_BUILD_ID
      : "unidentified",
    processGeneration,
    sequence: ++sequence,
  };
}
