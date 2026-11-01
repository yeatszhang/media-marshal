import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import pino, { type DestinationStream } from "pino";
import { createStream } from "rotating-file-stream";
import { createConsoleDestination } from "./console";
import { createProcessLogger, setRootLogger } from "./node";
import { boundedFileSink } from "./file-sink";
import { logLevel, type LogLevel } from "./shared";

export async function configureMainLogging(
  directory: string,
  options: {
    level?: LogLevel;
    console?: DestinationStream;
    size?: string;
    onFailure?: () => void;
  } = {},
) {
  const level = options.level ?? logLevel(process.env.MARSHAL_LOG_LEVEL, "info");
  const consoleStream = createConsoleDestination(options.console ?? process.stdout);
  const consoleLogger = createProcessLogger("main", consoleStream, level);
  let reported = false;
  const reportFailure = () => {
    if (reported) return;
    reported = true;
    consoleLogger.error(
      { scope: "logging", event: "logging.unavailable" },
      "本地日志写入失败，请检查日志目录权限或可用空间；控制台日志仍可用",
    );
    options.onFailure?.();
  };
  const path = join(directory, "desktop.log");
  let file: ReturnType<typeof createStream> | undefined;
  let available = true;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    file = createStream("desktop.log", {
      path: directory,
      size: options.size ?? "10M",
      rotate: 5,
      mode: 0o600,
    });
    file.on("error", () => {
      available = false;
      reportFailure();
    });
    file.on("warning", reportFailure);
  } catch {
    available = false;
    reportFailure();
  }
  const fileStream = boundedFileSink(
    () => (available ? file : undefined),
    consoleLogger,
    reportFailure,
  );
  const logger = createProcessLogger(
    "main",
    pino.multistream([
      { level: "trace", stream: consoleStream },
      { level: "trace", stream: fileStream },
    ]),
    level,
  );
  setRootLogger(logger);
  let closing: Promise<void> | undefined;
  return {
    logger,
    path,
    close: () =>
      (closing ??= (async () => {
        if (!file || file.destroyed) return;
        const stream = file;
        available = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            finished(stream).catch(reportFailure),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                reportFailure();
                stream.destroy();
                resolve();
              }, 3000);
            }),
            new Promise<void>((resolve) => {
              stream.end(() => resolve());
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          available = false;
        }
      })()),
  };
}
