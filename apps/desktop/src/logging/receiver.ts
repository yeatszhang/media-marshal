import { StringDecoder } from "node:string_decoder";
import type { Logger, Level } from "pino";
import { validIdentity } from "./context";
import { RENDERER_LOG_PREFIX } from "./shared";

const levelNames: Record<number, Level> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};
const correlationIds = new Set(["traceId", "parentRequestId", "actionId", "processGeneration"]);
const fields = [
  "scope",
  "event",
  "action",
  "requestId",
  "traceId",
  "parentRequestId",
  "actionId",
  "entityId",
  "processGeneration",
  "sequence",
  "phase",
  "requestKind",
  "durationMs",
  "error",
  "errorCode",
  "exitCode",
  "jobId",
  "downloadJobId",
  "itemId",
  "sourceId",
  "ruleId",
  "previewId",
  "attemptId",
  "taskId",
  "candidateId",
  "operationId",
  "operationIds",
  "operationsTruncated",
  "scanId",
  "relativePath",
  "version",
  "state",
  "fromState",
  "toState",
  "operation",
  "mode",
  "inputKind",
  "fileCount",
  "readyCount",
  "matchCount",
  "failedCount",
  "discoveredCount",
  "bytes",
  "paused",
  "force",
  "blocked",
  "reusedCount",
  "removedCount",
  "targetCount",
  "targetId",
  "mediaType",
];

/** 只转发结构化日志，不把子进程原始 stderr 或任意页面控制台当作可信日志。 */
export function createLogReceiver(logger: Logger, source: "core" | "sidecar" | "renderer") {
  const target = logger.child({ process: source });
  let windowStart = Date.now(),
    count = 0;
  const receive = (line: string) => {
    if (line.length > 32 * 1024) return;
    if (Date.now() - windowStart >= 1000) {
      windowStart = Date.now();
      count = 0;
    }
    if (++count > 200) return;
    try {
      const record = JSON.parse(line);
      const level = levelNames[record?.level];
      if (!level || typeof record.msg !== "string") return;
      const data = Object.fromEntries(
        fields
          .filter((field) => Object.hasOwn(record, field))
          .filter((field) => !correlationIds.has(field) || validIdentity(record[field]))
          .filter(
            (field) =>
              field !== "operationIds" ||
              (Array.isArray(record[field]) &&
                record[field].length <= 20 &&
                record[field].every(validIdentity)),
          )
          .filter((field) => field !== "operationsTruncated" || typeof record[field] === "boolean")
          .filter(
            (field) =>
              field !== "sequence" || (Number.isSafeInteger(record[field]) && record[field] > 0),
          )
          .map((field) => [field, record[field]]),
      );
      if (source !== "renderer" && Number.isSafeInteger(record.pid) && record.pid > 0)
        data.sourcePid = record.pid;
      target[level](data, record.msg);
    } catch {
      /* 原始输出可能包含凭据，不原样兜底。 */
    }
  };
  return {
    line: receive,
    renderer(message: string) {
      if (message.startsWith(RENDERER_LOG_PREFIX))
        receive(message.slice(RENDERER_LOG_PREFIX.length));
    },
    stream() {
      const decoder = new StringDecoder("utf8");
      let buffer = "",
        dropping = false;
      return (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        for (const part of text.split(/(?<=\n)/)) {
          if (!dropping) buffer += part;
          if (buffer.length > 32 * 1024) {
            buffer = "";
            dropping = true;
          }
          if (part.endsWith("\n")) {
            if (!dropping) receive(buffer);
            buffer = "";
            dropping = false;
          }
        }
      };
    },
  };
}
