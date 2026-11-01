import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestCase, TestResult } from "@playwright/test/reporter";
import {
  testRun,
  recordTestResult,
  RUN_ANNOTATION,
  STARTUP_ANNOTATION,
} from "./test-result-evidence.ts";
import { readEvidence } from "./evidence-store.ts";
function outcome(status: TestResult["status"]) {
  return {
    status,
    retry: 0,
    duration: 12,
    steps: [],
    errors: status === "failed" ? [{ message: "synthetic-result-secret" }] : [],
  } as unknown as TestResult;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marshal-result-"));
  const run = await testRun(root, "单元断言汇总");
  const testcase = {
    id: "synthetic-test",
    expectedStatus: "passed",
    location: { file: join(root, "probe.ts"), line: 12 },
    annotations: [
      {
        type: RUN_ANNOTATION,
        description: JSON.stringify({ sessionId: run.sessionId, runId: run.runId }),
      },
    ],
  } as TestCase;
  return { root, run, testcase };
}
test("后续启动失败或通过不覆盖原断言失败，也不落原始错误内容", async () => {
  const { root, run, testcase } = await fixture();
  try {
    await recordTestResult(root, testcase, outcome("failed"));
    const first = await readEvidence(root, run.runId);
    const original = first.primaryFailureId;
    const artifact = first.artifacts.find(
      (value) => value.kind === "assertion" && value.status === "available",
    )!;
    const path = join(root, "test-results/agent", run.runId, artifact.name!);
    const bytes = await readFile(path, "utf8");
    assert.equal(bytes.includes("synthetic-result-secret"), false);
    testcase.annotations.push({ type: STARTUP_ANNOTATION });
    await recordTestResult(root, testcase, outcome("failed"));
    testcase.annotations.pop();
    await recordTestResult(root, testcase, outcome("passed"));
    const after = await readEvidence(root, run.runId);
    assert.equal(after.assertions, "failed");
    assert.equal(after.primaryFailureId, original);
    assert.equal(await readFile(path, "utf8"), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("部分跳过不得汇总为全通过，关联身份错误不得修改原运行", async () => {
  const { root, run, testcase } = await fixture();
  try {
    await recordTestResult(root, testcase, outcome("passed"));
    await recordTestResult(root, testcase, outcome("skipped"));
    const mixed = await readEvidence(root, run.runId);
    assert.equal(mixed.assertions, "unknown");
    testcase.annotations[0]!.description = JSON.stringify({
      sessionId: randomUUID(),
      runId: run.runId,
    });
    await assert.rejects(recordTestResult(root, testcase, outcome("passed")), /关联身份不匹配/);
    assert.deepEqual(await readEvidence(root, run.runId), mixed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
