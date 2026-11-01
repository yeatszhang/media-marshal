import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginEvidence, healthEvidence } from "./evidence-run.ts";
import { captureJson, captureExisting, lifecycleEvidence } from "./evidence-capture.ts";
import { readEvidence } from "./evidence-store.ts";
import { newSession, runHome } from "./session-store.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marshal-runtime-evidence-"));
  const session = await newSession(root, {
    scenario: "empty",
    seed: "runtime",
    mode: "background",
    target: "development",
  });
  await beginEvidence(root, session);
  return { root, session, directory: runHome(root, session.runId) };
}
test("启动失败先记录原失败，后续健康与文件采集失败独立缺失且不标绿", async () => {
  const { root, session } = await fixture();
  try {
    await lifecycleEvidence(root, session, "failed", {
      kind: "startup",
      code: "APPLICATION_START_FAILED",
    });
    const original = (await readEvidence(root, session.runId)).primaryFailureId;
    await healthEvidence(root, session);
    const missing = await captureExisting(
      root,
      session,
      join(runHome(root, session.runId), "missing.json"),
      { kind: "image", source: "dom" },
    );
    assert.equal(missing.status, "missing");
    const manifest = await readEvidence(root, session.runId);
    assert.equal(manifest.primaryFailureId, original);
    assert.equal(manifest.lifecycle, "failed");
    assert.equal(manifest.assertions, "not-run");
    assert.ok(
      manifest.artifacts.some(
        (item) => item.kind === "reproduction" && item.status === "available",
      ),
    );
    assert.ok(
      manifest.artifacts.some((item) => item.kind === "image" && item.status === "missing"),
    );
    assert.ok(
      manifest.artifacts.some(
        (item) => item.kind === "health" && item.reason === "APPLICATION_UNAVAILABLE",
      ),
    );
    assert.ok(manifest.failures.some((item) => item.kind === "collection"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("不同运行及不可写索引不覆盖原失败，越界文件不冒充当前证据", async () => {
  const { root, session, directory } = await fixture();
  try {
    const first = await captureJson(
      root,
      session,
      { kind: "assertion", source: "test" },
      { status: "failed", expected: "固定业务后置条件" },
    );
    assert.equal(first.status, "indexed");
    const original = await readFile(join(directory, first.name!), "utf8");
    const next = await newSession(root, session.options);
    await beginEvidence(root, next);
    await captureJson(root, next, { kind: "assertion", source: "test" }, { status: "passed" });
    assert.equal(await readFile(join(directory, first.name!), "utf8"), original);
    const outside = await captureExisting(root, session, join(root, "outside.json"), {
      kind: "log",
      source: "tool",
    });
    assert.equal(outside.status, "missing");
    const path = join(directory, "manifest.json");
    await writeFile(path, "原损坏证据，保留以排查");
    const result = await captureJson(
      root,
      session,
      { kind: "health", source: "tool" },
      { status: "unavailable" },
    );
    assert.equal(result.status, "missing");
    assert.equal(await readFile(path, "utf8"), "原损坏证据，保留以排查");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
