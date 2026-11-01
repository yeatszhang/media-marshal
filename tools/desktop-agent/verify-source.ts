import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { sourceFingerprint } from "./fingerprint.ts";
import { verificationChanges } from "./verify-changes.ts";
import { digestFile } from "./resources.ts";
import { ToolError, type Input } from "./protocol.ts";
/** 补齐构建指纹之外的文档、断言与未跟踪输入，不保存差异正文。 */
export async function verificationSource(root: string, input: Input<"verify">) {
  const changes = verificationChanges(
    root,
    input.baseRef,
    input.changedFiles?.map((path) => path.replaceAll("\\", "/")),
  );
  if (changes.truncated)
    throw new ToolError(
      "VERIFY_CHANGE_LIMIT",
      "完整差异超过执行核验预算",
      "计划已回退全量；缩小可独立验证的变更后创建新运行",
      "blocked",
    );
  const source = await sourceFingerprint(root);
  const diff = execFileSync(
    "git",
    ["diff", "--no-ext-diff", "--no-textconv", "--binary", changes.baseCommit, "--"],
    { cwd: root, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  const staged = execFileSync(
    "git",
    ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", changes.baseCommit, "--"],
    { cwd: root, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  const files = [];
  for (const name of changes.files) {
    try {
      const path = join(root, name),
        info = await lstat(path, { bigint: true });
      files.push({
        name,
        inode: String(info.ino),
        changed: String(info.ctimeNs),
        content: info.isFile()
          ? await digestFile(path)
          : info.isSymbolicLink()
            ? await readlink(path)
            : "directory",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files.push({ name, missing: true });
    }
  }
  return {
    changes,
    digest: createHash("sha256")
      .update(
        JSON.stringify({
          source: [source.digest, source.observation, source.commit],
          changes,
          files,
        }),
      )
      .update(diff)
      .update(staged)
      .digest("hex"),
  };
}
