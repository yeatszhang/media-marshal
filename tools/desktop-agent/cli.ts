import { parseArgs } from "node:util";
import { z } from "zod";
import { doctor } from "./doctor.ts";
import { createBuild, buildStatus } from "./build.ts";
import { scenarios, SCENARIO_VERSION } from "./scenarios.ts";
import { readLogs } from "./log-reader.ts";
import { diagnoseSession } from "./diagnose.ts";
import { startSession, sessionCommand } from "./session.ts";
import type { Input } from "./protocol.ts";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { commands, parseRequest, result, failure, ToolError, type Request } from "./protocol.ts";

export async function readInput(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const data = Buffer.alloc(65537),
      { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > 65536)
      throw new ToolError("INPUT_TOO_LARGE", "输入文件超过 64 KiB", "缩小单次请求，使用分页操作");
    try {
      return JSON.parse(data.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw new ToolError("INVALID_JSON", "输入不是有效 JSON", "检查输入文件的 JSON 格式");
    }
  } finally {
    await file.close();
  }
}
export async function requestFromArgs(args: string[]): Promise<Request> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        input: { type: "string" },
        session: { type: "string" },
        request: { type: "string" },
        help: { type: "boolean" },
      },
    });
  } catch {
    throw new ToolError(
      "INVALID_ARGUMENTS",
      "命令行参数无效",
      "使用 help 查看命令；复杂输入使用 --input JSON 文件",
    );
  }
  if (parsed.positionals.length > 1)
    throw new ToolError(
      "INVALID_ARGUMENTS",
      "一次只能指定一个命令",
      "复杂参数使用 --input JSON 文件",
    );
  const input = parsed.values.input ? await readInput(resolve(parsed.values.input)) : {};
  return parseRequest({
    command: parsed.values.help ? "help" : (parsed.positionals[0] ?? "help"),
    sessionId: parsed.values.session,
    requestId: parsed.values.request,
    payload: input,
  });
}
export async function dispatch(request: Request): Promise<unknown> {
  const root = resolve(import.meta.dirname, "../..");
  if (request.command === "scenario") {
    const input = request.payload as Input<"scenario">;
    if (input.mode === "list") return { version: SCENARIO_VERSION, scenarios };
    if (request.sessionId)
      throw new ToolError(
        "SCENARIO_REQUIRES_FRESH_SESSION",
        "不能向现有会话直接写入场景数据",
        "不指定 --session，使用 scenario run 创建新隔离会话",
        "blocked",
      );
    if (!input.name)
      throw new ToolError("SCENARIO_NAME_REQUIRED", "运行场景需要名称", "先查询 scenario list");
    return startSession(root, {
      ...request,
      payload: {
        scenario: input.name,
        seed: input.seed,
        mode: "background",
        target: "development",
      },
    });
  }
  if (request.command === "diagnose") return diagnoseSession(root, request);
  if (request.command === "logs") {
    if (!request.sessionId)
      throw new ToolError(
        "SESSION_REQUIRED",
        "日志查询需要会话标识",
        "使用 --session 指定自有会话",
      );
    return readLogs(root, request.sessionId, request.payload as Input<"logs">);
  }
  if (request.command === "start") return startSession(root, request);
  if (request.command === "observe") return sessionCommand(root, request);
  if (
    ["status", "stop", "restart"].includes(request.command) &&
    !(request.payload as Input<"status">).jobId
  )
    return sessionCommand(root, request);
  if (request.command === "build") return createBuild(root, request);
  if (request.command === "status" && (request.payload as Input<"status">).jobId)
    return buildStatus(root, (request.payload as Input<"status">).jobId!);
  if (request.command === "doctor")
    return doctor(resolve(import.meta.dirname, "../.."), request.payload as Input<"doctor">);
  if (request.command === "help")
    return {
      commands: Object.fromEntries(
        Object.entries(commands).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
      ),
      usage:
        "npm run --silent desktop:agent -- <command> --json [--session UUID] [--request UUID] [--input JSON文件]",
      protocol: 1,
      implemented: [
        "help",
        "doctor",
        "build",
        "status",
        "start",
        "scenario",
        "observe",
        "logs",
        "diagnose",
        "stop",
        "restart",
      ],
    };
  throw new ToolError(
    "CAPABILITY_UNAVAILABLE",
    "此开发能力尚未接入",
    "查看 OpenSpec 实施任务；未实现的命令不会报告成功",
    "blocked",
  );
}
export async function main(args: string[]) {
  let request: Request | undefined;
  try {
    request = await requestFromArgs(args);
    const value = await dispatch(request);
    const response = result(request, value);
    if (
      ["build", "status", "start", "restart", "stop", "scenario"].includes(request.command) &&
      value &&
      typeof value === "object" &&
      "status" in value
    ) {
      response.status = String(value.status);
      if (["failed", "blocked", "unknown"].includes(response.status))
        process.exitCode = response.status === "failed" ? 1 : 2;
    }
    if (request.command === "doctor" && (value as { status: string }).status !== "ready") {
      response.status = "blocked";
      process.exitCode = 2;
    }
    process.stdout.write(JSON.stringify(response) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify(failure(error, request)) + "\n");
    process.exitCode = error instanceof ToolError && error.state !== "failed" ? 2 : 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
