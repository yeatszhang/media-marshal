import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { createRunDirectory, agentRunHome } from "./paths.ts";
import { initializeEvidence, updateEvidence } from "./evidence-store.ts";
import { captureJson, lifecycleEvidence } from "./evidence-capture.ts";
import { exportCiEvidence } from "./ci-evidence.ts";
import type { RunIdentity } from "./evidence-model.ts";
async function run(root: string, time = new Date().toISOString()) {
  const id = randomUUID(),
    value: RunIdentity = {
      producer: "test",
      sessionId: randomUUID(),
      runId: id,
      profileRunId: id,
      generation: 1,
      createdAt: time,
      options: {
        scenario: "ci-test",
        seed: "synthetic-only",
        mode: "background",
        target: "development",
      },
    };
  await createRunDirectory(root, id);
  await initializeEvidence(root, value);
  await captureJson(
    root,
    value,
    { kind: "assertion", source: "test" },
    { status: "passed", note: "token=synthetic-secret" },
  );
  return value;
}
test("CI 只导出时间范围内的终止运行；活跃、损坏和根链接不会带出资料，缺失证据仍为 partial", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-ci-export-"));
  try {
    const current = await run(root),
      active = await run(root),
      old = await run(root, "2000-01-01T00:00:00.000Z");
    await lifecycleEvidence(root, current, "closed");
    await lifecycleEvidence(root, old, "closed");
    await updateEvidence(root, old.runId, (value) => {
      value.createdAt = old.createdAt;
    });
    const data = join(agentRunHome(root, current.runId), "data");
    await mkdir(data);
    await writeFile(join(data, "credentials.json"), '{"private":"sensitive-private-profile"}');
    const foreign = join(root, "foreign"),
      linked = randomUUID();
    await mkdir(foreign);
    await writeFile(join(foreign, "manifest.json"), '{"private":"foreign-private-content"}');
    await symlink(foreign, agentRunHome(root, linked));
    const result = await exportCiEvidence(root, "2020-01-01T00:00:00.000Z");
    assert.equal(result.exported.length, 1);
    assert.equal(result.exported[0]!.runId, current.runId);
    assert.equal(result.exported[0]!.status, "partial");
    assert.ok(
      result.skipped.some(
        (value) => value.runId === active.runId && value.reason === "CI_RUN_NOT_TERMINAL",
      ),
    );
    assert.ok(
      result.skipped.some(
        (value) => value.runId === linked && value.reason === "CI_MANIFEST_UNTRUSTED",
      ),
    );
    assert.equal(result.rawProfilesUploaded, false);
    const files = unzipSync(await readFile(result.exported[0]!.path!));
    const text = Object.values(files)
      .map((value) => strFromU8(value))
      .join("\n");
    assert.doesNotMatch(text, /synthetic-secret|sensitive-private-profile|foreign-private-content/);
    assert.equal(
      await readFile(join(data, "credentials.json"), "utf8"),
      '{"private":"sensitive-private-profile"}',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
