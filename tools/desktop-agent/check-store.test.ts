import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRunDirectory } from "./paths.ts";
import {
  saveCheck,
  readCheck,
  checkStatus,
  checkPath,
  knownCheckStatus,
  type CheckJob,
} from "./check-store.ts";
import { evidenceWriter } from "./evidence-owner.ts";
test("检查作业只接受自有身份，活跃／丢失 worker 分开报告，损坏和链接不能冒充成功", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-check-store-")),
    id = randomUUID();
  try {
    const directory = await createRunDirectory(root, id);
    const job: CheckJob = {
      format: 1,
      id,
      kind: "fault",
      sessionId: randomUUID(),
      requestId: randomUUID(),
      fault: "http-timeout",
      seed: "same",
      repeat: 2,
      buildId: "a".repeat(64),
      createdAt: new Date().toISOString(),
      status: "running",
    };
    await saveCheck(root, job);
    await writeFile(join(directory, "check-worker.json"), JSON.stringify(evidenceWriter()));
    assert.equal((await checkStatus(root, id)).status, "running");
    await writeFile(
      join(directory, "check-worker.json"),
      JSON.stringify({ ...evidenceWriter(), created: "不同代际" }),
    );
    const lost = await checkStatus(root, id);
    assert.equal(lost.status, "unknown");
    assert.equal(lost.jobId, id);
    assert.equal((await readCheck(root, id)).status, "running");
    assert.equal(await knownCheckStatus(root, randomUUID()), undefined);
    await writeFile(
      checkPath(root, id),
      JSON.stringify({ ...job, id: randomUUID(), status: "completed" }),
    );
    await assert.rejects(knownCheckStatus(root, id), { code: "CHECK_JOB_INVALID" });
    await unlink(checkPath(root, id));
    const external = join(root, "external.json");
    await writeFile(external, JSON.stringify({ ...job, status: "completed" }));
    await symlink(external, checkPath(root, id));
    await assert.rejects(knownCheckStatus(root, id), { code: "EVIDENCE_PATH_REJECTED" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
