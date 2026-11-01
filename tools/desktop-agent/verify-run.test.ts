import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startVerification } from "./verify-start.ts";
import { performVerification } from "./verify-run.ts";
import { verificationStatus } from "./verify-store.ts";
import { parseRequest } from "./protocol.ts";
import { readEvidence } from "./evidence-store.ts";
import { verificationChanges } from "./verify-changes.ts";
import { verificationSource } from "./verify-source.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marshal-verify-run-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      stdio: "ignore",
    });
  git("init", "--initial-branch=main");
  await mkdir(join(root, "docs"));
  await writeFile(join(root, ".gitignore"), "test-results/\n");
  await writeFile(join(root, "docs/a.md"), "原文档\n");
  git("add", ".");
  git(
    "-c",
    "user.name=隔离验证",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "隔离基点",
  );
  return {
    root,
    git,
    changed: () => writeFile(join(root, "docs/a.md"), "更新文档\n"),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
test("验证收据可续查，不重放同请求；变参拒绝，完成证据保留且未知 worker 不标绿", async () => {
  const context = await fixture();
  try {
    await context.changed();
    const request = parseRequest({ command: "verify", payload: { mode: "run" } });
    let launches = 0,
      executions = 0;
    const launch = async () => {
      launches++;
    };
    const job = await startVerification(context.root, request, launch);
    const repeat = await startVerification(context.root, request, launch);
    assert.equal(repeat.id, job.id);
    assert.equal(launches, 1);
    await assert.rejects(
      startVerification(
        context.root,
        parseRequest({ ...request, payload: { mode: "run", benchmark: true } }),
        launch,
      ),
      { code: "REQUEST_CONFLICT" },
    );
    const done = await performVerification(context.root, job.id, async () => {
      executions++;
      return { status: "passed" };
    });
    assert.equal(done.status, "completed");
    assert.equal(executions, 1);
    assert.equal((await readEvidence(context.root, job.id)).assertions, "passed");
    const before = await readFile(
      join(context.root, "test-results/agent", job.id, "manifest.json"),
    );
    assert.equal((await startVerification(context.root, request, launch)).status, "completed");
    await assert.rejects(performVerification(context.root, job.id), {
      code: "VERIFY_ALREADY_SETTLED",
    });
    assert.deepEqual(
      await readFile(join(context.root, "test-results/agent", job.id, "manifest.json")),
      before,
    );
    const running = await startVerification(
      context.root,
      parseRequest({ command: "verify", payload: { mode: "run" } }),
      launch,
    );
    const path = join(context.root, "test-results/agent", running.id, "verify-job.json");
    const value = JSON.parse(await readFile(path, "utf8"));
    value.createdAt = "2000-01-01T00:00:00.000Z";
    await writeFile(path, JSON.stringify(value));
    assert.equal((await verificationStatus(context.root, running.id)).status, "unknown");
  } finally {
    await context.dispose();
  }
});
test("工作区恢复 HEAD 仍核对暂存路径；只变更 index 内容也会使验证身份变化", async () => {
  const context = await fixture();
  try {
    await context.changed();
    context.git("add", "docs/a.md");
    await writeFile(join(context.root, "docs/a.md"), "原文档\n");
    assert.ok(verificationChanges(context.root, "HEAD").files.includes("docs/a.md"));
    const input = parseRequest({ command: "verify" })
      .payload as import("./protocol.ts").Input<"verify">;
    const before = await verificationSource(context.root, input);
    const hash = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: context.root,
      input: "另一暂存版本\n",
      encoding: "utf8",
    }).trim();
    context.git("update-index", "--cacheinfo", `100644,${hash},docs/a.md`);
    assert.equal(await readFile(join(context.root, "docs/a.md"), "utf8"), "原文档\n");
    assert.notEqual((await verificationSource(context.root, input)).digest, before.digest);
  } finally {
    await context.dispose();
  }
});
test("验证期间文档／断言变化阻止通过，原失败优先；空计划及跳过不能通过", async () => {
  const context = await fixture();
  const start = () =>
    startVerification(
      context.root,
      parseRequest({ command: "verify", payload: { mode: "run" } }),
      async () => {},
    );
  try {
    assert.equal(
      (
        await performVerification(context.root, (await start()).id, async () => ({
          status: "passed",
        }))
      ).status,
      "blocked",
    );
    await context.changed();
    const source = await start();
    const changed = await performVerification(context.root, source.id, async () => {
      await writeFile(join(context.root, "docs/a.md"), "运行期间修改\n");
      return { status: "passed" };
    });
    assert.equal(changed.status, "unknown");
    assert.equal(
      (changed.result as { allPlannedChecksPassed: boolean }).allPlannedChecksPassed,
      false,
    );
    const failure = await start();
    const failed = await performVerification(context.root, failure.id, async () => {
      await writeFile(join(context.root, "docs/a.md"), "失败后修改\n");
      return { status: "failed" };
    });
    assert.equal(failed.status, "failed");
    assert.equal((await readEvidence(context.root, failed.id)).assertions, "failed");
    assert.equal((await readEvidence(context.root, failed.id)).retention?.pinned, true);
    const skipped = await performVerification(context.root, (await start()).id, async () => ({
      status: "blocked",
      reason: "VERIFY_TESTS_SKIPPED",
    }));
    assert.equal(skipped.status, "blocked");
  } finally {
    await context.dispose();
  }
});
test("受理后源码变化与启动失败明确受阻，不执行并保留请求结果", async () => {
  const context = await fixture();
  try {
    await context.changed();
    const request = parseRequest({ command: "verify", payload: { mode: "run" } });
    const job = await startVerification(context.root, request, async () => {});
    await writeFile(join(context.root, "docs/a.md"), "受理后改动\n");
    let called = false;
    const blocked = await performVerification(context.root, job.id, async () => {
      called = true;
      return { status: "passed" };
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(called, false);
    const failed = await startVerification(
      context.root,
      parseRequest({ command: "verify", payload: { mode: "run" } }),
      async () => {
        throw new Error("不能回显的敏感错误");
      },
    );
    assert.equal(failed.status, "unknown");
    assert.doesNotMatch(JSON.stringify(failed), /不能回显/);
  } finally {
    await context.dispose();
  }
});
