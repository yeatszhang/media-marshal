import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RcloneLogParser, rcloneExitFailure } from "./logs";
import type { TransferEvent } from "@media-marshal/contracts/internal";

describe("锁定 Rclone 统计的有界解析", () => {
  it("消费真实夹具，只发布归一化数字，不转发错误、文件名或私有字段", () => {
    const fixture = JSON.parse(readFileSync(resolve("tools/desktop-sidecars/fixtures/rclone-v1.75.2.local.json"), "utf8"));
    const events: TransferEvent[] = []; let now = 0;
    const parser = new RcloneLogParser((event) => events.push(event), () => now);
    for (const check of fixture.checks) for (const record of check.logs ?? check.restartLogs ?? []) { parser.feed(Buffer.from(JSON.stringify(record) + "\n")); now += 1000; }
    parser.finish(); expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.type === "progress")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/lastError|object|path|cookie|sample/);
  });
  it("UTF-8 分块、未知字段、截断与超长行不造成无界缓存或执行异常", () => {
    const events: TransferEvent[] = [], parser = new RcloneLogParser((value) => events.push(value));
    const input = Buffer.from(JSON.stringify({ msg: "中文秘密", stats: { bytes: 3, totalBytes: 10, speed: 2, unsupported: true } }) + "\n");
    for (const byte of input) parser.feed(Buffer.from([byte]));
    parser.feed(Buffer.from("x".repeat(200000))); parser.feed(Buffer.from("\n{truncated")); parser.finish();
    expect(events).toEqual([{ type: "progress", bytes: 3, totalBytes: 10, bytesPerSecond: 2 }]); expect(parser.droppedLines).toBe(2);
  });
  it("重复统计至多 1 Hz，重试与未知总量不伪造百分比，退出不等同业务完成", () => {
    let now = 0; const events: TransferEvent[] = [], parser = new RcloneLogParser((value) => events.push(value), () => now);
    const emit = (bytes: number, totalBytes?: number) => parser.feed(Buffer.from(JSON.stringify({ stats: { bytes, totalBytes, speed: 1 } }) + "\n"));
    emit(3, 10); emit(4, 10); emit(4, 10); now = 1000; emit(2); now = 2000; emit(20, 10); parser.finish();
    expect(events).toEqual([{ type: "progress", bytes: 3, totalBytes: 10, bytesPerSecond: 1 }, { type: "progress", bytes: 4, totalBytes: null, bytesPerSecond: 1 }, { type: "progress", bytes: 20, totalBytes: null, bytesPerSecond: 1 }]);
    expect(rcloneExitFailure(0, false)).toBeNull(); expect(rcloneExitFailure(5, false)?.code).toBe("NETWORK_UNAVAILABLE"); expect(rcloneExitFailure(1, false)?.code).toBe("COMPONENT_UNAVAILABLE"); expect(rcloneExitFailure(-1, true)).toBeNull();
  });
});
