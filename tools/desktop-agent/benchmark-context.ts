import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { assertBuild } from "./build.ts";
import { sourceFingerprint } from "./fingerprint.ts";
import { createRunDirectory, agentRunHome } from "./paths.ts";
import { initializeEvidence } from "./evidence-store.ts";
import { captureJson, captureExisting, lifecycleEvidence } from "./evidence-capture.ts";
import { EventCollector } from "./collector.ts";
import {
  launchBenchmarkSample,
  sampleSummary,
  samplesStopped,
  type BenchmarkSamples,
} from "./benchmark-sample.ts";
import { ToolError } from "./protocol.ts";
import type { RunIdentity } from "./evidence-model.ts";
export async function beginBenchmark(root: string, mode: "background" | "foreground") {
  const build = await assertBuild(root, "packaged"),
    before = await sourceFingerprint(root);
  const id = randomUUID();
  const run: RunIdentity = {
    producer: "test",
    runId: id,
    profileRunId: id,
    sessionId: randomUUID(),
    generation: 1,
    createdAt: new Date().toISOString(),
    buildId: build.buildId,
    options: { scenario: "benchmark", seed: "fixed-empty-profile", mode, target: "packaged" },
  };
  await createRunDirectory(root, id);
  await initializeEvidence(root, run);
  await captureJson(
    root,
    run,
    { kind: "build", source: "tool" },
    JSON.parse(await readFile(build.manifest, "utf8")),
  );
  await captureJson(
    root,
    run,
    { kind: "scenario", source: "test" },
    {
      version: 1,
      name: "benchmark",
      mode,
      profileOwnership: "new-temporary-directories",
      realAccounts: false,
      startupSamples: { fresh: 3, reused: 5 },
      parserSamples: 20,
      thresholds: "not-defined",
      nativeAcceptance: "not-run",
    },
  );
  await captureJson(
    root,
    run,
    { kind: "reproduction", source: "tool" },
    {
      command: [
        "npm",
        "run",
        "desktop:benchmark",
        "--",
        "--json",
        ...(mode === "background" ? ["--background"] : []),
      ],
      currentPackagedBuildRequired: true,
    },
  );
  const collector = await EventCollector.create(root, run);
  await lifecycleEvidence(root, run, "running");
  const samples: BenchmarkSamples = {
    profiles: new Map(),
    instances: new Map(),
    pending: new Set(),
  };
  return { root, run, build, before, collector, samples };
}
export type BenchmarkContext = Awaited<ReturnType<typeof beginBenchmark>>;
export async function benchmarkLaunch(context: BenchmarkContext, dataDir: string) {
  const app = await launchBenchmarkSample(context.root, context.run, context.samples, dataDir);
  context.collector.record("benchmark.sample.started", {
    childRunId: context.samples.instances.get(app)!.entry.run.runId,
  });
  return app;
}
export async function benchmarkClose(context: BenchmarkContext, app: ElectronApplication) {
  const sample = context.samples.instances.get(app);
  if (!sample)
    throw new ToolError(
      "BENCHMARK_PROCESS_UNKNOWN",
      "测量实例不属于本轮",
      "不结束未知进程",
      "unknown",
    );
  await app.close();
  context.collector.record("benchmark.sample.closed", { childRunId: sample.entry.run.runId });
}
export function benchmarkInstance(context: BenchmarkContext, app: ElectronApplication) {
  const sample = context.samples.instances.get(app);
  if (!sample)
    throw new ToolError(
      "BENCHMARK_PROCESS_UNKNOWN",
      "没有本轮实例记录",
      "不读取未知进程",
      "unknown",
    );
  return {
    spawnStartedAt: sample.spawnStartedAt,
    runId: sample.entry.run.runId,
    sessionId: sample.entry.run.sessionId,
    buildId: context.build.buildId,
  };
}
export const benchmarkSamples = (context: BenchmarkContext) => sampleSummary(context.samples);
export const benchmarkStopped = (context: BenchmarkContext) => samplesStopped(context.samples);
export async function finishBenchmark(
  context: BenchmarkContext,
  report: unknown,
  status: "completed" | "partial",
) {
  const after = await sourceFingerprint(context.root),
    build = await assertBuild(context.root, "packaged");
  if (
    context.before.digest !== after.digest ||
    context.before.observation !== after.observation ||
    context.before.commit !== after.commit ||
    build.buildId !== context.build.buildId
  )
    throw new ToolError(
      "BENCHMARK_BUILD_CHANGED",
      "测量期间源码或当前目录包发生变化",
      "保留旧测量，停止并行修改后重跑",
      "blocked",
    );
  const captured = await captureJson(
    context.root,
    context.run,
    { kind: "observation", source: "test" },
    report,
  );
  if (captured.status !== "indexed" || !captured.name)
    throw new ToolError(
      "BENCHMARK_EVIDENCE_MISSING",
      "性能结果未取得完整写入权或容量",
      "核对证据预算并保留原运行",
      "unknown",
    );
  await context.collector.close();
  for (const name of ["observations.jsonl", "collector.json"])
    await captureExisting(
      context.root,
      context.run,
      join(agentRunHome(context.root, context.run.runId), name),
      { kind: "observation", source: "tool" },
    );
  await lifecycleEvidence(context.root, context.run, status === "completed" ? "closed" : "blocked");
  return {
    status,
    runId: context.run.runId,
    buildId: context.build.buildId,
    reportPath: join(agentRunHome(context.root, context.run.runId), captured.name),
    performanceRegression: "not-evaluated",
    thresholds: "not-defined",
    historyComplete: false,
  };
}
export async function failBenchmark(context: BenchmarkContext, code: string) {
  await context.collector.close().catch(() => {});
  await lifecycleEvidence(context.root, context.run, "failed", { kind: "collection", code });
}
