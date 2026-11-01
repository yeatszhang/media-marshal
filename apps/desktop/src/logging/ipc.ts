import { ipcMain as electronIpc, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { coreActions, nativeActions } from "@media-marshal/contracts";
import { withRequestContext, validIdentity } from "./context";
import { getLogger } from "./node";

type Handler = (event: IpcMainInvokeEvent, value: unknown) => unknown;
function actionName(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("action" in value) ||
    typeof value.action !== "string"
  )
    return undefined;
  return Object.hasOwn(coreActions, value.action) || Object.hasOwn(nativeActions, value.action)
    ? value.action
    : undefined;
}
/** 原 handler 仍执行完整 sender／frame／协议及参数准入。日志关联不授予权限。 */
export function traceDesktopHandler(handler: Handler): Handler {
  return (event, value) => {
    const id =
      value && typeof value === "object" && "requestId" in value && validIdentity(value.requestId)
        ? value.requestId
        : randomUUID();
    return withRequestContext({ traceId: id, requestId: id }, async () => {
      const log = getLogger("ipc"),
        started = performance.now(),
        action = actionName(value);
      log.debug({ event: "ipc.received", action }, "桌面请求已到达，尚未确认业务成功");
      try {
        const result = await handler(event, value);
        const failed =
          result && typeof result === "object" && "ok" in result && result.ok === false;
        log[failed ? "warn" : "debug"](
          {
            event: failed ? "ipc.rejected" : "ipc.returned",
            action,
            durationMs: Math.round(performance.now() - started),
          },
          failed ? "桌面请求未完成" : "桌面请求已返回",
        );
        return result;
      } catch (error) {
        log.warn({ event: "ipc.failed", action, error }, "桌面请求异常结束");
        throw error;
      }
    });
  };
}
export const ipcMain = {
  on: electronIpc.on.bind(electronIpc),
  removeListener: electronIpc.removeListener.bind(electronIpc),
  handle: (channel: string, handler: Handler) =>
    electronIpc.handle(channel, traceDesktopHandler(handler)),
  removeHandler: (channel: string) => electronIpc.removeHandler(channel),
};
