import { sanitizeLogValue } from "../../apps/desktop/src/logging/shared.ts";
import type { Input } from "./protocol.ts";
const levels = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const fields = new Set([
  "level",
  "time",
  "process",
  "scope",
  "event",
  "msg",
  "sessionId",
  "runId",
  "buildId",
  "processGeneration",
  "sequence",
  "sourcePid",
  "action",
  "requestId",
  "parentRequestId",
  "traceId",
  "actionId",
  "entityId",
  "jobId",
  "downloadJobId",
  "taskId",
  "operationId",
  "operationIds",
  "operationsTruncated",
  "itemId",
  "sourceId",
  "ruleId",
  "previewId",
  "attemptId",
  "errorCode",
  "exitCode",
  "phase",
  "fromState",
  "toState",
  "state",
  "durationMs",
  "dropCount",
  "dropReason",
  "dropSource",
  "dropBatchId",
  "batchComplete",
]);
export function matchesLog(
  record: Record<string, unknown>,
  sessionId: string,
  input: Input<"logs">,
) {
  return (
    record.sessionId === sessionId &&
    (!input.level || (typeof record.level === "number" && record.level >= levels[input.level])) &&
    (!input.process || record.process === input.process) &&
    (!input.scope || record.scope === input.scope) &&
    (!input.requestId ||
      record.requestId === input.requestId ||
      record.parentRequestId === input.requestId) &&
    (!input.operationId ||
      [record.operationId, record.jobId, record.taskId, record.itemId].includes(
        input.operationId,
      ) ||
      (Array.isArray(record.operationIds) && record.operationIds.includes(input.operationId)))
  );
}
export function projectLog(record: Record<string, unknown>) {
  const value = Object.fromEntries(Object.entries(record).filter(([key]) => fields.has(key)));
  if (record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>;
    const frames =
      typeof error.stack === "string"
        ? error.stack
            .split("\n")
            .filter((line) => /^\s+at /.test(line))
            .slice(0, 16)
            .join("\n")
            .slice(0, 8192)
        : "";
    value.error = {
      type: typeof error.type === "string" ? error.type.slice(0, 100) : "Error",
      code: typeof error.code === "string" ? error.code.slice(0, 80) : undefined,
      frames,
      locationKind: /\.[cm]?tsx?:\d+:\d+/.test(frames)
        ? "mapped"
        : frames
          ? "generated"
          : "unknown",
    };
  }
  return sanitizeLogValue(value) as Record<string, unknown>;
}
