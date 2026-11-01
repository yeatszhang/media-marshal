import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentFile, agentRunHome } from "./paths.ts";
import { assertBuild } from "./build.ts";
import { verificationPlan, type VerificationPlan } from "./verify-plan.ts";
import { verificationSource } from "./verify-source.ts";
import {
  readVerification,
  saveVerification,
  verificationIdentity,
  type VerificationJob,
} from "./verify-store.ts";
import { verificationSteps, type VerificationStep } from "./verify-steps.ts";
import { executeVerificationStep, nativeVerificationCapability } from "./verify-execute.ts";
import { verificationOutcome, type VerificationResult } from "./verify-results.ts";
import { captureJson, lifecycleEvidence } from "./evidence-capture.ts";
import { recordFailure } from "./evidence-artifacts.ts";
import { updateEvidence } from "./evidence-store.ts";
import { ToolError } from "./protocol.ts";
import type { VerifyCheck } from "./verify-catalog.ts";
const buildTarget = (id: VerifyCheck) =>
  ["packaged", "benchmark"].includes(id)
    ? ("packaged" as const)
    : ["tools", "desktop", "native"].includes(id)
      ? ("development" as const)
      : undefined;
type CheckResult = {
  id: VerifyCheck;
  status: VerificationResult["status"];
  reason?: string;
  steps: VerificationResult[];
};
export async function performVerification(
  root: string,
  id: string,
  execute: (
    root: string,
    step: VerificationStep,
  ) => Promise<VerificationResult> = executeVerificationStep,
) {
  const job = await readVerification(root, id),
    run = verificationIdentity(job);
  if (job.status !== "running")
    throw new ToolError("VERIFY_ALREADY_SETTLED", "验证已结束", "查询原收据，不重放", "blocked");
  const lock = await open(
    join(await agentFile(root, agentRunHome(root, id)), "verify-running.json"),
    "wx",
    0o600,
  );
  await lock.close();
  const results: CheckResult[] = [];
  try {
    const snapshot = await verificationSource(root, job.input),
      plan = verificationPlan(snapshot.changes, job.input.benchmark);
    if (snapshot.digest !== job.source || JSON.stringify(plan) !== JSON.stringify(job.plan))
      throw new ToolError(
        "VERIFY_SOURCE_CHANGED",
        "受理后的源码、差异或计划发生变化",
        "保留原运行，为当前变更创建新请求",
        "blocked",
      );
    results.push(
      ...plan.checks.map((check) => ({ ...check, status: "not-run" as const, steps: [] })),
    );
    await lifecycleEvidence(root, run, "running");
    let sourceChanged = false;
    for (const result of results) {
      await runCheck(root, job, plan, result, execute);
      if (result.status === "failed")
        await recordFailure(root, id, { kind: "assertion", code: "VERIFY_CHECK_FAILED" });
      sourceChanged = (await verificationSource(root, job.input)).digest !== job.source;
      job.result = {
        ...plan,
        execution: "running",
        checks: structuredClone(results),
        allPlannedChecksPassed: false,
        sourceChanged,
      };
      await saveVerification(root, job);
      const captured = await captureJson(root, run, { kind: "assertion", source: "test" }, result);
      if (captured.status !== "indexed") {
        result.status = result.status === "failed" ? "failed" : "unknown";
        result.reason = "VERIFY_EVIDENCE_MISSING";
      }
      if (sourceChanged || result.status === "unknown") break;
    }
    await finishVerification(root, job, plan, results, sourceChanged);
  } catch (error) {
    job.status = results.some((value) => value.status === "failed")
      ? "failed"
      : error instanceof ToolError
        ? error.state
        : "unknown";
    job.error = {
      code: error instanceof ToolError ? error.code : "VERIFY_RUN_FAILED",
      message: "验证未完整结束，原结果和未执行项保留",
    };
    job.result = { checks: results, execution: "incomplete", allPlannedChecksPassed: false };
    await lifecycleEvidence(root, run, job.status, {
      kind: "collection",
      code: "VERIFY_RUN_INCOMPLETE",
    });
    if (results.some((value) => value.status === "failed"))
      await updateEvidence(root, id, (manifest) => {
        manifest.assertions = "failed";
      });
  } finally {
    await saveVerification(root, job);
  }
  return job;
}
async function runCheck(
  root: string,
  job: VerificationJob,
  plan: VerificationPlan,
  result: CheckResult,
  execute: (root: string, step: VerificationStep) => Promise<VerificationResult>,
) {
  const target = buildTarget(result.id);
  let build: Awaited<ReturnType<typeof assertBuild>> | undefined;
  try {
    if (target) {
      build = await assertBuild(root, target);
      const captured = await captureJson(
        root,
        verificationIdentity(job),
        { kind: "build", source: "tool" },
        JSON.parse(await readFile(build.manifest, "utf8")),
      );
      if (captured.status !== "indexed")
        throw new ToolError(
          "VERIFY_BUILD_EVIDENCE_MISSING",
          "构建证据未登记",
          "核对证据预算",
          "blocked",
        );
    }
    if (result.id === "native") {
      const reason = await nativeVerificationCapability(root);
      if (reason) {
        result.status = "blocked";
        result.reason = reason;
        return;
      }
    }
    for (const step of await verificationSteps(root, result.id, plan.businessScope)) {
      const value = await execute(root, step);
      result.steps.push(value);
      if (value.status !== "passed") break;
    }
    const outcome = verificationOutcome(result.steps);
    result.status = outcome.status === "completed" ? "passed" : outcome.status;
    if (target && (await assertBuild(root, target)).buildId !== build!.buildId) {
      if (result.status !== "failed") result.status = "unknown";
      result.reason = "VERIFY_BUILD_CHANGED";
    }
    if (result.id === "native" && result.status === "passed") {
      result.status = "blocked";
      result.reason = "NATIVE_MENU_PANEL_ACCEPTANCE_PENDING";
    }
  } catch (error) {
    result.status = result.steps.some((step) => step.status === "failed")
      ? "failed"
      : error instanceof ToolError
        ? error.state
        : "unknown";
    result.reason = error instanceof ToolError ? error.code : "VERIFY_CHECK_UNAVAILABLE";
  }
}
async function finishVerification(
  root: string,
  job: VerificationJob,
  plan: VerificationPlan,
  checks: CheckResult[],
  sourceChanged: boolean,
) {
  const outcome = verificationOutcome(checks, sourceChanged),
    run = verificationIdentity(job);
  job.status = outcome.status;
  const report = {
    ...plan,
    ...outcome,
    execution: "finished",
    checks,
    sourceChanged,
    performanceRegression: "not-evaluated",
    nativeAcceptance: "not-run",
  };
  const captured = await captureJson(root, run, { kind: "assertion", source: "test" }, report);
  if (captured.status !== "indexed") {
    if (job.status !== "failed") job.status = "unknown";
    report.allPlannedChecksPassed = false;
    report.status = job.status;
  }
  job.result = report;
  if (job.status !== "completed")
    await recordFailure(root, job.id, {
      kind: job.status === "failed" ? "assertion" : "collection",
      code: sourceChanged ? "VERIFY_SOURCE_CHANGED" : "VERIFY_INCOMPLETE",
    });
  await updateEvidence(root, job.id, (manifest) => {
    manifest.assertions =
      job.status === "completed" ? "passed" : job.status === "running" ? "unknown" : job.status;
    manifest.lifecycle = job.status === "completed" ? "closed" : job.status;
  });
}
