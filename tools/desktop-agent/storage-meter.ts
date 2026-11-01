import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { agentBase } from "./paths.ts";
import { ToolError } from "./protocol.ts";
export const EVIDENCE_BUDGET = 500 * 1024 * 1024;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 运行资料、构建产物与证据有独立所有权；此预算不授权清空 SQLite／userData。 */
export async function evidenceUsage(root: string) {
  const base = await agentBase(root);
  let bytes = 0,
    files = 0,
    runtimeDirectories = 0,
    unknownRoots = 0;
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!(entry.name === "exports" || /^[a-f0-9-]{36}$/.test(entry.name))) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      unknownRoots++;
      continue;
    }
    const directory = join(base, entry.name);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (item.name !== ".leases") runtimeDirectories++;
        continue;
      }
      const info = await lstat(join(directory, item.name));
      if (!info.isFile() && !info.isSymbolicLink()) {
        unknownRoots++;
        continue;
      }
      bytes += info.size;
      files++;
      if (files > 50000)
        throw new ToolError(
          "STORAGE_SCAN_LIMIT",
          "证据文件数量超过统计预算",
          "保留未知文件并人工核对",
          "blocked",
        );
    }
  }
  return {
    bytes,
    files,
    runtimeDirectories,
    unknownRoots,
    scope: "run-files-and-exports",
    budgetBytes: EVIDENCE_BUDGET,
  };
}
