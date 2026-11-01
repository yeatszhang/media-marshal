import { realpath, lstat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { ToolError } from "./protocol.ts";
import { z } from "zod";
export const agentRunHome = (root: string, runId: string) =>
  resolve(root, "test-results/agent", z.uuid().parse(runId));

/** 仅读取工作树内工具拥有的证据；根和叶子链接均不能指向其他应用数据。 */
export async function agentFile(root: string, path: string) {
  const base = resolve(await realpath(root), "test-results/agent");
  const actualBase = await realpath(base),
    actual = await realpath(path);
  const expected = resolve(await realpath(root), relative(resolve(root), resolve(path)));
  if (
    actual !== expected ||
    actualBase !== base ||
    !actual.startsWith(base + sep) ||
    (await lstat(path)).isSymbolicLink()
  )
    throw new ToolError(
      "EVIDENCE_PATH_REJECTED",
      "证据路径包含链接或越界",
      "核对工具自有目录；不要链接到个人实例",
      "blocked",
    );
  return actual;
}
