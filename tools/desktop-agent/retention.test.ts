import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  readdir,
  link,
  symlink,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSession, runHome } from "./session-store.ts";
import { initializeEvidence, readEvidence, updateEvidence } from "./evidence-store.ts";
import { captureJson } from "./evidence-capture.ts";
import { recordArtifact, recordFailure } from "./evidence-artifacts.ts";
import { pinEvidence, gcEvidence } from "./evidence-retention.ts";
import { reserveEvidence } from "./storage-reservation.ts";
import { EVIDENCE_BUDGET, RETENTION_MS } from "./storage-meter.ts";
import { writeEvidenceJson } from "./evidence-write.ts";
const future = () => Date.now() + RETENTION_MS + 10000;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marshal-retention-"));
  const run = await newSession(root, {
    scenario: "empty",
    seed: "retention",
    mode: "background",
    target: "development",
  });
  await initializeEvidence(root, run);
  const capture = await captureJson(root, run, { kind: "health", source: "tool" }, { ready: true });
  assert.equal(capture.status, "indexed");
  await updateEvidence(root, run.runId, (v) => {
    v.lifecycle = "closed";
  });
  return {
    root,
    run,
    path: join(runHome(root, run.runId), "name" in capture ? capture.name! : "unexpected"),
  };
}
test("七天回收只删登记文件，保留 userData、未登记文件和原索引；dry-run 不改内容", async () => {
  const { root, run, path } = await fixture();
  try {
    const home = runHome(root, run.runId);
    await mkdir(join(home, "data"));
    await writeFile(join(home, "data/business.sqlite"), "持久资料");
    await writeFile(join(home, "unknown.json"), "未知所有权");
    const before = await readFile(join(home, "manifest.json"), "utf8");
    const policy = { now: future, alive: () => false };
    const planned = await gcEvidence(root, true, policy);
    assert.equal(planned.status, "planned");
    assert.ok(planned.projectedBytes < planned.beforeBytes);
    assert.equal(await readFile(join(home, "manifest.json"), "utf8"), before);
    assert.ok(await readFile(path));
    const result = await gcEvidence(root, false, policy);
    assert.equal(result.runtimeDataDeleted, false);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    assert.equal(await readFile(join(home, "data/business.sqlite"), "utf8"), "持久资料");
    assert.equal(await readFile(join(home, "unknown.json"), "utf8"), "未知所有权");
    const manifest = await readEvidence(root, run.runId);
    assert.ok(manifest.retention?.reclaimedAt);
    assert.equal(manifest.artifacts.find((a) => a.kind === "health")?.reason, "EVIDENCE_EXPIRED");
    await assert.rejects(writeEvidenceJson(root, run.runId, "late.json", {}), {
      code: "EVIDENCE_RETIRED",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("失败自动固定，显式解除后才允许回收，原断言失败不会变成成功", async () => {
  const { root, run, path } = await fixture();
  try {
    const primary = await recordFailure(root, run.runId, {
      kind: "assertion",
      code: "TEST_ASSERTION_FAILED",
    });
    await gcEvidence(root, false, { now: future, alive: () => false });
    assert.ok(await readFile(path));
    assert.equal((await readEvidence(root, run.runId)).retention?.pinned, true);
    await pinEvidence(root, run.runId, false);
    await gcEvidence(root, false, { now: future, alive: () => false });
    await assert.rejects(readFile(path), { code: "ENOENT" });
    const retained = await readEvidence(root, run.runId);
    assert.equal(retained.primaryFailureId, primary.id);
    assert.equal(retained.assertions, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("活跃或未知写入者、摘要变更和硬链接不被回收，预算不足明确 blocked", async () => {
  const { root, run, path } = await fixture();
  try {
    await gcEvidence(root, false, { now: future });
    assert.ok(await readFile(path));
    await writeFile(path, "变更后的文件");
    const hard = join(runHome(root, run.runId), "linked.json");
    await link(path, hard);
    await recordArtifact(root, run.runId, {
      kind: "log",
      source: "tool",
      status: "available",
      name: "linked.json",
    });
    const result = await gcEvidence(root, false, { now: future, alive: () => false, maxBytes: 1 });
    assert.equal(result.status, "blocked");
    assert.equal(await readFile(path, "utf8"), "变更后的文件");
    assert.ok(await readFile(hard));
    const leases = join(runHome(root, run.runId), ".leases");
    await writeFile(join(leases, "unknown"), "未知记录");
    const unknown = await gcEvidence(root, false, { now: future, alive: () => false });
    assert.ok(unknown.protectedRuns.length);
    await symlink(path, join(root, "test-results/agent/11111111-1111-4111-8111-111111111111"));
    assert.equal((await gcEvidence(root, true, { now: future })).status, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("容量预留互斥，GC 不丢活跃预留；真实 500 MiB 上限阻止新增采集并保留原失败", async () => {
  const { root, run } = await fixture();
  try {
    const release = await reserveEvidence(root, run.runId, 60000, { maxBytes: 100000 });
    await assert.rejects(reserveEvidence(root, run.runId, 60000, { maxBytes: 100000 }), {
      code: "EVIDENCE_CAPACITY_EXHAUSTED",
    });
    await gcEvidence(root, false);
    await assert.rejects(reserveEvidence(root, run.runId, 60000, { maxBytes: 100000 }), {
      code: "EVIDENCE_CAPACITY_EXHAUSTED",
    });
    await release();
    const file = await open(join(runHome(root, run.runId), "unregistered-large.bin"), "wx");
    try {
      await file.truncate(EVIDENCE_BUDGET);
    } finally {
      await file.close();
    }
    await gcEvidence(root, false); // 使容量缓存失效，不删除未登记文件。
    const failure = await recordFailure(root, run.runId, {
      kind: "assertion",
      code: "ORIGINAL_FAILURE",
    });
    const capture = await captureJson(
      root,
      run,
      { kind: "health", source: "tool" },
      { shouldNotBeWritten: true },
    );
    assert.deepEqual(capture, { status: "missing", reason: "EVIDENCE_CAPACITY_EXHAUSTED" });
    assert.equal((await readEvidence(root, run.runId)).primaryFailureId, failure.id);
    assert.equal(
      (await readdir(runHome(root, run.runId))).filter((n) => n.startsWith("health-")).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
