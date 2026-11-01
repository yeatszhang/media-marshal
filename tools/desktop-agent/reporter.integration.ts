import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readEvidence } from "./evidence-store.ts";

test(
  "真实 Playwright reporter 保存失败、启动失败与未运行；采集异常不覆盖原断言",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "marshal-reporter-probe-"));
    const root = resolve(import.meta.dirname, "../..");
    try {
      let exitCode = 0,
        stderr = "";
      try {
        await promisify(execFile)(
          process.execPath,
          [
            join(root, "node_modules/@playwright/test/cli.js"),
            "test",
            "--config",
            "tools/desktop-agent/reporter-probe.config.ts",
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              MARSHAL_REPORTER_PROBE: "1",
              MARSHAL_REPORTER_PROBE_ROOT: directory,
            },
            timeout: 25000,
            maxBuffer: 256 * 1024,
          },
        );
      } catch (error) {
        exitCode = Number((error as { code: number }).code);
        stderr = (error as { stderr: string }).stderr;
      }
      assert.equal(exitCode, 1, "失败探针必须保留测试失败退出码");
      assert.ok(stderr.includes("evidence.reporter.collection.failed"));
      const runs = await readdir(join(directory, "test-results/agent"));
      const manifests = await Promise.all(runs.map((id) => readEvidence(directory, id)));
      assert.equal(manifests.length, 5);
      assert.equal(manifests.filter((value) => value.assertions === "failed").length, 2);
      assert.equal(manifests.filter((value) => value.assertions === "passed").length, 1);
      assert.equal(manifests.filter((value) => value.assertions === "blocked").length, 1);
      assert.equal(
        manifests.filter((value) => value.assertions === "not-run" && value.lifecycle === "failed")
          .length,
        1,
      );
      const startup = manifests.find((value) => value.lifecycle === "failed")!;
      assert.equal(
        startup.failures.find((value) => value.id === startup.primaryFailureId)?.kind,
        "startup",
      );
      for (const manifest of manifests) {
        assert.equal(manifest.historyComplete, false);
        for (const artifact of manifest.artifacts.filter((item) => item.status === "available")) {
          const text = await readFile(
            join(directory, "test-results/agent", manifest.runId, artifact.name!),
            "utf8",
          );
          assert.equal(text.includes("probe-assertion-secret"), false);
          assert.equal(text.includes("probe-startup-secret"), false);
          assert.equal(text.includes("probe-collection-secret"), false);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
