import { realpath, lstat, mkdir } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { ToolError } from "./protocol.ts";
import { z } from "zod";
export const agentRunHome = (root: string, runId: string) =>
  resolve(root, "test-results/agent", z.uuid().parse(runId));
export async function agentBase(root: string) {
  let directory = await realpath(root);
  for (const name of ["test-results", "agent"]) {
    directory = resolve(directory, name);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new ToolError(
        "EVIDENCE_PATH_REJECTED",
        "证据根目录包含链接或不是目录",
        "核对工具拥有的目录",
        "blocked",
      );
  }
  return directory;
}
export async function agentDirectory(
  root: string,
  name: "exports" | "sessions" | "builds" | "checks",
) {
  const path = resolve(await agentBase(root), name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!(await lstat(path)).isDirectory())
    throw new ToolError("EVIDENCE_PATH_REJECTED", "工具目录不是目录", "核对目录类型", "blocked");
  return agentFile(root, path);
}
export async function createRunDirectory(root: string, runId: string) {
  let directory = await realpath(root);
  const selected = ["test-results", "agent", z.uuid().parse(runId)];
  for (const [index, name] of selected.entries()) {
    directory = resolve(directory, name);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (index === selected.length - 1)
        throw new ToolError(
          "EVIDENCE_RUN_REUSED",
          "该 runId 已经存在",
          "新建运行身份，保留修复前证据",
          "blocked",
        );
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new ToolError(
        "EVIDENCE_PATH_REJECTED",
        "运行目录包含链接或不是目录",
        "核对工具拥有的目录",
        "blocked",
      );
  }
  return directory;
}

/** 仅读取工作树内工具拥有的证据；根和叶子链接均不能指向其他应用数据。 */
export async function agentFile(root: string, path: string) {
  const actualRoot = await realpath(root);
  const base = resolve(actualRoot, "test-results/agent");
  const actualBase = await realpath(base),
    actual = await realpath(path);
  const absolute = resolve(path);
  // macOS 临时目录可能通过 /var 指向 /private/var；允许工具已核实的规范路径。
  const expected = absolute.startsWith(actualRoot + sep)
    ? absolute
    : resolve(actualRoot, relative(resolve(root), absolute));
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
