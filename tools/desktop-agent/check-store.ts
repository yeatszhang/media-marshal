import { open, constants } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentFile, agentRunHome } from "./paths.ts";
import { writerSchema, writerAlive } from "./evidence-owner.ts";
import { atomicJson } from "./build.ts";
import { faultNames } from "./fault-catalog.ts";
import { ToolError } from "./protocol.ts";
import type { RunIdentity } from "./evidence-model.ts";
export const checkJobSchema = z.strictObject({
  format: z.literal(1),
  kind: z.literal("fault"),
  id: z.uuid(),
  sessionId: z.uuid(),
  requestId: z.uuid(),
  fault: z.enum(faultNames),
  seed: z.string().max(100),
  repeat: z.number().int().min(1).max(3),
  buildId: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  status: z.enum(["running", "completed", "failed", "blocked", "unknown"]),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type CheckJob = z.output<typeof checkJobSchema>;
export const checkPath = (root: string, id: string) =>
  join(agentRunHome(root, id), "check-job.json");
export async function readCheckControl(root: string, path: string) {
  const file = await open(
    await agentFile(root, path),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096)
      throw new Error("检查控制记录不可信");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
export async function readCheck(root: string, id: string) {
  const file = await open(
    await agentFile(root, checkPath(root, id)),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 512 * 1024)
      throw new Error("作业文件不可信");
    const job = checkJobSchema.parse(JSON.parse(await file.readFile("utf8")));
    if (job.id !== id) throw new Error("作业身份不匹配");
    return job;
  } finally {
    await file.close();
  }
}
export const saveCheck = (root: string, job: CheckJob) =>
  atomicJson(checkPath(root, job.id), checkJobSchema.parse(job));
export function checkIdentity(job: CheckJob): RunIdentity {
  return {
    producer: "test",
    sessionId: job.sessionId,
    runId: job.id,
    profileRunId: job.id,
    generation: 1,
    createdAt: job.createdAt,
    buildId: job.buildId,
    options: {
      scenario: "fault." + job.fault,
      seed: job.seed,
      mode: "background",
      target: "development",
    },
  };
}
export async function checkStatus(root: string, id: string) {
  const job = await readCheck(root, id);
  const publicJob = { ...job, jobId: job.id, runId: job.id };
  if (job.status !== "running") return publicJob;
  try {
    const path = await agentFile(root, join(agentRunHome(root, id), "check-worker.json"));
    const owner = writerSchema.parse(await readCheckControl(root, path));
    if (writerAlive(owner)) return publicJob;
  } catch {
    if (Date.now() - Date.parse(job.createdAt) < 20000) return publicJob;
  }
  return {
    ...publicJob,
    status: "unknown",
    error: { code: "CHECK_WORKER_LOST", message: "检查进程已退出或身份未知，不能重放原作业" },
  };
}
export async function knownCheckStatus(root: string, id: string) {
  try {
    return await checkStatus(root, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      "CHECK_JOB_INVALID",
      "检查作业身份或格式不可信",
      "保留原结果，不自动重放",
      "unknown",
    );
  }
}
