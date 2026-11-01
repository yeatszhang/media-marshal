import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { agentDirectory, agentFile, createRunDirectory, agentRunHome } from "./paths.ts";
import { assertBuild, atomicJson } from "./build.ts";
import { initializeEvidence, lockEvidenceWriter } from "./evidence-store.ts";
import { captureJson } from "./evidence-capture.ts";
import { identify } from "./process.ts";
import {
  checkIdentity,
  saveCheck,
  checkStatus,
  readCheckControl,
  type CheckJob,
} from "./check-store.ts";
import { ToolError, type Request, type Input } from "./protocol.ts";
import { faultCatalog } from "./fault-catalog.ts";
async function launch(root: string, id: string) {
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--experimental-strip-types",
      join(root, "tools/desktop-agent/fault-worker.ts"),
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
    await atomicJson(join(agentRunHome(root, id), "check-worker.json"), {
      pid: owner.pid,
      created: owner.created,
      commandHash: createHash("sha256").update(owner.command).digest("hex"),
    });
  child.unref();
}
export async function startFault(root: string, request: Request) {
  const base = await agentDirectory(root, "checks");
  const unlock = await lockEvidenceWriter(base);
  try {
    return await createFault(root, request, base);
  } finally {
    await unlock();
  }
}
async function createFault(root: string, request: Request, base: string) {
  const input = request.payload as Input<"scenario">;
  if (!input.fault)
    throw new ToolError(
      "FAULT_REQUIRED",
      "故障运行需要固定场景名称",
      "使用 scenario list 查看 faultCatalog",
      "blocked",
    );
  const directory = join(base, "requests");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await agentFile(root, directory);
  const path = join(directory, z.uuid().parse(request.requestId) + ".json");
  const signature = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  try {
    const previous = await readCheckControl(root, path);
    if (previous.signature !== signature)
      throw new ToolError(
        "REQUEST_CONFLICT",
        "原请求已用于另一组故障参数",
        "查询原收据，新运行使用新请求身份",
        "blocked",
      );
    return checkStatus(root, z.uuid().parse(previous.id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const build = await assertBuild(root, "development");
  if ((await readdir(directory)).length >= 512)
    throw new ToolError(
      "RECEIPTS_FULL",
      "检查收据已满",
      "保留原收据并核对存储，不自动淘汰请求身份",
      "blocked",
    );
  const id = randomUUID(),
    file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ id, signature }));
    await file.sync();
  } finally {
    await file.close();
  }
  await createRunDirectory(root, id);
  const job: CheckJob = {
    format: 1,
    kind: "fault",
    id,
    sessionId: randomUUID(),
    requestId: request.requestId,
    fault: input.fault,
    seed: input.seed,
    repeat: input.repeat,
    buildId: build.buildId,
    createdAt: new Date().toISOString(),
    status: "running",
  };
  await saveCheck(root, job);
  try {
    const run = checkIdentity(job);
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
        name: input.fault,
        seed: input.seed,
        seedScope: "reproduction-label; fixed fixture inputs",
        repeat: input.repeat,
        ...faultCatalog[input.fault],
        guiCoverage: "not-run",
        nativeCoverage: "not-run",
      },
    );
    await captureJson(
      root,
      run,
      { kind: "reproduction", source: "tool" },
      { command: "scenario", payload: input, newRequestRequired: true, buildRequired: true },
    );
    await launch(root, id);
  } catch (error) {
    job.status = "failed";
    job.error = {
      code: error instanceof ToolError ? error.code : "CHECK_START_FAILED",
      message: "故障检查未启动，不重放原请求",
    };
    await saveCheck(root, job);
  }
  return checkStatus(root, id);
}
