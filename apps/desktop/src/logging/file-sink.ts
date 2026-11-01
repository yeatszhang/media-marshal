import type { Writable } from "node:stream";
import type { DestinationStream, Logger } from "pino";
import { createLossReporter } from "./loss";
/** 文件队列失败不反向写入同一队列；控制台由开发会话单独采集缺口事件。 */
export function boundedFileSink(
  file: () => Writable | undefined,
  consoleLogger: Logger,
  onFailure: () => void,
): DestinationStream {
  const drop = createLossReporter(consoleLogger.child({ scope: "logging" }));
  return {
    write(chunk) {
      const target = file();
      if (!target || target.destroyed) return;
      if (target.writableLength > 1024 * 1024) {
        drop("FILE_QUEUE");
        onFailure();
        return;
      }
      target.write(chunk);
    },
  };
}
