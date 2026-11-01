import { test } from "node:test";
import assert from "node:assert/strict";
import { verificationTests, verificationOutcome } from "./verify-results.ts";
test("验证汇总保留失败，未执行、跳过、空集与源码变化不能标绿", () => {
  for (const status of ["not-run", "blocked", "unknown"] as const)
    assert.equal(
      verificationOutcome([{ status: "passed" }, { status }]).allPlannedChecksPassed,
      false,
    );
  assert.equal(verificationOutcome([]).status, "blocked");
  assert.equal(verificationOutcome([{ status: "passed" }], true).status, "unknown");
  assert.equal(verificationOutcome([{ status: "failed" }], true).status, "failed");
  assert.equal(verificationOutcome([{ status: "passed" }]).allPlannedChecksPassed, true);
  assert.equal(verificationTests("node", "", 0).status, "blocked");
  assert.equal(
    verificationTests("node", '{"name":"固定用例","status":"passed"}', 1).status,
    "failed",
  );
  for (const status of ["pending", "todo", "skipped", "unknown"])
    assert.equal(
      verificationTests("node", JSON.stringify({ name: "未完成用例", status }), 0).status,
      "blocked",
    );
  assert.throws(() => verificationTests("node", "不是受信结果", 0));
});
test("Vitest 与 Playwright 只保留摘要，失败重试不冒充一次通过", () => {
  const result = verificationTests(
    "vitest",
    JSON.stringify({
      testResults: [
        {
          name: "a.test.ts",
          assertionResults: [
            {
              fullName: "合成敏感标题 Cookie=secret",
              status: "failed",
              failureMessages: ["私人断言值"],
            },
            { fullName: "成功", status: "passed" },
          ],
        },
      ],
    }),
    1,
  );
  assert.equal(result.status, "failed");
  assert.deepEqual(result.counts, { passed: 1, failed: 1, skipped: 0 });
  assert.doesNotMatch(JSON.stringify(result), /secret|私人|Cookie/);
  const report = (results: object[]) =>
    JSON.stringify({
      suites: [{ suites: [{ specs: [{ id: "固定用例", tests: [{ results }] }] }] }],
    });
  assert.equal(verificationTests("playwright", report([{ status: "passed" }]), 0).status, "passed");
  assert.equal(
    verificationTests("playwright", report([{ status: "failed" }, { status: "passed" }]), 0).status,
    "blocked",
  );
  assert.equal(
    verificationTests("playwright", report([{ status: "skipped" }]), 0).status,
    "blocked",
  );
  assert.equal(
    verificationTests("playwright", report([{ status: "timedOut" }]), 1).status,
    "failed",
  );
});
