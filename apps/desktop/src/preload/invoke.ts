import { ipcRenderer } from "electron";
import { DESKTOP_CHANNEL, PROTOCOL_VERSION, DesktopError } from "@media-marshal/contracts";
import { RENDERER_LOG_PREFIX, sanitizeLogValue } from "../logging/shared";

let currentEvent: { event: Event; id: string } | undefined;
function beginUiAction(event: Event) {
  const action = { event, id: crypto.randomUUID() };
  currentEvent = action;
  setTimeout(() => {
    if (currentEvent === action) currentEvent = undefined;
  }, 0);
}
// eventPhase 归零后不再关联；后台轮询不能误用上次点击。不读取名称或输入内容。
document.addEventListener("click", beginUiAction, true);
document.addEventListener("keydown", beginUiAction, true);
const pollingAction =
  /(?:\.get(?:-|$)|\.list(?:-|$)|(?:^|[.-])(?:status|pause-status|job-files|jobs|job|preview-files|diagnostics|task-targets|directories|seasons|queue)$)/;
function emit(fields: Record<string, unknown>) {
  const level = typeof fields.action === "string" && pollingAction.test(fields.action) ? 20 : 30;
  console.info(
    RENDERER_LOG_PREFIX +
      JSON.stringify(sanitizeLogValue({ level, msg: "界面业务请求", scope: "preload", ...fields })),
  );
}
function businessReferences(value: unknown) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    ["id", "jobId", "operationId", "taskId", "previewId", "attemptId"].flatMap((key) => {
      const field = (value as Record<string, unknown>)[key];
      return typeof field === "string" && /^[0-9a-f-]{36}$/i.test(field)
        ? [[key === "id" ? "entityId" : key, field]]
        : [];
    }),
  );
}
export async function invoke(action: string, payload: unknown): Promise<any> {
  const requestId = crypto.randomUUID(),
    context = {
      action,
      requestId,
      traceId: requestId,
      actionId:
        currentEvent && currentEvent.event.eventPhase !== Event.NONE ? currentEvent.id : undefined,
    };
  emit({ ...context, event: "ui.request.started" });
  const reply = await ipcRenderer
    .invoke(DESKTOP_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      action,
      payload,
    })
    .catch((error) => {
      emit({ ...context, event: "ui.request.interrupted", error });
      throw error;
    });
  emit({
    ...context,
    event: reply.ok ? "ui.request.returned" : "ui.request.failed",
    ...(reply.ok ? businessReferences(reply.result) : {}),
  });
  if (!reply.ok)
    throw new DesktopError(
      reply.error.code,
      reply.error.message,
      reply.error.retryable,
      reply.error.retryAfterSeconds,
      reply.error.directoryIssue,
    );
  return reply.result;
}
