import { identityHash, readManifest } from "./fingerprint.ts";
import { ToolError } from "./protocol.ts";
interface InputFile {
  path: string;
  sha256?: string;
  missing?: boolean;
}
export function controllerIdentity(files: InputFile[]) {
  const shared = new Set([
    "package.json",
    "package-lock.json",
    "tsconfig.base.json",
    ".npmrc",
    "apps/desktop/src/logging/shared.ts",
    "tools/desktop-sidecars/process-identity.cjs",
  ]);
  return identityHash(
    files
      .filter(
        (file) =>
          shared.has(file.path) ||
          ["tools/desktop-agent/", "packages/contracts/", "apps/desktop/tests/support/"].some(
            (prefix) => file.path.startsWith(prefix),
          ),
      )
      .sort((a, b) => a.path.localeCompare(b.path)),
  );
}
export async function assertController(manifestPath: string, expected?: string) {
  const actual = controllerIdentity((await readManifest(manifestPath)).source.files);
  if (expected && actual !== expected)
    throw new ToolError(
      "CONTROLLER_STALE",
      "控制工具或其依赖已更新，原进程仍持有旧代码",
      "安全停止旧会话并新建场景，保留旧数据及证据",
      "blocked",
    );
  return actual;
}
