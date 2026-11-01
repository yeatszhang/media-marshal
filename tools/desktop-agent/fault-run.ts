import { open } from "node:fs/promises";
import { join } from "node:path";
import { faultCatalog } from "./fault-catalog.ts";
import { executeCheck } from "./check-execute.ts";
import { readCheck, saveCheck, checkIdentity, type CheckJob } from "./check-store.ts";
import { sourceFingerprint } from "./fingerprint.ts";
import { assertBuild } from "./build.ts";
import { captureJson, lifecycleEvidence } from "./evidence-capture.ts";
import { recordFailure } from "./evidence-artifacts.ts";
import { updateEvidence } from "./evidence-store.ts";
import { agentFile, agentRunHome } from "./paths.ts";
import { ToolError } from "./protocol.ts";
export async function performFault(root: string, id: string) {
  const job = await readCheck(root, id),
    run = checkIdentity(job);
  if (job.status !== "running")
    throw new ToolError("CHECK_ALREADY_SETTLED", "原检查已结束", "查询原收据，不重放", "blocked");
  const lock = await open(
    join(await agentFile(root, agentRunHome(root, id)), "check-running.json"),
    "wx",
    0o600,
  );
  await lock.close();
  try {
    const build = await assertBuild(root, "development"),
      before = await sourceFingerprint(root);
    if (build.buildId !== job.buildId)
      throw new ToolError(
        "CHECK_BUILD_CHANGED",
        "受理后构建已改变",
        "保留旧作业并为当前构建创建新请求",
        "blocked",
      );
    const scenario = faultCatalog[job.fault];
    if (scenario.platform === "darwin" && process.platform !== "darwin")
      throw new ToolError(
        "FAULT_PLATFORM_UNSUPPORTED",
        "故障场景需要已验证的 macOS 文件能力",
        "在 macOS 重跑，其他平台不计通过",
        "blocked",
      );
    await lifecycleEvidence(root, run, "running");
    const phases: object[] = [];
    let failed = false,
      blocked = false,
      unknown = false;
    for (let iteration = 1; iteration <= job.repeat; iteration++) {
      for (const mode of ["on", "off"] as const) {
        const result = await executeCheck(root, scenario[mode]);
        phases.push({ iteration, mode, ...result });
        job.result = {
          phases: structuredClone(phases),
          requestedPhases: job.repeat * 2,
          executedPhases: phases.length,
          historyComplete: false,
        };
        await saveCheck(root, job);
        await captureJson(
          root,
          run,
          { kind: "assertion", source: "test" },
          { iteration, mode, ...result },
        );
        if (result.status === "failed")
          await recordFailure(root, id, { kind: "assertion", code: "FAULT_ASSERTION_FAILED" });
        failed ||= result.status === "failed";
        blocked ||= result.status === "blocked";
        unknown ||= result.status === "unknown";
        if (unknown) break;
      }
      if (unknown) break;
    }
    const after = await sourceFingerprint(root);
    const sourceChanged =
      before.digest !== after.digest ||
      before.observation !== after.observation ||
      before.commit !== after.commit;
    await assertBuild(root, "development");
    await finishFault(root, job, phases, { sourceChanged, failed, blocked, unknown });
  } catch (error) {
    const reason = error instanceof ToolError ? error.code : "FAULT_RUN_FAILED";
    job.status = error instanceof ToolError && error.state === "blocked" ? "blocked" : "unknown";
    job.error = { code: reason, message: "故障检查未完整结束，保留原断言与已取得证据" };
    await lifecycleEvidence(root, run, job.status, { kind: "collection", code: reason });
  } finally {
    await saveCheck(root, job);
  }
  return job;
}

async function finishFault(
  root: string,
  job: CheckJob,
  phases: object[],
  flags: { sourceChanged: boolean; failed: boolean; blocked: boolean; unknown: boolean },
) {
  const { sourceChanged, failed, blocked, unknown } = flags;
  const id = job.id,
    run = checkIdentity(job);
  job.status =
    sourceChanged || unknown ? "unknown" : failed ? "failed" : blocked ? "blocked" : "completed";
  job.result = {
    version: 1,
    fault: job.fault,
    phases,
    requestedPhases: job.repeat * 2,
    executedPhases: phases.length,
    sourceChanged,
    assertionSource: "repository",
    standardsComparison: "not-run",
    substitutes: faultCatalog[job.fault].substitutes,
    guiCoverage: "not-run",
    nativeCoverage: "not-run",
    historyComplete: false,
  };
  if (job.status !== "completed")
    await recordFailure(root, id, {
      kind: failed ? "assertion" : "collection",
      code: sourceChanged
        ? "CHECK_SOURCE_CHANGED"
        : unknown
          ? "FAULT_RESULT_UNKNOWN"
          : failed
            ? "FAULT_ASSERTION_FAILED"
            : "FAULT_CHECK_BLOCKED",
    });
  await updateEvidence(root, id, (manifest) => {
    manifest.assertions =
      job.status === "completed" ? "passed" : failed ? "failed" : blocked ? "blocked" : "unknown";
    manifest.lifecycle =
      job.status === "completed"
        ? "closed"
        : job.status === "failed"
          ? "failed"
          : job.status === "blocked"
            ? "blocked"
            : "unknown";
  });
  const captured = await captureJson(root, run, { kind: "assertion", source: "test" }, job.result);
  if (captured.status === "missing" && job.status === "completed") job.status = "unknown";
}
