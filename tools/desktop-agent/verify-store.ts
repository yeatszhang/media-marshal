import { open, constants } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentFile, agentRunHome } from "./paths.ts";
import { atomicJson } from "./build.ts";
import { commands, ToolError } from "./protocol.ts";
import { writerSchema, writerAlive } from "./evidence-owner.ts";
import { readCheckControl } from "./check-store.ts";
import type { RunIdentity } from "./evidence-model.ts";
export const verificationJobSchema = z.strictObject({
  format: z.literal(1),
  kind: z.literal("verify"),
  id: z.uuid(),
  sessionId: z.uuid(),
  requestId: z.uuid(),
  createdAt: z.iso.datetime(),
  source: z.string().regex(/^[a-f0-9]{64}$/),
  input: commands.verify,
  status: z.enum(["running", "completed", "failed", "blocked", "unknown"]),
  plan: z.unknown(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type VerificationJob = z.output<typeof verificationJobSchema>;
export const verificationPath = (root: string, id: string) =>
  join(agentRunHome(root, id), "verify-job.json");
export const saveVerification = (root: string, job: VerificationJob) =>
  atomicJson(verificationPath(root, job.id), verificationJobSchema.parse(job));
export async function readVerification(root: string, id: string) {
  const file = await open(
    await agentFile(root, verificationPath(root, id)),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024)
      throw new Error("验证收据不可信");
    const job = verificationJobSchema.parse(JSON.parse(await file.readFile("utf8")));
    if (job.id !== id) throw new Error("验证身份不匹配");
    return job;
  } finally {
    await file.close();
  }
}
export function verificationIdentity(job: VerificationJob): RunIdentity {
  return {
    producer: "test",
    runId: job.id,
    profileRunId: job.id,
    sessionId: job.sessionId,
    generation: 1,
    createdAt: job.createdAt,
    options: { scenario: "verify", seed: job.source, mode: "background", target: "development" },
  };
}
export async function verificationStatus(root: string, id: string) {
  const job = await readVerification(root, id),
    publicJob = { ...job, jobId: id, runId: id };
  if (job.status !== "running") return publicJob;
  try {
    const owner = writerSchema.parse(
      await readCheckControl(root, join(agentRunHome(root, id), "verify-worker.json")),
    );
    if (writerAlive(owner)) return publicJob;
  } catch {
    if (Date.now() - Date.parse(job.createdAt) < 20000) return publicJob;
  }
  return {
    ...publicJob,
    status: "unknown",
    error: { code: "VERIFY_WORKER_LOST", message: "验证进程已退出或身份未知，不重放原请求" },
  };
}
export async function knownVerificationStatus(root: string, id: string) {
  try {
    return await verificationStatus(root, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      "VERIFY_JOB_INVALID",
      "验证收据身份或格式不可信",
      "保留原运行，不自动重放",
      "unknown",
    );
  }
}
