import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { newSession, runHome } from "./session-store.ts";
import { initializeEvidence, readEvidence } from "./evidence-store.ts";
import { recordArtifact, recordFailure } from "./evidence-artifacts.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marshal-evidence-"));
  const session = await newSession(root, {
    scenario: "empty",
    seed: "repeat",
    mode: "background",
    target: "development",
  });
  await initializeEvidence(root, session);
  return { root, session, directory: runHome(root, session.runId) };
}
test("证据索引跨进程并发不丢关联，所有未采集类型明确标记，断言默认未运行", async () => {
  const { root, session, directory } = await fixture();
  try {
    const initial = await readEvidence(root, session.runId);
    assert.equal(initial.assertions, "not-run");
    assert.equal(initial.historyComplete, false);
    assert.ok(
      initial.artifacts.every((row) => row.status === "not-run" && row.reason === "NOT_CAPTURED"),
    );
    for (let index = 0; index < 12; index++)
      await writeFile(join(directory, `sample-${index}.json`), JSON.stringify({ index }));
    await Promise.all([
      ...Array.from({ length: 4 }, (_, index) =>
        recordArtifact(root, session.runId, {
          kind: "aria",
          source: "dom",
          status: "available",
          name: `sample-${index}.json`,
          snapshotId: randomUUID(),
        }),
      ),
      ...[4, 8].map((start) =>
        promisify(execFile)(
          process.execPath,
          [
            "--experimental-strip-types",
            "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
            "--input-type=module",
            "-e",
            `import {recordArtifact} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "evidence-artifacts.ts")).href)}; import {randomUUID} from 'node:crypto';for(let index=Number(process.argv[3]);index<Number(process.argv[3])+4;index++)await recordArtifact(process.argv[1],process.argv[2],{kind:'aria',source:'dom',status:'available',name:'sample-'+index+'.json',snapshotId:randomUUID()});`,
            root,
            session.runId,
            String(start),
          ],
          { timeout: 10000 },
        ),
      ),
    ]);
    const manifest = await readEvidence(root, session.runId);
    const available = manifest.artifacts.filter((row) => row.kind === "aria");
    assert.equal(available.length, 12);
    assert.equal(new Set(available.map((row) => row.snapshotId)).size, 12);
    assert.ok(available.every((row) => row.status === "available" && row.sha256 && row.bytes! > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("收集失败不覆盖原断言失败，缺失截图与未执行 trace 独立可查", async () => {
  const { root, session } = await fixture();
  try {
    const original = await recordFailure(root, session.runId, {
      kind: "assertion",
      code: "TEST_ASSERTION_FAILED",
    });
    await recordFailure(root, session.runId, { kind: "collection", code: "GUI_IMAGE_FAILED" });
    await recordArtifact(root, session.runId, {
      kind: "image",
      source: "dom",
      status: "missing",
      reason: "WINDOW_CRASHED",
    });
    const manifest = await readEvidence(root, session.runId);
    assert.equal(manifest.primaryFailureId, original.id);
    assert.equal(manifest.assertions, "failed");
    assert.equal(manifest.failures.length, 2);
    assert.equal(manifest.artifacts.find((row) => row.kind === "image")!.reason, "WINDOW_CRASHED");
    assert.equal(manifest.artifacts.find((row) => row.kind === "trace")!.status, "not-run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("新运行不覆盖旧运行；索引篡改、链接与跨目录登记拒绝", async () => {
  const { root, session, directory } = await fixture();
  try {
    const original = await readFile(join(directory, "manifest.json"), "utf8");
    await assert.rejects(
      initializeEvidence(root, { ...session, options: { ...session.options, seed: "其他场景" } }),
      /身份已被其他实例使用/,
    );
    const next = await newSession(root, session.options);
    await initializeEvidence(root, next);
    assert.notEqual(next.runId, session.runId);
    assert.equal(await readFile(join(directory, "manifest.json"), "utf8"), original);
    await assert.rejects(
      recordArtifact(root, session.runId, {
        kind: "image",
        source: "dom",
        status: "available",
        name: "../其他运行.png",
      }),
      /文件名越界/,
    );
    await writeFile(join(root, "outside.json"), "不应读出");
    await symlink(join(root, "outside.json"), join(directory, "linked.json"));
    await assert.rejects(
      recordArtifact(root, session.runId, {
        kind: "log",
        source: "tool",
        status: "available",
        name: "linked.json",
      }),
      /链接或越界/,
    );
    const changed = JSON.parse(original);
    changed.assertions = "passed";
    await writeFile(join(directory, "manifest.json"), JSON.stringify(changed));
    await assert.rejects(readEvidence(root, session.runId), /摘要无效/);
    await assert.rejects(initializeEvidence(root, session), /摘要无效/);
    assert.equal(
      JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).assertions,
      "passed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
