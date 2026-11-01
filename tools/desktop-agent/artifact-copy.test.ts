import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, cp, rm, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { artifactFingerprint, identityHash } from "./fingerprint.ts";
import { assertPackagedCopy } from "./artifact-copy.ts";
test("目录包副本核对完整集合、内容、主程序与内部链接，不把旧包当当前构建", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "marshal-copy-")));
  const relative =
    process.platform === "darwin"
      ? `apps/desktop/release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/Media Marshal.app`
      : "apps/desktop/release/win-unpacked";
  const binary =
    process.platform === "darwin" ? "Contents/MacOS/Media Marshal" : "Media Marshal.exe";
  const resource =
    process.platform === "darwin" ? "Contents/Resources/app.asar" : "resources/app.asar";
  const bundle = join(root, relative),
    copy = join(root, "copied-app");
  try {
    await mkdir(join(bundle, process.platform === "darwin" ? "Contents/MacOS" : "resources"), {
      recursive: true,
    });
    await mkdir(join(bundle, process.platform === "darwin" ? "Contents/Resources" : "resources"), {
      recursive: true,
    });
    await writeFile(join(bundle, binary), "合成主程序，不执行", { mode: 0o755 });
    await writeFile(join(bundle, resource), "合成应用资源");
    if (process.platform !== "win32") await symlink(resource, join(bundle, "mirror.asar"));
    const artifact = await artifactFingerprint(root, "packaged");
    const source = {
      digest: identityHash([]),
      observation: identityHash([]),
      files: [],
      commit: "fixture",
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      toolProtocol: 1,
    };
    const manifest = join(root, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        format: 1,
        source,
        artifact,
        buildId: identityHash({ source, artifact }),
        createdAt: new Date().toISOString(),
      }),
    );
    await cp(bundle, copy, { recursive: true, verbatimSymlinks: true });
    await assertPackagedCopy(root, manifest, join(copy, binary));
    await assert.rejects(assertPackagedCopy(root, manifest, join(bundle, "not-the-main-program")), {
      code: "TEST_PACKAGED_TARGET_MISMATCH",
    });
    await writeFile(join(copy, resource), "旧包资源");
    await assert.rejects(assertPackagedCopy(root, manifest, join(copy, binary)), {
      code: "TEST_PACKAGED_TARGET_MISMATCH",
    });
    await writeFile(join(copy, resource), "合成应用资源");
    await writeFile(join(copy, "unexpected.txt"), "额外资源");
    await assert.rejects(assertPackagedCopy(root, manifest, join(copy, binary)), {
      code: "TEST_PACKAGED_TARGET_MISMATCH",
    });
    await unlink(join(copy, "unexpected.txt"));
    if (process.platform !== "win32") {
      await unlink(join(copy, "mirror.asar"));
      await writeFile(join(root, "outside.asar"), "合成应用资源");
      await symlink(join(root, "outside.asar"), join(copy, "mirror.asar"));
      await assert.rejects(assertPackagedCopy(root, manifest, join(copy, binary)), {
        code: "TEST_PACKAGED_TARGET_MISMATCH",
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
