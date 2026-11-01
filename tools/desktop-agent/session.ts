import { open, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { assertBuild, atomicJson } from "./build.ts";
import { identify, sameProcess } from "./process.ts";
import { callController } from "./transport.ts";
import {
  newSession,
  readSession,
  saveSession,
  inspectSession,
  publicSession,
  sessionsHome,
  runHome,
  type Session,
} from "./session-store.ts";
import { ToolError, failure, type Request, type Input } from "./protocol.ts";

async function spawnController(root: string, session: Session) {
  const log = await open(join(runHome(root, session.runId), "controller.log"), "wx", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        resolve(import.meta.dirname, "session-worker.ts"),
        session.sessionId,
      ],
      {
        cwd: root,
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env },
      },
    );
    await new Promise<void>((done, reject) => {
      child.once("spawn", done);
      child.once("error", reject);
    });
    child.unref();
    // worker 自己取得并保存身份，父客户端不覆盖 worker 已更新的状态。
    if (!child.pid || !identify(child.pid))
      throw new ToolError(
        "CONTROLLER_START_UNKNOWN",
        "控制进程启动结果未知",
        "查询原会话，不要重复启动",
        "unknown",
      );
  } finally {
    await log.close();
  }
}
async function existingStart(path: string, options: Input<"start">, root: string, command: string) {
  try {
    const previous = JSON.parse(await readFile(path, "utf8"));
    if (
      previous.command !== command ||
      JSON.stringify(previous.options) !== JSON.stringify(options)
    )
      throw new ToolError(
        "REQUEST_CONFLICT",
        "同一请求已用于不同启动参数",
        "查询原会话；新会话使用新请求标识",
      );
    if (!previous.sessionId) throw new Error("预留未完成");
    return publicSession(inspectSession(await readSession(root, previous.sessionId)));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      "START_RESULT_UNKNOWN",
      "原启动请求未留下完整会话记录",
      "核对 requests 记录和存活进程，不自动重新启动",
      "unknown",
    );
  }
}
export async function startSession(root: string, request: Request) {
  const options = request.payload as Input<"start">;
  const requests = join(sessionsHome(root), "requests");
  await mkdir(requests, { recursive: true, mode: 0o700 });
  const path = join(requests, request.requestId + ".json");
  let reservation;
  try {
    reservation = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return existingStart(path, options, root, request.command);
    throw error;
  }
  try {
    await reservation.writeFile(
      JSON.stringify({ command: request.command, options, status: "preparing" }),
    );
    await reservation.sync();
    const build = await assertBuild(root, options.target);
    const session = await newSession(root, options);
    session.buildId = build.buildId;
    await saveSession(root, session);
    await atomicJson(path, { command: request.command, options, sessionId: session.sessionId });
    try {
      await spawnController(root, session);
    } catch (error) {
      session.status = "unknown";
      session.error = failure(error).error;
      await saveSession(root, session);
    }
    return publicSession(session);
  } finally {
    await reservation.close();
  }
}
export async function sessionCommand(root: string, request: Request) {
  if (!request.sessionId)
    throw new ToolError(
      "SESSION_REQUIRED",
      "命令需要会话标识",
      "使用 --session 指定 start 返回的会话 ID",
    );
  const session = inspectSession(await readSession(root, request.sessionId));
  if (request.command === "status") return publicSession(session);
  const recovering = session.status === "crashed" && request.command === "restart";
  if (recovering && (!session.owner || !sameProcess(session.owner)))
    throw new ToolError(
      "SESSION_UNAVAILABLE",
      "原控制进程身份无法核实",
      "保留原会话，不接管替代控制进程",
      "unknown",
    );
  if (recovering && (!session.application || identify(session.application.pid)))
    throw new ToolError(
      "APPLICATION_EXIT_UNCONFIRMED",
      "原应用 PID 尚未确认退出或记录不完整",
      "核对原应用与残留写入者，不自动重放恢复",
      "unknown",
    );
  if (
    session.status === "unknown" ||
    (session.status === "crashed" && request.command !== "stop" && !recovering)
  )
    throw new ToolError(
      "SESSION_UNAVAILABLE",
      "原会话控制权或进程已丢失",
      "保留现有证据，核对原进程身份；不能接管替代进程",
      "unknown",
    );
  if (session.status === "stopped") {
    if (request.command === "stop") return publicSession(session);
    throw new ToolError(
      "SESSION_STOPPED",
      "会话已停止",
      "使用 start 创建新会话；原证据继续保留",
      "blocked",
    );
  }
  return callController(session, request);
}
