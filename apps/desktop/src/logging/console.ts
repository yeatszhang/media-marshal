import { inspect, stripVTControlCharacters } from "node:util";
import type { DestinationStream } from "pino";
import { prettyFactory } from "pino-pretty";

type ConsoleDestination = DestinationStream & { isTTY?: boolean };
const metadata = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "process",
  "scope",
  "msg",
  "error",
  "err",
]);
const plainText = (value: unknown) =>
  stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

function formatError(value: string | object): string {
  if (!value || typeof value !== "object") return plainText(value);
  const error = value as Record<string, unknown>;
  const details = Object.entries(error)
    .filter(([key]) => key !== "stack")
    .map(([key, item]) => `${plainText(key)}=${plainText(item)}`)
    .join(" ");
  const stack =
    typeof error.stack === "string"
      ? error.stack
          .split("\n")
          .map((line) =>
            stripVTControlCharacters(line).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " "),
          )
          .join("\n")
      : "";
  return [details, stack].filter(Boolean).join("\n");
}

/** 只美化 Main 的终端目标；文件和跨进程传输继续使用结构化记录。 */
export function createConsoleDestination(
  destination: ConsoleDestination = process.stdout,
): DestinationStream {
  const colorize =
    process.env.NO_COLOR === undefined &&
    (process.env.FORCE_COLOR !== undefined
      ? process.env.FORCE_COLOR !== "0"
      : destination.isTTY === true);
  const pretty = prettyFactory({
    colorize,
    translateTime: "SYS:HH:MM:ss.l",
    include: "level,time,msg,error,err",
    customPrettifiers: { error: formatError, err: formatError },
    messageFormat(record, messageKey) {
      const source = [record.process, record.scope !== record.process ? record.scope : undefined]
        .filter(Boolean)
        .join("/");
      const details = Object.entries(record)
        .filter(([key]) => !metadata.has(key))
        .map(
          ([key, value]) =>
            `${plainText(key)}=${plainText(typeof value === "object" ? inspect(value, { depth: 3, breakLength: Infinity }) : value)}`,
        );
      return [`[${plainText(source)}]`, plainText(record[messageKey] ?? ""), ...details].join(" ");
    },
  });
  // 使用同步格式化函数，不创建 transport worker 或额外的退出刷新队列。
  return {
    write(chunk) {
      destination.write(pretty(chunk));
    },
  };
}
