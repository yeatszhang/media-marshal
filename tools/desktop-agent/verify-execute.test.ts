import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { executeVerificationStep } from "./verify-execute.ts";
test("真实 Node 执行保留失败，TODO／跳过／空测试不通过，不记录敏感输出", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marshal-verify-execute-")),
    root = resolve(import.meta.dirname, "../..");
  const run = async (source: string) => {
    const path = join(directory, "probe.test.mjs");
    await writeFile(path, 'import {test} from "node:test";\n' + source);
    return executeVerificationStep(root, { runner: "node", args: [path], timeoutMs: 10000 });
  };
  try {
    assert.equal((await run('test("通过",()=>{});')).status, "passed");
    for (const option of ["todo", "skip"])
      assert.equal((await run(`test("未完成",{${option}:true},()=>{});`)).status, "blocked");
    assert.equal((await run("// 没有测试\n")).status, "blocked");
    const failed = await run(
      'test("失败",()=>{ console.log("Cookie=synthetic-secret");throw new Error("synthetic-private-value"); });',
    );
    assert.equal(failed.status, "failed");
    assert.doesNotMatch(JSON.stringify(failed), /synthetic-private|synthetic-secret/);
    assert.ok(failed.durationMs >= 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("检查进程已失败而机器结果缺失时保留失败；零退出但无结果仍为未知", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-verify-missing-"));
  const folder = join(root, "node_modules/@playwright/test"),
    path = join(folder, "cli.js");
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(path, 'console.error("synthetic-private");process.exitCode=1;');
    const failed = await executeVerificationStep(root, {
      runner: "playwright",
      args: [],
      timeoutMs: 5000,
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.reason, "VERIFY_RESULT_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(failed), /synthetic-private/);
    await writeFile(path, "process.exitCode=0;");
    assert.equal(
      (await executeVerificationStep(root, { runner: "playwright", args: [], timeoutMs: 5000 }))
        .status,
      "unknown",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("固定命令失败保留脱敏诊断，stdout／stderr 总量上限导致未知而非通过", async () => {
  const root = resolve(import.meta.dirname, "../.."),
    directory = await mkdtemp(join(tmpdir(), "marshal-verify-diagnostics-"));
  const path = join(directory, "command.mjs");
  try {
    await writeFile(path, 'console.error("合成定位 a.ts:3");process.exitCode=1;');
    const failure = await executeVerificationStep(root, {
      runner: "command",
      args: [path],
      timeoutMs: 10000,
    });
    assert.equal(failure.status, "failed");
    assert.match(String(failure.diagnostics), /合成定位/);
    await writeFile(path, 'console.error("Cookie=synthetic-secret");process.exitCode=1;');
    const secret = await executeVerificationStep(root, {
      runner: "command",
      args: [path],
      timeoutMs: 10000,
    });
    assert.doesNotMatch(JSON.stringify(secret), /synthetic-secret/);
    await writeFile(path, 'process.stderr.write("x".repeat(1024*1024+1));');
    const oversized = await executeVerificationStep(root, {
      runner: "command",
      args: [path],
      timeoutMs: 10000,
    });
    assert.equal(oversized.status, "unknown");
    assert.equal(oversized.reason, "CHECK_OUTPUT_LIMIT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
