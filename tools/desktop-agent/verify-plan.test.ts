import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { verificationPlan, type VerificationChanges } from "./verify-plan.ts";
import { verificationChanges } from "./verify-changes.ts";
import { verifyChecks } from "./verify-catalog.ts";
import { parseRequest } from "./protocol.ts";
const changes = (files: string[], truncated = false): VerificationChanges => ({
  files,
  truncated,
  baseCommit: "b".repeat(40),
  headCommit: "c".repeat(40),
  standardsFiles: files.filter((f) => f.includes(".test.")),
});
const ids = (files: string[]) => verificationPlan(changes(files)).checks.map((check) => check.id);
test("未知路径／截断回退桌面全量，共享契约扩大范围，纯文档不默认跑媒体业务", () => {
  for (const plan of [
    verificationPlan(changes(["new-service/main.rs"])),
    verificationPlan(changes([], true)),
    verificationPlan(changes(["packages/contracts/src/index.ts"])),
  ]) {
    assert.deepEqual(
      plan.checks.map((check) => check.id),
      verifyChecks,
    );
    assert.equal(plan.businessScope, "all");
    assert.ok(plan.checks.every((check) => check.reasons.length > 0));
    assert.deepEqual(plan.requiredBuilds, ["development", "packaged"]);
  }
  assert.deepEqual(ids(["notes/design.md"]), ["docs"]);
  assert.deepEqual(ids(["openspec/changes/example/tasks.md"]), ["docs", "specs"]);
  assert.equal(
    ids([".agents/skills/desktop-development-loop/SKILL.md"]).includes("business"),
    false,
  );
  assert.ok(ids(["tools/desktop-agent/native/Helper.swift"]).includes("native"));
  assert.equal(
    verificationPlan(changes(["apps/desktop/src/renderer/src/App.tsx"])).businessScope,
    "renderer",
  );
  assert.equal(
    verificationPlan(changes(["packages/media-core/src/ingestion/a.ts"])).businessScope,
    "core",
  );
  assert.equal(
    verificationPlan(
      changes(["packages/media-core/src/a.ts", "apps/desktop/src/renderer/src/App.tsx"]),
    ).businessScope,
    "all",
  );
});
test("计划及推荐项始终未执行，标准差异不被自动当作等价或接受新基线", () => {
  const plan = verificationPlan(
    changes(["apps/desktop/src/renderer/src/App.tsx", "apps/desktop/src/renderer/src/a.test.ts"]),
  );
  assert.equal(plan.status, "planned");
  assert.equal(plan.execution, "not-run");
  assert.equal(plan.allPlannedChecksPassed, false);
  assert.ok(plan.checks.every((check) => check.status === "not-run"));
  assert.equal(plan.standards.semanticEquivalence, "unverified");
  assert.equal(plan.standards.automaticBaselineAcceptance, false);
  assert.equal(plan.recommendations[0]?.status, "not-run");
  assert.equal(verificationPlan(changes([])).checks.length, 0);
  assert.ok(verificationPlan(changes([]), true).checks.some((check) => check.id === "benchmark"));
  for (const path of ["", "/private", "C:\\private", "..\\private", "a/./b", "a\0b"])
    assert.throws(() => parseRequest({ command: "verify", payload: { changedFiles: [path] } }), {
      code: "INVALID_INPUT",
    });
  assert.throws(() => parseRequest({ command: "verify", payload: { baseRef: "--exec=private" } }), {
    code: "INVALID_INPUT",
  });
});
test("实际 Git 差异包含暂存／未暂存、改名前后和未跟踪文件，提示不能隐藏真实业务修改", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-verify-diff-"));
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    git(["init", "--initial-branch=main"]);
    await mkdir(join(root, "packages/media-core/src"), { recursive: true });
    await mkdir(join(root, "docs"));
    await writeFile(join(root, ".gitignore"), ".env\n");
    await writeFile(join(root, "packages/media-core/src/a.ts"), "export const value=1;\n");
    await writeFile(join(root, "docs/old.md"), "原文档\n");
    git(["add", "."]);
    git([
      "-c",
      "user.name=隔离验证",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "隔离基点",
    ]);
    git(["mv", "docs/old.md", "docs/new.md"]);
    await writeFile(join(root, "packages/media-core/src/a.ts"), "export const value=2;\n");
    await writeFile(join(root, "new.test.ts"), "// 新断言入口\n");
    await writeFile(join(root, ".env"), "private-not-read\n");
    const diff = verificationChanges(root, "HEAD", ["docs/hint.md"]);
    assert.deepEqual(diff.files, [
      "docs/hint.md",
      "docs/new.md",
      "docs/old.md",
      "new.test.ts",
      "packages/media-core/src/a.ts",
    ]);
    assert.deepEqual(diff.standardsFiles, ["new.test.ts"]);
    assert.ok(verificationPlan(diff).checks.some((check) => check.id === "business"));
    assert.throws(() => verificationChanges(root, "missing-ref"), {
      code: "VERIFY_BASE_UNAVAILABLE",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
