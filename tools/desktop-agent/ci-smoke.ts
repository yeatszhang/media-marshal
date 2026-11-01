import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertBuild } from "./build.ts";
import { createRunDirectory } from "./paths.ts";
import { initializeEvidence, updateEvidence } from "./evidence-store.ts";
import { captureJson, lifecycleEvidence } from "./evidence-capture.ts";
import { recordFailure } from "./evidence-artifacts.ts";
import { exportBundle } from "./export-bundle.ts";
import { exportCiEvidence } from "./ci-evidence.ts";
import { executeVerificationStep } from "./verify-execute.ts";
import { verificationSteps, type VerificationStep } from "./verify-steps.ts";
import { verificationOutcome, type VerificationResult } from "./verify-results.ts";
import { verificationSource } from "./verify-source.ts";
import { parseRequest, ToolError, type Input } from "./protocol.ts";
import type { RunIdentity } from "./evidence-model.ts";
const files = [
  "protocol.test.ts",
  "gui.integration.ts",
  "gui-actions.integration.ts",
  "privacy.integration.ts",
  "diagnostics.integration.ts",
  "reporter.integration.ts",
  "session.integration.ts",
];
async function prepareSmoke(root: string) {
  const input = parseRequest({ command: "verify" }).payload as Input<"verify">;
  const before = await verificationSource(root, input),
    build = await assertBuild(root, "development");
  const packaged = await assertBuild(root, "packaged"),
    id = randomUUID();
  const run: RunIdentity = {
    producer: "test",
    runId: id,
    profileRunId: id,
    sessionId: randomUUID(),
    generation: 1,
    createdAt: new Date().toISOString(),
    buildId: build.buildId,
    options: {
      scenario: "ci-smoke",
      seed: "fixed-no-accounts",
      mode: "background",
      target: "development",
    },
  };
  await createRunDirectory(root, id);
  await initializeEvidence(root, run);
  const required = async (
    kind: "build" | "scenario" | "reproduction" | "assertion",
    value: unknown,
  ) => {
    const result = await captureJson(root, run, { kind, source: "test" }, value);
    if (result.status !== "indexed")
      throw new ToolError("CI_EVIDENCE_MISSING", "CI 证据未登记", "核对本轮证据预算", "unknown");
  };
  return { input, before, build, packaged, id, run, required };
}
async function smoke(root: string) {
  const { input, before, build, packaged, id, run, required } = await prepareSmoke(root);
  const results: VerificationResult[] = [];
  try {
    for (const value of [build, packaged])
      await required("build", JSON.parse(await readFile(value.manifest, "utf8")));
    await required("scenario", {
      version: 1,
      files,
      nativeAcceptance: "not-run",
      realAccounts: false,
      source: before.digest,
    });
    await required("reproduction", {
      command: "npm run test:desktop-agent:smoke",
      currentDevelopmentAndPackagedBuildsRequired: true,
    });
    await lifecycleEvidence(root, run, "running");
    const steps: VerificationStep[] = [
      {
        runner: "command",
        args: ["scripts/architecture/run.mjs", "boundaries"],
        timeoutMs: 120000,
      },
      {
        runner: "node",
        args: files.map((file) => "tools/desktop-agent/" + file),
        timeoutMs: 600000,
      },
      ...(await verificationSteps(root, "packaged", "all")),
    ];
    for (const step of steps) {
      const result = await executeVerificationStep(root, step);
      results.push(result);
      if (result.status === "failed")
        await recordFailure(root, id, { kind: "assertion", code: "CI_ASSERTION_FAILED" });
      await required("assertion", result);
      if (result.status !== "passed") break;
    }
    const changed = (await verificationSource(root, input)).digest !== before.digest;
    const outcome = verificationOutcome(results, changed);
    const complete = results.length === steps.length && outcome.status === "completed";
    await required("assertion", {
      checks: results,
      sourceChanged: changed,
      complete,
      requestedSteps: steps.length,
      executedSteps: results.length,
    });
    if (!complete)
      await recordFailure(root, id, {
        kind: outcome.status === "failed" ? "assertion" : "collection",
        code: "CI_SMOKE_INCOMPLETE",
      });
    await updateEvidence(root, id, (value) => {
      value.lifecycle = complete
        ? "closed"
        : outcome.status === "completed"
          ? "blocked"
          : outcome.status;
      value.assertions = complete ? "passed" : outcome.status === "failed" ? "failed" : "unknown";
    });
    const report = await exportBundle(root, id, {
      kinds: ["build", "scenario", "assertion", "reproduction"],
    });
    const evidence = await exportCiEvidence(root, run.createdAt);
    return {
      status:
        complete && report.status === "completed"
          ? "completed"
          : outcome.status === "failed"
            ? "failed"
            : "unknown",
      runId: id,
      checks: results,
      sourceChanged: changed,
      report,
      evidence,
      nativeAcceptance: "not-run",
      realAccounts: false,
    };
  } catch (error) {
    await lifecycleEvidence(root, run, "failed", {
      kind: "collection",
      code: "CI_SMOKE_INTERRUPTED",
    });
    return {
      status: results.some((result) => result.status === "failed") ? "failed" : "unknown",
      runId: id,
      checks: results,
      reason: error instanceof ToolError ? error.code : "CI_SMOKE_INTERRUPTED",
    };
  }
}
try {
  if (process.argv.length !== 2) throw new Error("固定 smoke 不接受任意文件或命令");
  const result = await smoke(resolve(import.meta.dirname, "../.."));
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.status !== "completed") process.exitCode = result.status === "failed" ? 1 : 2;
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      status: "blocked",
      reason: error instanceof ToolError ? error.code : "CI_SMOKE_UNAVAILABLE",
    }) + "\n",
  );
  process.exitCode = 2;
}
