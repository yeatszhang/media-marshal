import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProcessLogger, setRootLogger } from "./node";
import { withRequestContext, processContext } from "./context";
import { traceCoreRequest } from "./request";
import { createLogReceiver } from "./receiver";

it("并发请求的父子关联互不串扰，异步完成仍归于原请求", async () => {
  const records: Record<string, unknown>[] = [];
  const logger = createProcessLogger(
    "main",
    {
      write: (chunk) => {
        records.push(JSON.parse(String(chunk)));
      },
    },
    "debug",
  );
  setRootLogger(logger);
  const parents = [randomUUID(), randomUUID()],
    children = [randomUUID(), randomUUID()];
  await Promise.all(
    parents.map((id, index) =>
      withRequestContext({ requestId: id, traceId: id }, () =>
        traceCoreRequest({ requestId: children[index]!, kind: "request" }, async () => {
          await new Promise((done) => setImmediate(done));
          logger.info({ event: "test.operation", operationId: "持久业务身份" }, "任务继续执行");
        }),
      ),
    ),
  );
  for (let index = 0; index < 2; index++) {
    const group = records.filter((row) => row.requestId === children[index]);
    expect(group).toHaveLength(3);
    expect(
      group.every(
        (row) => row.traceId === parents[index] && row.parentRequestId === parents[index],
      ),
    ).toBe(true);
  }
  logger.info({ event: "test.outside" }, "请求外调度");
  expect(records.at(-1)).not.toHaveProperty("requestId");
  expect(new Set(records.map((row) => row.sequence)).size).toBe(records.length);
});
it("转发保留来源代际与因果 ID，拒绝伪造关联值及未登记字段", () => {
  let output = "";
  const logger = createProcessLogger("main", {
    write: (chunk) => {
      output += chunk;
    },
  });
  const context = processContext(),
    traceId = randomUUID();
  createLogReceiver(logger, "core").line(
    JSON.stringify({
      level: 30,
      msg: "已登记事件",
      event: "operation.failed",
      ...context,
      traceId,
      actionId: "原始敏感内容",
      sequence: 42,
      unauthorizedData: "秘密",
      sessionId: "伪造会话",
      buildId: "伪造构建",
      operationId: "跨重启稳定业务身份",
    }),
  );
  const record = JSON.parse(output);
  expect(record).toMatchObject({
    processGeneration: context.processGeneration,
    traceId,
    sequence: 42,
    operationId: "跨重启稳定业务身份",
  });
  expect(record.actionId).toBeUndefined();
  expect(record.sessionId).not.toBe("伪造会话");
  expect(output).not.toContain("秘密");
  expect(output).not.toContain("原始敏感内容");
});
