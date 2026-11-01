import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile, symlink, unlink } from "node:fs/promises";
import { closeGui, setupGui, guiRoot as root } from "./gui-test-support.ts";
import { nativeTarget, invokeNative, type NativeRequest } from "./native-runtime.ts";
import { runHome, saveSession } from "./session-store.ts";
import { execFileSync } from "node:child_process";
import { assertNativeHelper } from "./native-fingerprint.ts";

test(
  "macOS 原生窗口捕获及身份、代际、面板、路径和旧快照拒绝",
  {
    timeout: 90000,
    skip: process.platform !== "darwin",
  },
  async (test) => {
    const context = await setupGui("foreground");
    const directory = runHome(root, context.session.runId);
    const identity = await nativeTarget(root, context.session, context.gui.windows);
    const observe = () => invokeNative(root, { ...identity, command: "observe" });
    try {
      const initial = await observe();
      assert.ok(initial.nodes.length > 5);
      assert.match(initial.fingerprint, /^[a-f0-9]{64}$/);
      if (
        await lockedSession(
          test,
          { ...identity, command: "observe" },
          initial.fingerprint,
          directory,
          context.session.runId,
        )
      )
        return;
      await invokeNative(root, {
        ...identity,
        command: "activate",
        fingerprint: initial.fingerprint,
      });
      await context.page.getByRole("link", { name: "设置", exact: true }).click();
      await context.page.getByRole("heading", { name: "设置", exact: true }).waitFor();
      const observed = await observe();
      const main = (await context.gui.windows.list())[0]!;
      const candidates = observed.windows.filter(
        (window: { bounds: { X: number; Y: number; Width: number; Height: number } }) =>
          Math.abs(window.bounds.X - main.bounds.x) < 1 &&
          Math.abs(window.bounds.Y - main.bounds.y) < 1 &&
          Math.abs(window.bounds.Width - main.bounds.width) < 1 &&
          Math.abs(window.bounds.Height - main.bounds.height) < 1,
      );
      assert.equal(candidates.length, 1);
      const windowID: number = candidates[0].id;
      const output = join(directory, `native-${randomUUID()}.png`);
      const capture = {
        ...identity,
        command: "capture" as const,
        windowID,
        fingerprint: observed.fingerprint,
        output,
      };
      await rejectedTargets(capture, directory);
      const current = await observe();
      const image = await invokeNative(root, { ...capture, fingerprint: current.fingerprint });
      assert.equal(image.source, "native");
      assert.equal(image.generation, identity.generation);
      assert.equal(image.fingerprint, current.fingerprint);
      const bytes = await readFile(output);
      assert.equal(bytes.subarray(1, 4).toString(), "PNG");
      assert.ok(bytes.length > 10000);
      assert.ok(image.width >= main.bounds.width);
      const proof = {
        source: "native",
        status: "passed",
        sessionId: context.session.sessionId,
        runId: context.session.runId,
        buildId: context.session.buildId,
        identity: { pid: identity.pid, generation: identity.generation },
        observed: current,
        image: { ...image, sha256: createHash("sha256").update(bytes).digest("hex") },
        negativeAssertions: [
          "wrong-pid",
          "wrong-generation",
          "stale-snapshot",
          "unknown-window",
          "outside-output",
          "symlink-output",
        ],
      };
      await writeFile(join(directory, "native-validation.json"), JSON.stringify(proof, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      console.log(
        JSON.stringify({
          runId: context.session.runId,
          image: output,
          width: image.width,
          height: image.height,
        }),
      );
    } finally {
      await closeGui(context);
    }
  },
);

async function rejectedTargets(capture: NativeRequest, directory: string) {
  await assert.rejects(invokeNative(root, { ...capture, generation: "0:0" }), {
    code: "GENERATION_MISMATCH",
  });
  await assert.rejects(invokeNative(root, { ...capture, fingerprint: "0".repeat(64) }), {
    code: "STALE_SNAPSHOT",
  });
  await assert.rejects(invokeNative(root, { ...capture, windowID: 0xffffffff }), {
    code: "WINDOW_MISMATCH",
  });
  await assert.rejects(
    invokeNative(root, { ...capture, command: "observe", pid: process.pid }),
    (error: unknown) =>
      ["PROCESS_MISMATCH", "PROCESS_UNAVAILABLE"].includes((error as { code: string }).code),
  );
  await assert.rejects(invokeNative(root, { ...capture, output: "/tmp/marshal-forbidden.png" }), {
    code: "AGENT_PATH_REJECTED",
  });
  const link = join(directory, "linked-output");
  await symlink(directory, link);
  try {
    await assert.rejects(invokeNative(root, { ...capture, output: join(link, "capture.png") }), {
      code: "AGENT_PATH_REJECTED",
    });
  } finally {
    await unlink(link);
  }
}

async function lockedSession(
  test: TestContext,
  identity: NativeRequest,
  fingerprint: string,
  directory: string,
  runId: string,
) {
  const capabilities = JSON.parse(
    execFileSync(await assertNativeHelper(root), ["capabilities"], {
      encoding: "utf8",
      timeout: 5000,
    }),
  );
  if (capabilities.sessionLocked) {
    await assert.rejects(
      invokeNative(root, {
        ...identity,
        command: "activate",
        fingerprint,
      }),
      { code: "NATIVE_SESSION_LOCKED" },
    );
    await writeFile(
      join(directory, "native-validation.json"),
      JSON.stringify({
        source: "native",
        status: "blocked",
        reason: "NATIVE_SESSION_LOCKED",
        runId,
        capabilities,
        positiveAssertions: "not-run",
      }),
      { mode: 0o600, flag: "wx" },
    );
    test.skip("锁屏拒绝已验证；原生捕获正例与其余前台断言未运行");
    return true;
  }

  return false;
}
