import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const helper = resolve(import.meta.dirname, ".build/native-helper");
const skip = process.platform !== "darwin" || !existsSync(helper);
test("macOS 权限探测只读返回能力，不请求系统授权", { skip }, () => {
  const probe = spawnSync(helper, ["capabilities"], { encoding: "utf8", timeout: 5000 });
  assert.equal(probe.status, 0, probe.stderr);
  const value = JSON.parse(probe.stdout);
  assert.equal(value.protocolVersion, 1);
  assert.equal(typeof value.accessibility, "boolean");
  assert.equal(typeof value.screenCapture, "boolean");
  assert.equal(typeof value.sessionLocked, "boolean");
});
test("原生请求拒绝非法进程和超量输入，不访问其他应用界面", { skip }, () => {
  const input = JSON.stringify({
    command: "observe",
    pid: -1,
    executable: "/outside",
    profile: "/outside",
    generation: "0:0",
  });
  const rejected = spawnSync(helper, [], { input, encoding: "utf8", timeout: 5000 });
  assert.equal(rejected.status, 2);
  assert.equal(JSON.parse(rejected.stdout).error.code, "PROCESS_UNAVAILABLE");
  const oversized = spawnSync(helper, [], {
    input: "x".repeat(65537),
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(oversized.status, 2);
  assert.equal(JSON.parse(oversized.stdout).error.code, "INPUT_TOO_LARGE");
});
