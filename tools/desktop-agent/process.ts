import { createRequire } from "node:module";
import { ToolError } from "./protocol.ts";
export interface ProcessIdentity {
  pid: number;
  parent: number;
  created: string;
  command: string;
}
const processTools = createRequire(import.meta.url)("../desktop-sidecars/process-identity.cjs") as {
  identify(pid: number): ProcessIdentity | undefined;
};
export function identify(pid: number): ProcessIdentity | undefined {
  try {
    return processTools.identify(pid);
  } catch {
    throw new ToolError(
      "PROCESS_QUERY_FAILED",
      "无法核实开发工具的进程身份",
      "检查本机进程查询能力；不能将查询失败视为原进程已停止",
      "unknown",
    );
  }
}
export function sameProcess(expected: ProcessIdentity) {
  const current = identify(expected.pid);
  return !!current && current.created === expected.created && current.command === expected.command;
}
