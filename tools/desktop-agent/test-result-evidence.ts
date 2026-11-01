import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import type { TestCase, TestResult, TestStep } from "@playwright/test/reporter";
import { agentFile, agentRunHome } from "./paths.ts";
import { atomicJson } from "./build.ts";
import { initializeEvidence, readEvidence, updateEvidence } from "./evidence-store.ts";
import { recordArtifact, recordFailure } from "./evidence-artifacts.ts";
import type { RunIdentity, EvidenceManifest } from "./evidence-model.ts";
export const RUN_ANNOTATION = "media-marshal.run";
export const STARTUP_ANNOTATION = "media-marshal.startup-failed";
const annotation = z.strictObject({ runId: z.uuid(), sessionId: z.uuid() });
export const testKey = (id: string) => createHash("sha256").update(id).digest("hex");
export async function testRun(root: string, seed: string) {
  const runId = randomUUID();
  const identity: RunIdentity = {
    sessionId: randomUUID(),
    runId,
    profileRunId: runId,
    generation: 1,
    createdAt: new Date().toISOString(),
    options: { scenario: "empty", seed: testKey(seed), mode: "background", target: "development" },
  };
  await mkdir(agentRunHome(root, runId), { recursive: true, mode: 0o700 });
  await initializeEvidence(root, identity, "test");
  return identity;
}
function location(root: string, value: { file: string; line: number }) {
  const file = relative(root, value.file).replaceAll("\\", "/");
  return {
    file:
      !file.startsWith("../") && !isAbsolute(file) ? file.slice(0, 500) : "EXTERNAL_TEST_SOURCE",
    line: Math.max(1, value.line),
  };
}
function steps(root: string, values: TestStep[]) {
  const result: {
    category: string;
    failed: boolean;
    durationMs: number;
    location?: ReturnType<typeof location>;
  }[] = [];
  let truncated = false;
  const walk = (items: TestStep[], depth: number) => {
    if (depth > 10) {
      truncated = true;
      return;
    }
    for (const item of items) {
      if (result.length >= 200) {
        truncated = true;
        return;
      }
      result.push({
        category: ["expect", "hook", "pw:api", "test.step"].includes(item.category)
          ? item.category
          : "other",
        failed: Boolean(item.error),
        durationMs: item.duration,
        ...(item.location ? { location: location(root, item.location) } : {}),
      });
      walk(item.steps, depth + 1);
    }
  };
  walk(values, 0);
  return { items: result, truncated };
}
async function runs(root: string, test: TestCase) {
  const identities = test.annotations
    .filter((item) => item.type === RUN_ANNOTATION)
    .map((item) => annotation.parse(JSON.parse(item.description ?? "null")));
  if (!identities.length) return [await testRun(root, test.id)];
  const unique = [...new Map(identities.map((item) => [item.runId, item])).values()];
  for (const identity of unique) {
    if ((await readEvidence(root, identity.runId)).sessionId !== identity.sessionId)
      throw new Error("测试关联身份不匹配");
  }
  return unique;
}
function assertionState(manifest: EvidenceManifest, result: TestResult) {
  if (
    manifest.failures.some(
      (item) => item.kind === "assertion" && item.code === "TEST_ASSERTION_FAILED",
    )
  )
    return "failed";
  if (result.status === "failed") return "failed";
  if (["timedOut", "interrupted"].includes(result.status)) return "unknown";
  const next = result.status === "passed" ? "passed" : "blocked";
  if (manifest.assertions === "unknown") return "unknown";
  if (["passed", "blocked"].includes(manifest.assertions) && manifest.assertions !== next)
    return "unknown";
  return next;
}
export async function recordTestResult(root: string, test: TestCase, result: TestResult) {
  const linked = await runs(root, test);
  for (const run of linked) {
    const directory = await agentFile(root, agentRunHome(root, run.runId));
    const name = `assertion-${randomUUID()}.json`;
    const value = {
      testId: testKey(test.id),
      location: location(root, test.location),
      status: result.status,
      expectedStatus: test.expectedStatus,
      retry: result.retry,
      durationMs: result.duration,
      errorCount: result.errors.length,
      steps: steps(root, result.steps),
      rawErrorRecorded: false,
      historyComplete: false,
    };
    await atomicJson(join(directory, name), value);
    await recordArtifact(root, run.runId, {
      kind: "assertion",
      source: "test",
      status: "available",
      name,
    });
    const startup = test.annotations.some((item) => item.type === STARTUP_ANNOTATION);
    if (["failed", "timedOut", "interrupted"].includes(result.status))
      await recordFailure(root, run.runId, {
        kind: startup ? "startup" : "assertion",
        code: startup
          ? "TEST_SETUP_FAILED"
          : result.status === "failed"
            ? "TEST_ASSERTION_FAILED"
            : "TEST_RESULT_UNKNOWN",
        ...location(root, test.location),
      });
    await updateEvidence(root, run.runId, (manifest) => {
      if (!startup) manifest.assertions = assertionState(manifest, result);
      else if (["passed", "blocked"].includes(manifest.assertions)) manifest.assertions = "unknown";
      if (!test.annotations.some((item) => item.type === RUN_ANNOTATION))
        manifest.lifecycle = startup ? "failed" : "closed";
    });
  }
  return linked.map((run) => run.runId);
}
