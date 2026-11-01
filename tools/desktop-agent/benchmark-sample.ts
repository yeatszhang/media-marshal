import { randomUUID } from "node:crypto";
import { resolve, basename, join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { createRunDirectory } from "./paths.ts";
import { initializeEvidence } from "./evidence-store.ts";
import { captureJson } from "./evidence-capture.ts";
import { launchDesktop } from "../../apps/desktop/tests/support/electron.ts";
import { manageContext, type ManagedTestContext } from "./test-context-lifecycle.ts";
import { identify, sameProcess, type ProcessIdentity } from "./process.ts";
import { ToolError } from "./protocol.ts";
import type { RunIdentity } from "./evidence-model.ts";
import { performance } from "node:perf_hooks";
export interface BenchmarkSamples {
  profiles: Map<string, { profileRunId: string; sessionId: string; generation: number }>;
  instances: Map<
    ElectronApplication,
    { entry: ManagedTestContext; identity: ProcessIdentity; spawnStartedAt: number }
  >;
  pending: Set<string>;
}
export function sampleSummary(samples: BenchmarkSamples) {
  return [...samples.instances.values()].map(({ entry }) => ({
    runId: entry.run.runId,
    profileRunId: entry.run.profileRunId,
    sessionId: entry.run.sessionId,
    generation: entry.run.generation,
    closed: entry.closed,
  }));
}
export function samplesStopped(samples: BenchmarkSamples) {
  return (
    samples.pending.size === 0 &&
    [...samples.instances.values()].every(
      ({ entry, identity }) => entry.closed && !sameProcess(identity),
    )
  );
}
export async function launchBenchmarkSample(
  root: string,
  parent: RunIdentity,
  samples: BenchmarkSamples,
  dataDir: string,
) {
  if (samples.instances.size >= 32)
    throw new ToolError(
      "BENCHMARK_SAMPLE_LIMIT",
      "测量实例数量已满",
      "保留本轮并启动新测量",
      "blocked",
    );
  const profile = resolve(dataDir),
    runId = randomUUID();
  const previous = samples.profiles.get(profile);
  const current = {
    profileRunId: previous?.profileRunId ?? runId,
    sessionId: previous?.sessionId ?? randomUUID(),
    generation: (previous?.generation ?? 0) + 1,
  };
  samples.profiles.set(profile, current);
  const run: RunIdentity = {
    ...parent,
    ...current,
    runId,
    createdAt: new Date().toISOString(),
    options: { ...parent.options, scenario: "benchmark-sample", seed: basename(profile) },
  };
  await createRunDirectory(root, runId);
  await initializeEvidence(root, run);
  await captureJson(
    root,
    run,
    { kind: "build", source: "tool" },
    {
      parentRunId: parent.runId,
      buildId: parent.buildId,
      verificationScope: "benchmark-start-and-finish",
      independentArtifactVerification: false,
    },
  );
  await captureJson(
    root,
    run,
    { kind: "scenario", source: "test" },
    {
      parentRunId: parent.runId,
      profileOwnership: "new-temporary-directory",
      generation: run.generation,
      sampleLabel: basename(profile),
    },
  );
  samples.pending.add(runId);
  const spawnStartedAt = performance.now();
  const app = await launchDesktop(root, {
    dataDir,
    mode: run.options.mode,
    target: "packaged",
    diagnostics: { sessionId: run.sessionId, runId, buildId: run.buildId! },
  });
  try {
    const identity = identify(app.process().pid!);
    if (!identity)
      throw new ToolError(
        "BENCHMARK_PROCESS_UNKNOWN",
        "测量实例进程身份无法核实",
        "保留临时资料，不接管其他进程",
        "unknown",
      );
    const entry = await manageContext(
      root,
      run,
      app,
      join(root, "scripts/benchmark-desktop.mjs"),
      profile,
      "sensitive",
    );
    samples.instances.set(app, { entry, identity, spawnStartedAt });
    samples.pending.delete(runId);
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}
