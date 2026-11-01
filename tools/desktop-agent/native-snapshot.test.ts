import { test } from "node:test";
import assert from "node:assert/strict";
import { settledNativeObservation } from "./native-snapshot.ts";
const observation = (fingerprint: string, truncated = false) => ({
  fingerprint: fingerprint.repeat(64),
  truncated,
  nodes: [
    {
      path: [],
      role: "AXApplication",
      name: "合成应用",
      enabled: true,
      focused: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      secure: false,
    },
  ],
  windows: [],
});
test("原生就绪只重复观察，等待懒加载后两次一致；截断、变化和原始拒绝不触发输入", async () => {
  const sequence = [observation("a"), observation("b"), observation("b")];
  let calls = 0;
  const result = await settledNativeObservation(async () => sequence[calls++], {
    timeoutMs: 100,
    intervalMs: 1,
  });
  assert.equal(result.fingerprint, "b".repeat(64));
  assert.equal(calls, 3);
  const partial = {
    ...observation("c", true),
    omissions: [{ path: [1], reason: "unknown-owner" }],
  };
  const known = await settledNativeObservation(async () => partial, {
    timeoutMs: 100,
    intervalMs: 1,
  });
  assert.equal(known.truncated, true);
  assert.equal(known.nodes.length, 1);
  await assert.rejects(
    settledNativeObservation(async () => observation("a", true)),
    { code: "NATIVE_SNAPSHOT_TRUNCATED" },
  );
  await assert.rejects(
    settledNativeObservation(async () => observation(calls++ % 2 ? "a" : "b"), {
      timeoutMs: 10,
      intervalMs: 1,
    }),
    { code: "NATIVE_SNAPSHOT_UNSTABLE" },
  );
  const original = Object.assign(new Error("目标进程身份变化"), { code: "GENERATION_MISMATCH" });
  let rejectedCalls = 0;
  await assert.rejects(
    settledNativeObservation(async () => {
      rejectedCalls++;
      throw original;
    }),
    (error) => error === original,
  );
  assert.equal(rejectedCalls, 1);
});
