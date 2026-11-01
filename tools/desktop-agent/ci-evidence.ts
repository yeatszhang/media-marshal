import { readdir } from "node:fs/promises";
import { z } from "zod";
import { agentBase } from "./paths.ts";
import { readEvidence } from "./evidence-store.ts";
import { exportBundle } from "./export-bundle.ts";
/** 只通过既有过滤器导出终止运行；不上传 profile、未知文件或原始测试输出。 */
export async function exportCiEvidence(root: string, since?: string) {
  const names = (await readdir(await agentBase(root))).filter(
    (name) => z.uuid().safeParse(name).success,
  );
  const runs: { id: string; failed: boolean; time: string }[] = [];
  const skipped: { runId: string; reason: string }[] = [];
  for (const id of names) {
    try {
      const value = await readEvidence(root, id);
      if (since && value.createdAt < since) continue;
      if (["starting", "running", "unknown"].includes(value.lifecycle)) {
        skipped.push({ runId: id, reason: "CI_RUN_NOT_TERMINAL" });
        continue;
      }
      runs.push({ id, failed: value.failures.length > 0, time: value.createdAt });
    } catch {
      skipped.push({ runId: id, reason: "CI_MANIFEST_UNTRUSTED" });
    }
  }
  runs.sort((a, b) => Number(b.failed) - Number(a.failed) || b.time.localeCompare(a.time));
  const exported: { runId: string; status: string; path?: string }[] = [];
  for (const run of runs.slice(0, 32)) {
    try {
      const value = await exportBundle(root, run.id, {
        kinds: [
          "build",
          "scenario",
          "action",
          "log",
          "health",
          "aria",
          "image",
          "assertion",
          "observation",
          "reproduction",
        ],
      });
      exported.push({ runId: run.id, status: value.status, path: value.path });
    } catch {
      exported.push({ runId: run.id, status: "missing" });
    }
  }
  skipped.push(...runs.slice(32).map((run) => ({ runId: run.id, reason: "CI_EXPORT_LIMIT" })));
  return { exported, skipped, historyComplete: false, rawProfilesUploaded: false };
}
