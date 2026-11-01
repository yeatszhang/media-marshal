import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { doctor } from "./doctor.ts";

test("缺失环境只返回诊断和修复命令，不创建资源或业务数据", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-agent-doctor-"));
  try {
    const before = await readdir(root);
    const report = await doctor(root, { native: true });
    assert.equal(report.status, "blocked");
    assert(
      report.checks.some((check) => check.name === "electron-sqlite" && check.status === "blocked"),
    );
    assert(
      report.checks.every(
        (check) => check.status === "ready" || !!check.repair || check.status === "unsupported",
      ),
    );
    assert.deepEqual(await readdir(root), before);
    assert(!JSON.stringify(report).includes(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("资源检查识别正确摘要、错误架构和篡改，不执行被检查的资源", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-agent-resources-"));
  const target = `${process.platform}-${process.arch}`;
  const resource = join(root, "apps/desktop/resources/native-files", target);
  try {
    await mkdir(resource, { recursive: true });
    const binary = Buffer.from("此资源只核对摘要，不执行");
    await mkdir(join(root, "tools/desktop-files"), { recursive: true });
    await writeFile(join(root, "tools/desktop-files/rename-exclusive.c"), "fixture source");
    await writeFile(
      join(root, "apps/desktop/package.json"),
      JSON.stringify({ devDependencies: { electron: "44.9.0" } }),
    );
    const manifest = {
      target,
      napi: 8,
      electronHeaders: "44.9.0",
      source: { sha256: createHash("sha256").update("fixture source").digest("hex") },
      binary: {
        name: "fixture.node",
        size: binary.length,
        sha256: createHash("sha256").update(binary).digest("hex"),
      },
    };
    await writeFile(join(resource, "fixture.node"), binary);
    await writeFile(join(resource, "manifest.json"), JSON.stringify(manifest));
    const check = async () =>
      (await doctor(root, { native: false })).checks.find(
        (check) => check.name === "native-files",
      )!;
    assert.equal((await check()).status, "ready");
    await writeFile(join(resource, "fixture.node"), "修改内容");
    assert.equal((await check()).status, "blocked");
    await writeFile(join(resource, "fixture.node"), binary);
    await writeFile(
      join(resource, "manifest.json"),
      JSON.stringify({ ...manifest, target: "invalid" }),
    );
    assert.equal((await check()).status, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
