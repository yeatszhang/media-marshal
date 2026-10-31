import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseRequest, failure, ToolError } from "./protocol.ts";
import { Jobs } from "./jobs.ts";

const request = (value = {}) => parseRequest({ command: "start", ...value });
test("命令输入拒绝任意动作、脚本、超量及越界路径，错误不回显敏感值", () => {
  for (const value of [
    { command: "eval", payload: { script: "SECRET" } },
    { command: "act", payload: { action: "exec", script: "SECRET" } },
    { command: "logs", payload: { limit: 201 } },
    { command: "verify", payload: { changedFiles: ["../outside"] } },
  ])
    assert.throws(() => request(value), ToolError);
  assert.equal(request().payload.scenario, "empty");
  const output = JSON.stringify(failure(new Error("SECRET Cookie=private")));
  assert(!output.includes("SECRET"));
  assert(!output.includes("private"));
});
test("收据处理异步结果，重复请求只执行一次，取消保持结果未知", async () => {
  const jobs = new Jobs();
  let calls = 0,
    release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  const value = request({ requestId: randomUUID() });
  const receipt = jobs.start(value, async () => {
    calls++;
    await pending;
    return "完成";
  });
  assert.equal(
    jobs.start(value, async () => {
      calls++;
    }).jobId,
    receipt.jobId,
  );
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.throws(() => jobs.start({ ...value, command: "stop" }, async () => {}), /不同操作/);
  release();
  await new Promise((done) => setImmediate(done));
  assert.equal(jobs.get(receipt.jobId).status, "completed");
  const another = jobs.start(request(), async (signal) => {
    await new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("取消"))),
    );
  });
  await Promise.resolve();
  assert.equal(jobs.cancel(another.jobId).status, "unknown");
  await new Promise((done) => setImmediate(done));
  assert.equal(jobs.get(another.jobId).status, "unknown");
});
test("CLI stdout 只有机器结果，未知与未接入命令以非零退出", () => {
  const script = resolve(import.meta.dirname, "cli.ts");
  const invoke = (command: string) =>
    spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        script,
        command,
        "--json",
      ],
      { encoding: "utf8" },
    );
  const help = invoke("help");
  assert.equal(help.status, 0, help.stderr);
  assert.equal(JSON.parse(help.stdout).status, "completed");
  const invalid = invoke("eval");
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, "UNKNOWN_COMMAND");
  const blocked = invoke("verify");
  assert.equal(blocked.status, 2);
  assert.equal(JSON.parse(blocked.stdout).status, "blocked");
});
