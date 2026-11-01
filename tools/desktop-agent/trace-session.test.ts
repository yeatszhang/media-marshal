import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";
import { newSession, runHome } from "./session-store.ts";
import { initializeEvidence, readEvidence } from "./evidence-store.ts";
import { recordFailure } from "./evidence-artifacts.ts";
import { TraceSession } from "./trace-session.ts";
async function fixture(start = async () => {}, stop?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "marshal-trace-"));
  const run = await newSession(root, {
    scenario: "empty",
    seed: "trace-unit",
    mode: "background",
    target: "development",
  });
  await initializeEvidence(root, run);
  let url = "marshal://app/index.html";
  const main = {};
  const page = Object.assign(new EventEmitter(), {
    url: () => url,
    mainFrame: () => main,
    frames: () => [main],
    exposeBinding: async () => {},
    addInitScript: async () => {},
    evaluate: async () => false,
    locator: () => ({ count: async () => 0 }),
  });
  const calls: { path?: string }[] = [];
  const context = Object.assign(new EventEmitter(), {
    pages: () => [page],
    tracing: {
      start,
      stop: async (options: { path?: string } = {}) => {
        calls.push(options);
        if (stop) await stop();
        if (options.path) await writeFile(options.path, "合成单元测试字节，不作为真实 trace");
      },
    },
  });
  const trace = new TraceSession(root, run, context as unknown as BrowserContext);
  return {
    root,
    run,
    trace,
    calls,
    navigate: () => {
      url = "https://login.example.invalid/?token=不保存";
      page.emit("framenavigated");
    },
    subframe: () => page.emit("framenavigated", {}),
  };
}
test("敏感默认不启动；启动中的敏感转场丢弃整段且不保存 ZIP", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const first = await fixture();
  const active = await fixture(() => gate);
  try {
    assert.equal((await first.trace.start()).status, "blocked");
    assert.equal(first.calls.length, 0);
    const starting = active.trace.start("safe-synthetic");
    await new Promise((done) => setImmediate(done));
    active.navigate();
    release();
    await starting;
    await active.trace.stop();
    assert.equal(active.trace.summary().status, "blocked");
    assert.deepEqual(active.calls, [{}]);
    assert.equal(
      (await readdir(runHome(active.root, active.run.runId))).some((name) => name.endsWith(".zip")),
      false,
    );
    const manifest = await readEvidence(active.root, active.run.runId);
    assert.ok(
      manifest.artifacts.some((item) => item.kind === "trace" && item.status === "blocked"),
    );
  } finally {
    release();
    await rm(first.root, { recursive: true, force: true });
    await rm(active.root, { recursive: true, force: true });
  }
});
test("并发停止只产生一份证据，采集失败不覆盖原断言失败", async () => {
  const available = await fixture();
  const failed = await fixture(undefined, async () => {
    throw new Error("不保留原始敏感异常");
  });
  try {
    await available.trace.start("safe-synthetic");
    await Promise.all([available.trace.stop(), available.trace.stop()]);
    assert.equal(available.calls.length, 1);
    assert.equal(available.trace.summary().status, "stopped");
    const original = await recordFailure(failed.root, failed.run.runId, {
      kind: "assertion",
      code: "TEST_ASSERTION_FAILED",
    });
    await failed.trace.start("safe-synthetic");
    assert.equal((await failed.trace.stop()).status, "missing");
    const manifest = await readEvidence(failed.root, failed.run.runId);
    assert.equal(manifest.primaryFailureId, original.id);
    assert.equal(manifest.assertions, "failed");
    assert.ok(
      manifest.artifacts.some(
        (item) => item.kind === "trace" && item.reason === "TRACE_STOP_FAILED",
      ),
    );
  } finally {
    await rm(available.root, { recursive: true, force: true });
    await rm(failed.root, { recursive: true, force: true });
  }
});
test("可信主页面中的子 frame 也使完整 trace 作废，不读取子页面内容", async () => {
  const value = await fixture();
  try {
    await value.trace.start("safe-synthetic");
    value.subframe();
    await value.trace.stop();
    assert.equal(value.trace.summary().status, "blocked");
    assert.deepEqual(value.calls, [{}]);
    assert.equal(
      (await readdir(runHome(value.root, value.run.runId))).some((name) => name.endsWith(".zip")),
      false,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
