import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { checkResults } from "./check-results.ts";
import { executeCheck } from "./check-execute.ts";
import { faultCatalog, type CheckPhase } from "./fault-catalog.ts";
const phase: CheckPhase = {
  runner: "vitest",
  file: "fixture.test.ts",
  tests: ["选中用例"],
  timeoutMs: 1000,
};
test("结果投影保留原失败，选中用例缺失／跳过不能标绿，过滤产生的非选中跳过不冒充阻碍", () => {
  const result = (status: string, code: number | null = 0, title = "选中用例") =>
    checkResults(
      phase,
      JSON.stringify({
        testResults: [
          {
            assertionResults: [
              { title, status, duration: 1, failureMessages: ["private-original-secret"] },
              { title: "未选中用例", status: "pending" },
            ],
          },
        ],
      }),
      code,
    );
  assert.equal(result("passed").status, "passed");
  assert.equal(result("failed").status, "failed");
  assert.equal(result("passed", 1).status, "failed");
  assert.equal(result("passed", null).status, "unknown");
  assert.equal(result("pending").status, "blocked");
  assert.equal(result("passed", 0, "另一个用例").status, "blocked");
  assert.equal(result("passed").assertionSource, "repository");
  assert.equal(result("passed").standardsComparison, "not-run");
  assert.equal(JSON.stringify(result("failed")).includes("private-original-secret"), false);
});
test("六个固定故障及恢复阶段仍指向真实源码用例，协议不接受任意文件／命令", async () => {
  const root = resolve(import.meta.dirname, "../..");
  assert.equal(Object.keys(faultCatalog).length, 6);
  for (const scenario of Object.values(faultCatalog))
    for (const mode of ["on", "off"] as const) {
      const entry = scenario[mode],
        source = await readFile(join(root, entry.file), "utf8");
      assert.equal(entry.tests.length, 1);
      assert.ok(source.includes(JSON.stringify(entry.tests[0]!)), `${mode}: ${entry.file}`);
    }
  const { parseRequest } = await import("./protocol.ts");
  assert.throws(
    () => parseRequest({ command: "scenario", payload: { mode: "fault", fault: "shell-script" } }),
    { code: "INVALID_INPUT" },
  );
  assert.throws(
    () =>
      parseRequest({
        command: "scenario",
        payload: { mode: "fault", fault: "http-timeout", file: "../private" },
      }),
    { code: "INVALID_INPUT" },
  );
});
test("实际 Node reporter 不转发控制台或断言秘密，仍保留通过与原始失败退出状态", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-check-node-"));
  try {
    await mkdir(join(root, "tools/desktop-agent"), { recursive: true });
    await copyFile(
      join(import.meta.dirname, "check-node-reporter.mjs"),
      join(root, "tools/desktop-agent/check-node-reporter.mjs"),
    );
    await writeFile(
      join(root, "probe.test.cjs"),
      "const {test}=require('node:test');const assert=require('node:assert/strict');test('通过探针',()=>{console.log('private-console-secret');assert.equal(1,1)});test('失败探针',()=>assert.equal('private-original-secret','expected'));\n",
    );
    const passed = await executeCheck(root, {
      runner: "node",
      file: "probe.test.cjs",
      tests: ["通过探针"],
      timeoutMs: 10000,
    });
    assert.equal(passed.status, "passed", JSON.stringify(passed));
    const failed = await executeCheck(root, {
      runner: "node",
      file: "probe.test.cjs",
      tests: ["失败探针"],
      timeoutMs: 10000,
    });
    assert.equal(failed.status, "failed", JSON.stringify(failed));
    assert.equal("exitCode" in failed && failed.exitCode, 1);
    for (const secret of ["private-console-secret", "private-original-secret"])
      assert.equal(JSON.stringify([passed, failed]).includes(secret), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
