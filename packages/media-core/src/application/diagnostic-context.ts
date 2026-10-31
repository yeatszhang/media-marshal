import { AsyncLocalStorage } from "node:async_hooks";
const context = new AsyncLocalStorage<{ requestId: string; traceId: string }>();
export const currentRequestContext = () => context.getStore() ?? {};
export const withCoreRequest = <T>(requestId: string, execute: () => T): T =>
  context.run({ requestId, traceId: requestId }, execute);

export function businessReferences(value: unknown) {
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
