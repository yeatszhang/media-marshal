import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRun } from "./test-result-evidence.ts";
import { readEvidence, lockEvidenceWriter } from "./evidence-store.ts";
import { recordTestActions } from "./evidence-actions.ts";
test("外部未知锁仍超时且保留原件，失败后本进程队列可以恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-actions-external-lock-"));
  const path = join(root, ".actions.lock");
  try {
    await writeFile(path, "未知写入者");
    await assert.rejects(lockEvidenceWriter(root, ".actions.lock"), {
      code: "EVIDENCE_WRITER_UNKNOWN",
    });
    assert.equal(await readFile(path, "utf8"), "未知写入者");
    await unlink(path);
    const unlock = await lockEvidenceWriter(root, ".actions.lock");
    await unlock();
    await unlock();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("同进程已知写入者排队超过外部锁期限仍能接续，不误报未知写入者", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-actions-queue-"));
  let unlock: (() => Promise<void>) | undefined;
  try {
    unlock = await lockEvidenceWriter(root, ".actions.lock");
    const pending = lockEvidenceWriter(root, ".actions.lock");
    const result = pending.then(
      (release) => ({ release }),
      (error: unknown) => ({ error }),
    );
    await new Promise((done) => setTimeout(done, 1100));
    await unlock();
    unlock = undefined;
    const value = await result;
    if ("error" in value) throw value.error;
    await value.release();
  } finally {
    await unlock?.();
    await rm(root, { recursive: true, force: true });
  }
});
test("动作 JSONL 并发追加不丢失；容量和链接拒绝且不覆盖旧文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-actions-evidence-"));
  const run = await testRun(root, "动作摘要");
  const path = join(root, "test-results/agent", run.runId, "actions.jsonl");
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        recordTestActions(root, run.runId, {
          testId: String(index),
          apiSteps: 2,
          failedSteps: 0,
          truncated: false,
        }),
      ),
    );
    assert.ok(results.every((value) => value.status === "indexed"));
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(new Set(records.map((value) => value.testId)).size, 12);
    assert.ok(
      records.every((value) => value.inputValuesRecorded === false && value.runId === run.runId),
    );
    const manifest = await readEvidence(root, run.runId);
    assert.ok(
      manifest.artifacts.some(
        (value) =>
          value.kind === "action" && value.name === "actions.jsonl" && value.status === "available",
      ),
    );
    await writeFile(path, "x".repeat(2 * 1024 * 1024));
    assert.equal(
      (
        await recordTestActions(root, run.runId, {
          testId: "full",
          apiSteps: 1,
          failedSteps: 0,
          truncated: false,
        })
      ).status,
      "missing",
    );
    assert.equal((await readFile(path)).length, 2 * 1024 * 1024);
    if (process.platform !== "win32") {
      await unlink(path);
      const outside = join(root, "outside.jsonl");
      await writeFile(outside, "不得修改");
      await symlink(outside, path);
      assert.equal(
        (
          await recordTestActions(root, run.runId, {
            testId: "link",
            apiSteps: 1,
            failedSteps: 0,
            truncated: false,
          })
        ).status,
        "missing",
      );
      assert.equal(await readFile(outside, "utf8"), "不得修改");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
