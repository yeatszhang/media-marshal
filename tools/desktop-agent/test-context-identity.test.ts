import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestInfo } from "@playwright/test";
import { contextIdentity } from "./test-context-identity.ts";
import { createRunDirectory } from "./paths.ts";
import { randomUUID } from "node:crypto";
test("测试运行不复用身份；运行根链接被拒绝且不在外部创建内容", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-test-context-"));
  const outside = await mkdtemp(join(tmpdir(), "marshal-context-outside-"));
  const info = {
    testId: "fixture",
    file: join(root, "fixture.spec.ts"),
    annotations: [],
  } as unknown as TestInfo;
  try {
    const options = { args: [`--user-data-dir=${join(root, "test-results/profile")}`] };
    const run = await contextIdentity(root, info, options);
    assert.equal(run.producer, "test");
    assert.equal(run.options.scenario, "test-fixture");
    const path = join(root, "test-results/agent", run.runId, "manifest.json");
    const original = await readFile(path, "utf8");
    await assert.rejects(
      contextIdentity(root, info, {
        ...options,
        env: { MARSHAL_AGENT_SESSION_ID: run.sessionId, MARSHAL_AGENT_RUN_ID: run.runId },
      }),
      { code: "EVIDENCE_RUN_REUSED" },
    );
    assert.equal(await readFile(path, "utf8"), original);
    if (process.platform !== "win32") {
      const linked = await mkdtemp(join(tmpdir(), "marshal-context-link-"));
      try {
        await symlink(outside, join(linked, "test-results"));
        await assert.rejects(createRunDirectory(linked, randomUUID()), {
          code: "EVIDENCE_PATH_REJECTED",
        });
        assert.deepEqual(await readdir(outside), []);
      } finally {
        await rm(linked, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
