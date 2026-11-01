import { createRequire } from "node:module";
import { open, readFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { runHome, type Session } from "./session-store.ts";
import { agentFile } from "./paths.ts";
import { ToolError } from "./protocol.ts";
import { identify } from "./process.ts";
import { atomicJson } from "./build.ts";
import { SCENARIO_VERSION } from "./scenarios.ts";
import { CORE_DATA_SCHEMA_VERSION } from "@media-marshal/contracts/internal/core";
async function existing(root: string, session: Session) {
  const path = join(runHome(root, session.profileRunId), "scenario.json");
  try {
    const value = JSON.parse(await readFile(await agentFile(root, path), "utf8"));
    if (
      value.name !== session.options.scenario ||
      value.seed !== session.options.seed ||
      value.version !== SCENARIO_VERSION ||
      value.schemaVersion !== CORE_DATA_SCHEMA_VERSION
    )
      throw new ToolError(
        "SCENARIO_STALE",
        "场景版本、seed 或数据基线已经变化",
        "创建新的隔离场景；旧数据与证据不覆盖",
        "blocked",
      );
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function launchSeed(root: string, session: Session) {
  const directory = runHome(root, session.profileRunId),
    log = await open(join(directory, "seed.log"), "wx", 0o600);
  try {
    const child = spawn(
      createRequire(import.meta.url)("electron") as string,
      [
        "--disable-warning=ExperimentalWarning",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--experimental-strip-types",
        "--enable-source-maps",
        resolve(import.meta.dirname, "seed-worker.ts"),
        session.sessionId,
      ],
      {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", log.fd],
      },
    );
    await new Promise<void>((done, reject) => {
      child.once("spawn", done);
      child.once("error", reject);
    });
    const owner = identify(child.pid!);
    await atomicJson(join(directory, "seed-worker.json"), { owner });
    const chunks: Buffer[] = [];
    let bytesRead = 0,
      over = false;
    child.stdout!.on("data", (bytes: Buffer) => {
      bytesRead += bytes.length;
      if (bytesRead > 65536) over = true;
      else chunks.push(bytes);
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let code: number | null;
    try {
      code = await Promise.race([
        new Promise<number | null>((done, reject) => {
          child.once("close", done);
          child.once("error", reject);
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new ToolError(
                  "SCENARIO_TIMEOUT",
                  "场景写入尚未确认结束，结果未知",
                  "核对 seed-worker.json 中原进程和 seed.log；不重放或删除数据库",
                  "unknown",
                ),
              ),
            60000,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const output = Buffer.concat(chunks).toString("utf8");
    if (over)
      throw new ToolError(
        "SCENARIO_RESULT_UNKNOWN",
        "场景准备超时或回执超量，保留原作业身份",
        "查看 seed-worker.json／seed.log，不自动重放或删除数据",
        "unknown",
      );
    const value = JSON.parse(output);
    if (code !== 0 || value.status !== "completed")
      throw new ToolError(
        value.error?.code ?? "SCENARIO_FAILED",
        value.error?.message ?? "场景未准备成功",
        value.error?.repair ?? "查看 seed.log 并创建新场景",
        value.status === "blocked" ? "blocked" : "failed",
      );
    return value.result;
  } finally {
    await log.close();
  }
}
export async function prepareScenario(root: string, session: Session) {
  if (session.options.scenario === "empty")
    return { name: "empty", version: SCENARIO_VERSION, initializedBy: "application" };
  if (session.application)
    throw new ToolError(
      "SCENARIO_LIVE_WRITER",
      "应用进程仍登记为写入者",
      "先确认原应用安全停止",
      "blocked",
    );
  const previous = await existing(root, session);
  if (previous) return previous;
  const path = join(runHome(root, session.profileRunId), "scenario-preparing.json");
  try {
    await lstat(path);
    throw new ToolError(
      "SCENARIO_PARTIAL",
      "之前的场景准备没有完成",
      "查询原准备进程并创建新场景，不重置现有数据库",
      "unknown",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return launchSeed(root, session);
}
