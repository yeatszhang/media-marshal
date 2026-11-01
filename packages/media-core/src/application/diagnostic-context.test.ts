import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { RequestExecutions } from "./request-executions.js";
import { scopedLogger } from "./logger.js";

it("停止请求等待不丢失后台任务因果，恢复运行继续按持久业务身份查询", async () => {
  const records: Record<string, unknown>[] = [];
  const record = (fields: Record<string, unknown>) => {
    records.push(fields);
  };
  const logger = scopedLogger({ debug: record, info: record, warn: record, error: record }, "sync");
  const executions = new RequestExecutions(10000);
  const id = randomUUID(),
    jobId = randomUUID();
  let release!: () => void;
  const work = new Promise<void>((done) => {
    release = done;
  });
  const response = executions.run(id, async () => {
    logger.info({ event: "job.accepted", jobId }, "作业已受理");
    await work;
    logger.error({ event: "job.failed", jobId, errorCode: "VOLUME_UNAVAILABLE" }, "卷不可用");
  });
  await new Promise((done) => setImmediate(done));
  executions.cancel(id, "INTERRUPTED");
  await expect(response).rejects.toMatchObject({ code: "INTERRUPTED" });
  release();
  await executions.drain();
  expect(records).toHaveLength(2);
  expect(
    records.every((row) => row.requestId === id && row.traceId === id && row.jobId === jobId),
  ).toBe(true);
  const afterRestart = scopedLogger(
    { debug: record, info: record, warn: record, error: record },
    "sync",
  );
  afterRestart.warn({ event: "job.recovering", jobId }, "重启后核对原作业");
  expect(records.at(-1)).toMatchObject({ jobId, event: "job.recovering" });
  expect(records.at(-1)).not.toHaveProperty("requestId");
});
