import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
/** 每批先标记至少一条丢失，随后有界汇总；进程被强杀时不能把首条计数当作总量。 */
export function createLossReporter(logger: Logger) {
  let batch = randomUUID(),
    timer: ReturnType<typeof setTimeout> | undefined;
  const counts = new Map<string, number>();
  const emit = (reason: string, count: number, complete: boolean) =>
    logger.warn(
      {
        event: "logging.dropped",
        dropReason: reason,
        dropCount: count,
        dropBatchId: batch,
        batchComplete: complete,
      },
      complete ? "日志丢弃批次计数已汇总" : "日志采集存在缺口，后续计数可能继续增加",
    );
  const flush = () => {
    for (const [reason, count] of counts) emit(reason, count, true);
    counts.clear();
    batch = randomUUID();
    timer = undefined;
  };
  return (reason: "RATE_LIMIT" | "LINE_TOO_LARGE" | "INVALID_RECORD" | "FILE_QUEUE") => {
    const count = (counts.get(reason) ?? 0) + 1;
    counts.set(reason, count);
    if (count === 1) emit(reason, count, false);
    if (!timer) {
      timer = setTimeout(flush, 1000);
      timer.unref();
    }
  };
}
