import { parseArgs } from "node:util";
import { z } from "zod";
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
  if (request.command === "help")
    return {
      commands: Object.fromEntries(
        Object.entries(commands).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
      ),
      usage:
        "npm run --silent desktop:agent -- <command> --json [--session UUID] [--request UUID] [--input JSON文件]",
      protocol: 1,
      implemented: ["help"],
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
    process.stdout.write(JSON.stringify(result(request, await dispatch(request))) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify(failure(error, request)) + "\n");
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
