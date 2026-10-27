import { describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { planOnce, advanceDownloadState, acceptExecutionEvent, type OnceScope } from "./planning";
import { HOST_PROTOCOL_VERSION, type ExecutionContext } from "@media-marshal/contracts/internal";

function scope(): OnceScope {
  const accountId = randomUUID();
  return {
    jobId: randomUUID(), requestKey: randomUUID(), attemptId: randomUUID(), targetGrantId: randomUUID(),
    binding: { accountId, bindingId: randomUUID(), generation: randomUUID() },
    files: [{ entry: { accountId, ref: randomUUID(), parentRef: null, name: "电影 样片.txt", type: "file", size: 10, modifiedAt: null, version: null }, locator: { kind: "path", segments: ["电影 样片.txt"] }, mapping: { segments: ["电影 样片.txt"], slotKey: createHash("sha256").update("synthetic-slot").digest("hex") } }],
  };
}
describe("独立于具体组件的一次性计划与状态", () => {
  it("计划隔离输入并冻结快照，弱元数据明确标记且不生成私有组件参数", () => {
    const input = scope(), plan = planOnce(input);
    input.files[0]!.entry.name = "changed";
    input.files[0]!.mapping.segments[0] = "changed";
    expect(plan.summary).toEqual({ files: 1, bytes: 10, weakComparison: true });
    expect(plan.transfer.items[0]!.targetSegments).toEqual(["电影 样片.txt"]);
    expect(Object.isFrozen(plan.transfer.items[0]!.source.locator)).toBe(true);
    expect(() => plan.transfer.items[0]!.targetSegments.push("unsafe")).toThrow();
    expect(JSON.stringify(plan)).not.toMatch(/openlist|rclone|endpoint|cookie|shell/i);
  });
  it("同尺寸不同可靠版本形成不同版本键，不将本地路径当作远端身份", () => {
    const input = scope();
    input.files[0]!.entry.version = { kind: "revision", revisionKey: "revision-one" };
    const first = planOnce(input);
    input.files[0]!.entry.version = { kind: "revision", revisionKey: "revision-two" };
    const second = planOnce(input);
    expect(first.items[0]!.versionKey).not.toBe(second.items[0]!.versionKey);
    expect(second.summary.weakComparison).toBe(false);
  });
  it("重复槽位、未知大小、跨账号与越界映射在产生传输前拒绝", () => {
    const input = scope();
    input.files.push({ ...input.files[0]!, entry: { ...input.files[0]!.entry, ref: randomUUID() } });
    expect(() => planOnce(input)).toThrow();
    const unknown = scope(); unknown.files[0]!.entry.size = null;
    expect(() => planOnce(unknown)).toThrow();
    const other = scope(); other.files[0]!.entry.accountId = randomUUID();
    expect(() => planOnce(other)).toThrow();
    const unsafe = scope(); unsafe.files[0]!.mapping.segments = ["..", "escape.txt"];
    expect(() => planOnce(unsafe)).toThrow();
  });
  it("进度和退出不会直接成为业务完成，校验与提交需要独立证据", () => {
    expect(() => advanceDownloadState("RUNNING", "COMPLETED", { writerStopped: true })).toThrow();
    expect(advanceDownloadState("RUNNING", "VERIFYING", { writerStopped: true })).toBe("VERIFYING");
    expect(() => advanceDownloadState("VERIFYING", "COMMITTING", { writerStopped: true })).toThrow();
    const evidence = { writerStopped: true, fileVerified: true, rootAvailable: true };
    expect(advanceDownloadState("VERIFYING", "COMMITTING", evidence)).toBe("COMMITTING");
    expect(() => advanceDownloadState("COMMITTING", "COMPLETED", evidence)).toThrow();
    expect(advanceDownloadState("COMMITTING", "COMPLETED", { ...evidence, commitRecorded: true })).toBe("COMPLETED");
  });
  it("暂停中不能立即恢复，未停止写入者时不能进入可领取状态", () => {
    expect(advanceDownloadState("RUNNING", "PAUSING")).toBe("PAUSING");
    expect(() => advanceDownloadState("PAUSING", "RUNNING", { writerStopped: true })).toThrow();
    expect(() => advanceDownloadState("PAUSING", "PAUSED")).toThrow();
    expect(advanceDownloadState("PAUSING", "PAUSED", { writerStopped: true })).toBe("PAUSED");
    expect(advanceDownloadState("PAUSED", "QUEUED", { writerStopped: true })).toBe("QUEUED");
    expect(() => advanceDownloadState("QUEUED", "RUNNING", { writerStopped: true, authorized: true })).toThrow();
    expect(() => advanceDownloadState("COMMITTING", "PAUSED", { writerStopped: true })).toThrow();
    expect(() => advanceDownloadState("COMMITTING", "FAILED", { writerStopped: true })).toThrow();
    expect(() => advanceDownloadState("AUTH_REQUIRED", "QUEUED", { writerStopped: true })).toThrow();
    expect(() => advanceDownloadState("BLOCKED_LOCAL", "QUEUED", { writerStopped: true })).toThrow();
  });
  it("旧 attempt 与重复序号保持原游标，正确退出事件仍只更新观测", () => {
    const context: ExecutionContext = { coreGeneration: randomUUID(), hostGeneration: randomUUID(), bindingGeneration: randomUUID(), attemptId: randomUUID() };
    const cursor = { context, executionId: randomUUID(), sequence: 1 };
    const event = { kind: "host.event" as const, protocolVersion: HOST_PROTOCOL_VERSION, context, executionId: cursor.executionId, sequence: 2, event: { type: "exited" as const, exitCode: 0, stopped: false } };
    expect(acceptExecutionEvent(cursor, { ...event, context: { ...context, attemptId: randomUUID() } })).toBe(cursor);
    expect(acceptExecutionEvent(cursor, { ...event, sequence: 1 })).toBe(cursor);
    expect(acceptExecutionEvent(cursor, event)).toEqual({ ...cursor, sequence: 2 });
  });
});
