import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testRun, RUN_ANNOTATION, STARTUP_ANNOTATION } from "../test-result-evidence.ts";
import { recordFailure } from "../evidence-artifacts.ts";
import { agentRunHome } from "../paths.ts";
test.skip(process.env.MARSHAL_REPORTER_PROBE !== "1", "只在显式失败采集验收中运行");
test.beforeEach(async ({}, info) => {
  if (info.title === "启动失败探针") {
    info.annotations.push({ type: STARTUP_ANNOTATION });
    throw new Error("合成启动异常 probe-startup-secret");
  }
});
test("原断言失败探针", async () => {
  expect("probe-assertion-secret").toBe("原业务后置条件");
});
test("启动失败探针", async () => {
  throw new Error("此断言不应执行");
});
test("采集失败保留原断言探针", async ({}, info) => {
  const root = process.env.MARSHAL_REPORTER_PROBE_ROOT!;
  const run = await testRun(root, "writer-probe");
  await recordFailure(root, run.runId, { kind: "assertion", code: "TEST_ASSERTION_FAILED" });
  info.annotations.push({
    type: RUN_ANNOTATION,
    description: JSON.stringify({ runId: run.runId, sessionId: run.sessionId }),
  });
  await writeFile(join(agentRunHome(root, run.runId), ".manifest.lock"), "合成未知写入者", {
    flag: "wx",
    mode: 0o600,
  });
  expect("probe-collection-secret").toBe("不应被采集失败替代的原断言");
});
test("通过探针", async () => {
  expect(1).toBe(1);
});
test("未运行探针", async () => {
  test.skip();
});
