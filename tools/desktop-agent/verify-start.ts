import { mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { agentDirectory, agentFile, agentRunHome, createRunDirectory } from "./paths.ts";
import { atomicJson } from "./build.ts";
import { identify } from "./process.ts";
import { lockEvidenceWriter, initializeEvidence } from "./evidence-store.ts";
import { captureJson, lifecycleEvidence } from "./evidence-capture.ts";
import { verificationPlan } from "./verify-plan.ts";
import { verificationSource } from "./verify-source.ts";
import {
  saveVerification,
  verificationIdentity,
  verificationStatus,
  type VerificationJob,
} from "./verify-store.ts";
import { readCheckControl } from "./check-store.ts";
import { ToolError, type Request, type Input } from "./protocol.ts";
export async function launchVerification(root: string, id: string) {
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      join(root, "tools/desktop-agent/verify-worker.ts"),
      id,
    ],
    { cwd: root, detached: true, stdio: "ignore", env: { ...process.env } },
  );
  await new Promise<void>((done, reject) => {
    child.once("spawn", done);
    child.once("error", reject);
  });
  const owner = child.pid ? identify(child.pid) : undefined;
  if (owner)
    await atomicJson(join(agentRunHome(root, id), "verify-worker.json"), {
      pid: owner.pid,
      created: owner.created,
      commandHash: createHash("sha256").update(owner.command).digest("hex"),
    });
  child.unref();
}
export async function startVerification(
  root: string,
  request: Request,
  launch = launchVerification,
) {
  const base = await agentDirectory(root, "checks"),
    unlock = await lockEvidenceWriter(base);
  try {
    return await reserveVerification(root, request, base, launch);
  } finally {
    await unlock();
  }
}
async function reserveVerification(
  root: string,
  request: Request,
  base: string,
  launch: typeof launchVerification,
) {
  const input = request.payload as Input<"verify">,
    signature = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const directory = join(base, "verify-requests");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await agentFile(root, directory);
  const path = join(directory, z.uuid().parse(request.requestId) + ".json");
  try {
    const previous = await readCheckControl(root, path);
    if (previous.signature !== signature)
      throw new ToolError(
        "REQUEST_CONFLICT",
        "原请求已用于另一组验证参数",
        "查询原收据，新验证使用新请求身份",
        "blocked",
      );
    return await verificationStatus(root, z.uuid().parse(previous.id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if ((await readdir(directory)).length >= 512)
    throw new ToolError("RECEIPTS_FULL", "验证收据已满", "保留原请求身份并核对存储", "blocked");
  const snapshot = await verificationSource(root, input),
    plan = verificationPlan(snapshot.changes, input.benchmark);
  const id = randomUUID(),
    job: VerificationJob = {
      format: 1,
      kind: "verify",
      id,
      sessionId: randomUUID(),
      requestId: request.requestId,
      input,
      source: snapshot.digest,
      plan,
      status: "running",
      createdAt: new Date().toISOString(),
    };
  await createRunDirectory(root, id);
  await saveVerification(root, job);
  const reservation = await open(path, "wx", 0o600);
  try {
    await reservation.writeFile(JSON.stringify({ id, signature }));
    await reservation.sync();
  } finally {
    await reservation.close();
  }
  const run = verificationIdentity(job);
  try {
    await initializeEvidence(root, run);
    const captured = await captureJson(
      root,
      run,
      { kind: "reproduction", source: "tool" },
      { command: "verify", payload: input, plan, newRequestRequired: true },
    );
    if (captured.status !== "indexed")
      throw new ToolError(
        "VERIFY_EVIDENCE_MISSING",
        "验证计划未取得证据写入权",
        "核对证据预算后创建新请求",
        "blocked",
      );
    await launch(root, id);
  } catch (error) {
    job.status = error instanceof ToolError ? error.state : "unknown";
    job.error = {
      code: error instanceof ToolError ? error.code : "VERIFY_START_FAILED",
      message: "验证未启动，保留原收据",
    };
    await saveVerification(root, job);
    await lifecycleEvidence(root, run, job.status, {
      kind: "startup",
      code: "VERIFY_START_FAILED",
    });
  }
  return verificationStatus(root, id);
}
