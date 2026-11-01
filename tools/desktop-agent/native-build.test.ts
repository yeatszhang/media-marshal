import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeBuildRecord, nativeInputs, assertNativeHelper } from "./native-fingerprint.ts";
import { invokeNative } from "./native-runtime.ts";
test("原生清单绑定源码、构建器和二进制，篡改、跨平台与链接拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-native-build-"));
  try {
    const directory = join(root, "tools/desktop-agent");
    await mkdir(join(directory, "native"), { recursive: true });
    await mkdir(join(directory, ".build"));
    await writeFile(join(directory, "native/Helper.swift"), "合成源码");
    await writeFile(join(directory, "native-build.mjs"), "合成构建器");
    await writeFile(join(directory, ".build/native-helper"), "合成二进制，不执行");
    const record = await nativeBuildRecord(root);
    await writeFile(join(directory, ".build/native-manifest.json"), JSON.stringify(record));
    assert.equal(
      await assertNativeHelper(root, "darwin"),
      resolve(directory, ".build/native-helper"),
    );
    const before = await nativeInputs(root);
    await writeFile(join(directory, "native/Helper.swift"), "变化源码");
    await assert.rejects(assertNativeHelper(root, "darwin"), /与源码/);
    await writeFile(join(directory, "native/Helper.swift"), "合成源码");
    const restored = await nativeInputs(root);
    assert.equal(before.source, restored.source);
    assert.notEqual(before.observation, restored.observation);
    await assert.rejects(assertNativeHelper(root, "win32"), /仅支持 macOS/);
    await writeFile(
      join(directory, ".build/native-manifest.json"),
      JSON.stringify({ ...record, createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    await assert.rejects(assertNativeHelper(root, "darwin"), /摘要无效/);
    await writeFile(join(directory, ".build/native-manifest.json"), JSON.stringify(record));
    await rm(join(directory, "native/Helper.swift"));
    await writeFile(join(root, "outside.swift"), "外部源码");
    await symlink(join(root, "outside.swift"), join(directory, "native/Helper.swift"));
    await assert.rejects(nativeInputs(root), /普通文件/);
    await assert.rejects(invokeNative(root, { command: "脚本执行" } as never), /受限协议/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test(
  "同一 Swift 权限与路径策略覆盖缺权限、越界及链接，不修改系统授权",
  { skip: process.platform !== "darwin" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "marshal-native-policy-"));
    try {
      const root = resolve(import.meta.dirname, "../..");
      const binary = join(directory, "checks");
      const execute = promisify(execFile);
      await execute(
        "xcrun",
        [
          "swiftc",
          "-parse-as-library",
          join(root, "tools/desktop-agent/native/Errors.swift"),
          join(root, "tools/desktop-agent/native/Permissions.swift"),
          join(root, "tools/desktop-agent/native/Paths.swift"),
          join(root, "tools/desktop-agent/native/Scope.swift"),
          join(root, "tools/desktop-agent/native/tests/PermissionsMain.swift"),
          "-o",
          binary,
        ],
        { timeout: 20000 },
      );
      const result = JSON.parse((await execute(binary, [], { timeout: 5000 })).stdout);
      assert.deepEqual(result.rejected, ["ACCESSIBILITY_REQUIRED", "SCREEN_PERMISSION_REQUIRED"]);
      assert.equal(result.nonImageWithoutRecording, true);
      assert.equal(result.authorizedImage, true);
      assert.deepEqual(result.ownersRejected, Array(3).fill("PANEL_OWNER_UNKNOWN"));
      assert.deepEqual(result.pathsRejected, [
        "AGENT_PATH_REJECTED",
        "OUTPUT_REJECTED",
        "AGENT_PATH_REJECTED",
        "AGENT_PATH_REJECTED",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
