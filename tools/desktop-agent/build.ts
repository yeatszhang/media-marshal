import { mkdir, open, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { identify, sameProcess } from "./process.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ToolError, failure, type Input, type Request } from "./protocol.ts";
import {
  sourceFingerprint,
  artifactFingerprint,
  identityHash,
  readManifest,
} from "./fingerprint.ts";

const targetSchema = z.enum(["development", "packaged"]);
const jobSchema = z.strictObject({
  id: z.uuid(),
  requestId: z.uuid(),
  target: targetSchema,
  status: z.enum(["running", "completed", "failed", "blocked", "unknown"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  owner: z
    .strictObject({
      pid: z.number().int().positive(),
      parent: z.number().int().nonnegative(),
      created: z.string(),
      command: z.string(),
    })
    .optional(),
});
export type BuildJob = z.infer<typeof jobSchema>;
const home = (root: string) => join(root, "test-results/agent/builds");
const folder = (root: string, id: string) => join(home(root), z.uuid().parse(id));
export async function atomicJson(path: string, value: unknown) {
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
export async function buildStatus(root: string, id: string): Promise<BuildJob> {
  try {
    const job = jobSchema.parse(
      JSON.parse(await readFile(join(folder(root, id), "job.json"), "utf8")),
    );
    if (job.status !== "running") return job;
    let owner = job.owner;
    if (!owner) {
      try {
        const launch = JSON.parse(await readFile(join(folder(root, id), "worker.json"), "utf8"));
        if (!launch.owner) return { ...job, status: "unknown" };
        owner = jobSchema.shape.owner.parse(launch.owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (owner && !sameProcess(owner))
      return {
        ...job,
        status: "unknown",
        error: {
          code: "BUILD_WORKER_LOST",
          message: "原构建进程已退出或身份变化，结果未知",
          repair: "核对构建日志与遗留写入者，不能自动删除锁或复用旧产物",
        },
      };
    return job;
  } catch {
    throw new ToolError(
      "BUILD_JOB_UNKNOWN",
      "无法读取构建作业身份或结果",
      "确认作业标识并查看本次证据，不能据此重复启动",
      "unknown",
    );
  }
}
async function launchWorker(root: string, id: string) {
  const log = await open(join(folder(root, id), "build.log"), "wx", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        resolve(import.meta.dirname, "build-worker.ts"),
        id,
      ],
      { cwd: root, detached: true, stdio: ["ignore", log.fd, log.fd], env: { ...process.env } },
    );
    await new Promise<void>((done, reject) => {
      child.once("spawn", done);
      child.once("error", reject);
    });
    const owner = child.pid ? identify(child.pid) : undefined;
    await atomicJson(join(folder(root, id), "worker.json"), { owner: owner ?? null });
    child.unref();
    return owner;
  } finally {
    await log.close();
  }
}
export async function createBuild(root: string, request: Request) {
  const input = request.payload as Input<"build">;
  const target = targetSchema.parse(input.target),
    id = randomUUID();
  await mkdir(join(home(root), "requests"), { recursive: true, mode: 0o700 });
  const index = join(home(root), "requests", z.uuid().parse(request.requestId) + ".json");
  let reservation;
  try {
    reservation = await open(index, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = JSON.parse(await readFile(index, "utf8"));
    if (previous.target !== target)
      throw new ToolError(
        "REQUEST_CONFLICT",
        "同一请求标识已用于另一构建目标",
        "查询原构建，新的构建使用新请求标识",
      );
    return buildStatus(root, previous.id);
  }
  const timestamp = new Date().toISOString();
  const job: BuildJob = {
    id,
    requestId: request.requestId,
    target,
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  try {
    await mkdir(folder(root, id), { recursive: true, mode: 0o700 });
    await atomicJson(join(folder(root, id), "job.json"), job);
    await reservation.writeFile(JSON.stringify({ id, target }));
    await reservation.sync();
  } finally {
    await reservation.close();
  }
  try {
    if (!(await launchWorker(root, id))) job.status = "unknown";
  } catch {
    job.status = "failed";
    job.error = failure(
      new ToolError("BUILD_START_FAILED", "无法启动构建进程", "检查 Node、工作区权限和构建日志"),
    ).error;
    await atomicJson(join(folder(root, id), "job.json"), job);
  }
  return job;
}
async function execute(root: string, target: "development" | "packaged") {
  await new Promise<void>((done, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", target === "packaged" ? "desktop:pack" : "desktop:build"],
      { cwd: root, env, stdio: "inherit", shell: false },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? done()
        : reject(
            new ToolError(
              "BUILD_FAILED",
              `构建未成功结束（${signal ?? code}）`,
              "查看本次 build.log，修复后重新构建，不能使用旧产物验收",
            ),
          ),
    );
  });
}
export async function performBuild(root: string, id: string, executor = execute) {
  const job = await buildStatus(root, id);
  if (job.status === "completed") return job;
  job.status = "running";
  job.owner = identify(process.pid);
  if (!job.owner)
    throw new ToolError("PROCESS_QUERY_FAILED", "无法核实构建进程", "检查进程查询能力", "unknown");
  await atomicJson(join(folder(root, id), "job.json"), job);
  const lockPath = join(home(root), "build.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new ToolError(
      "BUILD_BUSY",
      "已有构建持有工作区写入权或遗留锁需核对",
      "查询当前构建；未确认原写入者停止前不要删除锁或启动新构建",
      "blocked",
    );
  }
  try {
    await lock.writeFile(JSON.stringify({ id, pid: process.pid }));
    await lock.sync();
    await atomicJson(join(home(root), `attempt-${job.target}.json`), { id });
    const before = await sourceFingerprint(root);
    await executor(root, job.target);
    const after = await sourceFingerprint(root);
    if (before.digest !== after.digest || before.observation !== after.observation)
      throw new ToolError(
        "SOURCE_CHANGED",
        "构建期间源码或配置发生变化",
        "停止并行修改后重新构建，本次产物不可作为当前验证",
      );
    const artifact = await artifactFingerprint(root, job.target);
    const buildId = identityHash({ source: before, artifact });
    const manifest = {
      format: 1,
      buildId,
      source: before,
      artifact,
      createdAt: new Date().toISOString(),
    };
    await atomicJson(join(folder(root, id), "manifest.json"), manifest);
    job.status = "completed";
    job.updatedAt = new Date().toISOString();
    job.result = {
      buildId,
      manifest: join(folder(root, id), "manifest.json"),
      source: before.digest,
      artifact: artifact.digest,
    };
    await atomicJson(join(folder(root, id), "job.json"), job);
    await atomicJson(join(home(root), `latest-${job.target}.json`), { id });
    return job;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
export async function recordBuildFailure(root: string, id: string, error: unknown) {
  const job = await buildStatus(root, id);
  job.status = error instanceof ToolError ? error.state : "failed";
  job.updatedAt = new Date().toISOString();
  job.error = failure(error).error;
  await atomicJson(join(folder(root, id), "job.json"), job);
}
export async function assertBuild(root: string, target: "development" | "packaged") {
  let id: string;
  try {
    id = JSON.parse(await readFile(join(home(root), `latest-${target}.json`), "utf8")).id;
    const attempt = JSON.parse(await readFile(join(home(root), `attempt-${target}.json`), "utf8"));
    if (attempt.id !== id || (await buildStatus(root, id)).status !== "completed")
      throw new Error("最近构建未成功");
  } catch {
    throw new ToolError(
      "BUILD_NOT_READY",
      "缺少已完成的当前构建或最近构建失败",
      "先执行 build，等待对应作业完成",
      "blocked",
    );
  }
  const manifest = await readManifest(join(folder(root, id), "manifest.json"));
  const current = await sourceFingerprint(root);
  let artifact;
  try {
    artifact = await artifactFingerprint(root, target);
  } catch {
    throw new ToolError(
      "STALE_BUILD",
      "构建产物缺失或已损坏",
      "重新 build 后再启动或验证",
      "blocked",
    );
  }
  if (
    manifest.source.digest !== current.digest ||
    manifest.artifact.digest !== artifact.digest ||
    manifest.source.platform !== process.platform ||
    manifest.source.arch !== process.arch ||
    manifest.source.node !== process.versions.node ||
    manifest.artifact.target !== target ||
    manifest.artifact.platform !== process.platform ||
    manifest.artifact.arch !== process.arch
  )
    throw new ToolError(
      "STALE_BUILD",
      "源码、平台或产物与构建清单不一致",
      "重新 build 后再启动或验证",
      "blocked",
    );
  return { buildId: manifest.buildId as string, manifest: join(folder(root, id), "manifest.json") };
}
