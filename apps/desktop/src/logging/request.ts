import { getLogger } from "./node";
import { requestContext, withRequestContext } from "./context";

/** Main 与 Core 的不同请求 ID 通过此事件建立父子关系，不扩展业务协议。 */
export async function traceCoreRequest<T>(
  message: { requestId: string; kind: string; action?: string },
  execute: () => Promise<T>,
): Promise<T> {
  const parent = requestContext();
  const context = {
    traceId: parent?.traceId ?? message.requestId,
    requestId: message.requestId,
    parentRequestId: parent?.requestId,
  };
  return withRequestContext(context, async () => {
    const log = getLogger("core-requests"),
      started = performance.now();
    log.debug(
      {
        event: "core.request.sent",
        requestKind: message.kind,
        action:
          message.action && /^[a-z.-]{1,80}$/.test(message.action) ? message.action : undefined,
      },
      "请求已交给媒体核心，业务完成须查询对应作业",
    );
    try {
      const result = await execute();
      log.debug(
        { event: "core.request.returned", durationMs: Math.round(performance.now() - started) },
        "核心请求已返回",
      );
      return result;
    } catch (error) {
      log.warn(
        {
          event: "core.request.failed",
          durationMs: Math.round(performance.now() - started),
          error,
        },
        "核心请求未完成，先查询原业务身份",
      );
      throw error;
    }
  });
}
