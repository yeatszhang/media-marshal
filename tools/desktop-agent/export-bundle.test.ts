import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm, mkdir, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unzipSync, strFromU8 } from "fflate";
import { newSession, runHome } from "./session-store.ts";
import { initializeEvidence, updateEvidence } from "./evidence-store.ts";
import { recordArtifact } from "./evidence-artifacts.ts";
import { exportBundle } from "./export-bundle.ts";
import { gcEvidence, pinEvidence } from "./evidence-retention.ts";
import { RETENTION_MS } from "./storage-meter.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marshal-export-"));
  const run = await newSession(root, {
    scenario: "empty",
    seed: "export",
    mode: "background",
    target: "development",
  });
  await initializeEvidence(root, run);
  return { root, run, home: runHome(root, run.runId) };
}
test("导出仅含所选登记证据，脱敏 JSON；未知图像／敏感配置明确省略而非伪报完整", async () => {
  const { root, run, home } = await fixture();
  try {
    await mkdir(join(home, "data"));
    await writeFile(join(home, "data/business.sqlite"), "真实数据库不可导出");
    await writeFile(
      join(home, "result.json"),
      JSON.stringify({
        cookie: "secret-cookie",
        token: "secret-token",
        requestId: "关联请求",
        file: "/Users/private/example",
      }),
    );
    await writeFile(join(home, "unknown.png"), "无隐私标记的图片");
    await writeFile(join(home, "credentials.json"), '{"opaque":"不可导出配置"}');
    for (const [kind, name] of [
      ["health", "result.json"],
      ["image", "unknown.png"],
      ["log", "credentials.json"],
    ] as const)
      await recordArtifact(root, run.runId, { kind, name, source: "tool", status: "available" });
    const exported = await exportBundle(root, run.runId, { kinds: ["health", "image", "log"] });
    assert.equal(exported.status, "partial");
    assert.equal(exported.complete, false);
    const files = unzipSync(await readFile(exported.path));
    assert.deepEqual(Object.keys(files).sort(), ["files/result.json", "manifest.json"]);
    const contents = Object.values(files).map(strFromU8).join("\n");
    for (const secret of [
      "secret-cookie",
      "secret-token",
      "/Users/private",
      "真实数据库不可导出",
      "不可导出配置",
    ])
      assert.equal(contents.includes(secret), false);
    assert.ok(contents.includes("关联请求"));
    const selected = await exportBundle(root, run.runId, { kinds: ["health"] });
    assert.equal(selected.status, "completed");
    assert.equal(selected.historyComplete, false);
    await updateEvidence(root, run.runId, (v) => {
      v.lifecycle = "closed";
    });
    await pinEvidence(root, run.runId, true);
    await gcEvidence(root, false, {
      now: () => Date.now() + RETENTION_MS + 10000,
      alive: () => false,
    });
    assert.ok(await readFile(exported.path));
    await pinEvidence(root, run.runId, false);
    const gc = await gcEvidence(root, false, {
      now: () => Date.now() + RETENTION_MS + 10000,
      alive: () => false,
    });
    assert.equal(gc.exports.removed.length, 2);
    await assert.rejects(readFile(exported.path), { code: "ENOENT" });
    assert.equal(await readFile(join(home, "data/business.sqlite"), "utf8"), "真实数据库不可导出");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("软链接、硬链接和导出前被篡改的文件不进入包，导出根路径逃逸不写外部", async () => {
  const { root, run, home } = await fixture();
  try {
    await writeFile(join(home, "sample.json"), '{"value":"original"}');
    await recordArtifact(root, run.runId, {
      kind: "health",
      source: "tool",
      status: "available",
      name: "sample.json",
    });
    await writeFile(join(home, "sample.json"), '{"value":"changed-secret"}');
    await symlink(join(home, "sample.json"), join(home, "linked.json"));
    await assert.rejects(
      recordArtifact(root, run.runId, {
        kind: "health",
        source: "tool",
        status: "available",
        name: "linked.json",
      }),
    );
    await link(join(home, "sample.json"), join(home, "hard.json"));
    await recordArtifact(root, run.runId, {
      kind: "health",
      source: "tool",
      status: "available",
      name: "hard.json",
    });
    const exported = await exportBundle(root, run.runId, { kinds: ["health"] });
    assert.equal(exported.status, "partial");
    assert.deepEqual(Object.keys(unzipSync(await readFile(exported.path))), ["manifest.json"]);
    await rm(join(root, "test-results/agent/exports"), { recursive: true });
    const external = await mkdtemp(join(tmpdir(), "marshal-export-outside-"));
    try {
      await symlink(external, join(root, "test-results/agent/exports"));
      await assert.rejects(exportBundle(root, run.runId, { kinds: ["health"] }));
      const { readdir } = await import("node:fs/promises");
      assert.deepEqual(await readdir(external), []);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
