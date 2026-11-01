import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MediaConnections } from "../../packages/media-core/dist/application/media-connections.js";
import { IngestionPipeline } from "../../packages/media-core/dist/ingestion/pipeline.js";
import { RecognitionRules } from "../../packages/media-core/dist/sources/recognition-rules.js";
import type { SeedContext } from "./seed-context.ts";
import { sceneIdentity, type ScenarioName } from "./scenarios.ts";
import {
  seedDownloadPlan,
  publishDownloadPlan,
} from "../../apps/desktop/tests/support/download-plan.mjs";
import { seedRecognitionReview } from "../../apps/desktop/tests/support/recognition-review.mjs";

export async function seedSync(context: SeedContext, name: ScenarioName, seed: string) {
  const id = sceneIdentity(name, seed, "source");
  const rule = context.sync.save({
    id,
    expectedVersion: 0,
    expectedDraftRevision: 0,
    expectedLifecycleRevision: 0,
    requestKey: sceneIdentity(name, seed, "save"),
    configuration: { type: "local", name: "隔离本地同步", inputDirectoryId: context.input.id },
  });
  const preview = await context.sync.preview({
    id,
    expectedVersion: rule.version,
    expectedDraftRevision: rule.draftRevision,
    expectedLifecycleRevision: rule.lifecycleRevision,
    requestKey: sceneIdentity(name, seed, "preview"),
  });
  await context.sync.confirm({
    previewId: preview.id,
    requestKey: sceneIdentity(name, seed, "confirm"),
    runOnce: false,
  });
  return { sourceId: id, jobs: 0, fileReadiness: "production-observation-required" };
}
export async function seedReview(context: SeedContext, name: ScenarioName, seed: string) {
  const connections = new MediaConnections(context.database, () => ({
    language: "zh-CN",
    embyUrl: "",
    tmdbProxy: "",
  }));
  const pipeline = new IngestionPipeline(context.database, () => undefined, connections);
  const rules = new RecognitionRules(context.database, context.directories, pipeline);
  try {
    const delivered = seedDownloadPlan(
      context.database,
      context.roots,
      context.target,
      context.bytes,
      { filename: "合成电影.2026.mp4" },
    );
    await publishDownloadPlan(context.database, context.roots, delivered, context.bytes);
    const id = sceneIdentity(name, seed, "rule"),
      targetId = sceneIdentity(name, seed, "mapping");
    const rule = rules.save({
      id,
      expectedVersion: 0,
      expectedDraftRevision: 0,
      expectedLifecycleRevision: 0,
      requestKey: sceneIdentity(name, seed, "save"),
      configuration: {
        name: "隔离识别核对",
        input: { kind: "default" },
        client: "custom",
        targets: [
          { id: targetId, directoryId: context.media.id, name: "隔离电影库", mediaType: "MOVIE" },
        ],
        automatic: false,
      },
    });
    const preview = await rules.preview({
      id,
      expectedVersion: rule.version,
      expectedDraftRevision: rule.draftRevision,
      expectedLifecycleRevision: rule.lifecycleRevision,
      requestKey: sceneIdentity(name, seed, "preview"),
    });
    const saved = await rules.confirm({
      previewId: preview.id,
      requestKey: sceneIdentity(name, seed, "confirm"),
    });
    if (!saved.runtime?.sourceId) throw new Error("独立识别输入未建立");
    await pipeline.scan(saved.runtime.sourceId);
    const taskIds = seedRecognitionReview(context.database, { title: "合成电影", tmdbId: 1 });
    if (taskIds.length !== 1) throw new Error("待核对任务数量不符");
    return {
      ruleId: id,
      taskIds,
      recognition: "synthetic-result-awaiting-confirmation",
      copyPlans: 0,
      filePublication: "production-commit-and-owned-cleanup-on-isolated-files",
      remoteStat: "synthetic",
    };
  } finally {
    await rules.close();
    await pipeline.close();
    connections.close();
  }
}
export async function seedCloud(context: SeedContext, name: ScenarioName) {
  const blockedTarget = name === "download-conflict";
  const plan = seedDownloadPlan(context.database, context.roots, context.target, context.bytes, {
    blockedTarget,
  });
  if (blockedTarget)
    await writeFile(join(context.target.path, "completed/sample.bin"), "保留的不同目标内容", {
      flag: "wx",
      mode: 0o600,
    });
  else {
    const stage = await plan.root.prepareStage(plan.attemptId);
    await writeFile(join(stage, "sample.bin"), context.bytes.subarray(0, 10), {
      flag: "wx",
      mode: 0o600,
    });
    context.database.connection
      .prepare("UPDATE download_attempt SET state='RUNNING' WHERE id=?")
      .run(plan.attemptId);
  }
  return {
    jobId: plan.jobId,
    itemId: plan.itemId,
    attemptId: blockedTarget ? null : plan.attemptId,
    expectedItemState: blockedTarget ? "BLOCKED_LOCAL" : "RECONCILING",
    account: "synthetic-no-credentials",
    physicalTransfer: "not-run",
  };
}
