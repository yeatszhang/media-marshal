import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CloudError, DesktopError } from "@media-marshal/contracts";

// 仅在 OS 核验已无旧执行者后调用；暂存下载与最终成果不放在这个目录。
export async function clearPrivateSessions(privateRoot: string): Promise<void> {
  const sessions = join(privateRoot, "sessions");
  let entries;
  try {
    const info = await lstat(sessions);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new CloudError("CONFLICT");
    entries = await readdir(sessions, { withFileTypes: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new DesktopError("STORAGE_ERROR", "无法清理组件私有状态"); }
  for (const entry of entries) {
    if (!z.uuid().safeParse(entry.name).success) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new CloudError("CONFLICT");
    await rm(join(sessions, entry.name), { recursive: true, force: true });
  }
}
