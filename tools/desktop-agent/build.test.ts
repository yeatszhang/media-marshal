import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sourceFingerprint } from "./fingerprint.ts";
import { performBuild, atomicJson, assertBuild, recordBuildFailure, buildStatus } from "./build.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marshal-agent-build-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init"]);
  git([
    "-c",
    "user.name=隔离测试",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "初始化",
  ]);
  await mkdir(join(root, "apps/desktop/src"), { recursive: true });
  await writeFile(join(root, "apps/desktop/src/app.ts"), "export const value = 1;");
  await writeFile(
    join(root, ".gitignore"),
    "test-results/\napps/desktop/out/\napps/desktop/resources/\n",
  );
  const id = randomUUID(),
    dir = join(root, "test-results/agent/builds", id);
  await mkdir(dir, { recursive: true });
  await atomicJson(join(dir, "job.json"), {
    id,
    requestId: randomUUID(),
    target: "development",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const execute = async () => {
    await mkdir(join(root, "apps/desktop/out"), { recursive: true });
    await writeFile(join(root, "apps/desktop/out/app.js"), "compiled fixture");
    for (const name of ["parser", "native-files", "sidecars"]) {
      const path = join(
        root,
        "apps/desktop/resources",
        name,
        `${process.platform}-${process.arch}`,
      );
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "fixture.json"), "{}");
    }
  };
  return { root, id, dir, execute, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("未提交、未跟踪和删除源码改变指纹，输出及证据不参与输入", async () => {
  const f = await fixture();
  try {
    const before = await sourceFingerprint(f.root);
    await f.execute();
    assert.equal((await sourceFingerprint(f.root)).digest, before.digest);
    await writeFile(join(f.root, "apps/desktop/src/new.ts"), "export const added = true;");
    assert.notEqual((await sourceFingerprint(f.root)).digest, before.digest);
    await symlink("../out/app.js", join(f.root, "apps/desktop/src/foreign.ts"));
    await assert.rejects(sourceFingerprint(f.root), /源码不能通过链接/);
  } finally {
    await f.cleanup();
  }
});
test("成功构建清单校验当前源码及产物，跨平台或篡改均拒绝", async () => {
  const f = await fixture();
  try {
    const result = await performBuild(f.root, f.id, async () => f.execute());
    assert.equal(result.status, "completed");
    await assertBuild(f.root, "development");
    const manifestPath = join(f.dir, "manifest.json"),
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await atomicJson(manifestPath, {
      ...manifest,
      source: { ...manifest.source, platform: "foreign" },
    });
    await assert.rejects(assertBuild(f.root, "development"), /不一致/);
    await atomicJson(manifestPath, manifest);
    await writeFile(join(f.root, "apps/desktop/out/app.js"), "tampered");
    await assert.rejects(assertBuild(f.root, "development"), /不一致/);
  } finally {
    await f.cleanup();
  }
});
test("构建期间变化以及修改后恢复原内容均不能发布可信清单", async () => {
  for (const revert of [false, true]) {
    const f = await fixture();
    try {
      await assert.rejects(
        performBuild(f.root, f.id, async () => {
          await f.execute();
          const file = join(f.root, "apps/desktop/src/app.ts");
          const source = await readFile(file, "utf8");
          await writeFile(file, "changed");
          if (revert) await writeFile(file, source);
        }),
        /源码或配置发生变化/,
      );
      await assert.rejects(assertBuild(f.root, "development"), /缺少已完成/);
    } finally {
      await f.cleanup();
    }
  }
});
test("构建失败保留失败结果，写入权冲突不会并发执行", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "test-results/agent/builds/build.lock"), "unknown writer");
    let calls = 0;
    const error = await performBuild(f.root, f.id, async () => {
      calls++;
    }).catch((value) => value);
    assert.equal(error.code, "BUILD_BUSY");
    assert.equal(calls, 0);
    await recordBuildFailure(f.root, f.id, error);
    assert.equal((await buildStatus(f.root, f.id)).status, "blocked");
  } finally {
    await f.cleanup();
  }
});
