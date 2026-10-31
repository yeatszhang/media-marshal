import { it, expect, vi } from "vitest";
import { Writable } from "node:stream";
import { createProcessLogger } from "./node";
import { boundedFileSink } from "./file-sink";
import { createLogReceiver } from "./receiver";
import { RENDERER_LOG_PREFIX } from "./shared";

it("限流立即报告缺口并有界汇总精确丢弃数，不回显原始字段", () => {
  vi.useFakeTimers();
  const rows: Record<string, unknown>[] = [];
  const logger = createProcessLogger("main", {
    write: (chunk) => rows.push(JSON.parse(String(chunk))),
  });
  const receiver = createLogReceiver(logger, "renderer");
  try {
    for (let index = 0; index < 220; index++)
      receiver.renderer(
        RENDERER_LOG_PREFIX + JSON.stringify({ level: 40, msg: "固定消息", token: "秘密" }),
      );
    expect(rows.find((row) => row.event === "logging.dropped")).toMatchObject({
      dropCount: 1,
      batchComplete: false,
    });
    vi.advanceTimersByTime(1000);
    expect(rows.filter((row) => row.event === "logging.dropped").at(-1)).toMatchObject({
      dropCount: 20,
      batchComplete: true,
    });
    expect(rows.filter((row) => row.event !== "logging.dropped")).toHaveLength(200);
    expect(JSON.stringify(rows)).not.toContain("秘密");
  } finally {
    vi.useRealTimers();
  }
});
it("慢磁盘队列保持上限，控制台保留丢弃计数及失败信号", () => {
  vi.useFakeTimers();
  const file = new Writable({ write(_chunk, _encoding, _done) {} });
  const rows: Record<string, unknown>[] = [],
    failure = vi.fn();
  const logger = createProcessLogger("main", {
    write: (chunk) => rows.push(JSON.parse(String(chunk))),
  });
  const sink = boundedFileSink(() => file, logger, failure);
  try {
    for (let index = 0; index < 200; index++) sink.write("x".repeat(8192));
    expect(file.writableLength).toBeLessThanOrEqual(1024 * 1024 + 8192);
    vi.advanceTimersByTime(1000);
    const report = rows.filter((row) => row.event === "logging.dropped").at(-1)!;
    expect(report).toMatchObject({ dropReason: "FILE_QUEUE", batchComplete: true });
    expect(report.dropCount).toBe(200 - file.writableLength / 8192);
    expect(failure).toHaveBeenCalled();
  } finally {
    file.destroy();
    vi.useRealTimers();
  }
});
