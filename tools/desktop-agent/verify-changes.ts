import { execFileSync } from "node:child_process";
import { ToolError } from "./protocol.ts";
import type { VerificationChanges } from "./verify-plan.ts";
export const isStandardsFile = (path: string) =>
  /(?:^|\/)(?:AGENTS\.md|SKILL\.md)$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:tests?|fixtures|__tests__)\/|^tools\/desktop-agent\/|^scripts\/(?:architecture\/|check-|test-|benchmark-desktop)|^(?:\.github\/|vitest\.config\.ts|\.prettier)|(?:^|\/)(?:tsconfig[^/]*\.json|[^/]*playwright[^/]*config\.[cm]?[jt]s|package(?:-lock)?\.json)$/.test(
    path,
  );
export function verificationChanges(
  root: string,
  baseRef: string,
  hints: string[] = [],
): VerificationChanges {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  let baseCommit: string, headCommit: string, files: string[];
  try {
    baseCommit = git(["rev-parse", "--verify", "--end-of-options", baseRef + "^{commit}"]).trim();
    headCommit = git(["rev-parse", "HEAD"]).trim();
    // 不依赖 rename 相似度：旧、新路径都参与影响判断。
    files = [
      ...new Set(
        [
          ...git(["diff", "--no-renames", "--name-only", "-z", baseCommit, "--"]).split("\0"),
          ...git(["diff", "--cached", "--no-renames", "--name-only", "-z", baseCommit, "--"]).split(
            "\0",
          ),
          ...git(["diff", "--no-renames", "--name-only", "-z", "--"]).split("\0"),
          ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
          ...hints,
        ].filter(Boolean),
      ),
    ].sort();
  } catch {
    throw new ToolError(
      "VERIFY_BASE_UNAVAILABLE",
      "无法核实变更基点或完整差异",
      "使用本仓库中已获取的 commit／分支；不跳过基点或自动拉取",
      "blocked",
    );
  }
  const truncated = files.length > 1000;
  return {
    baseCommit,
    headCommit,
    files: files.slice(0, 1000),
    truncated,
    standardsFiles: files.filter(isStandardsFile).slice(0, 1000),
  };
}
