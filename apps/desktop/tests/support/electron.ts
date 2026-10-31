import { _electron, type ElectronApplication } from "@playwright/test";
import { resolve, join } from "node:path";

export interface LaunchOptions {
  dataDir: string;
  mode: "background" | "foreground";
  target: "development" | "packaged";
  diagnostics?: { sessionId: string; runId: string; buildId: string };
}
/** CLI 与 E2E 共用启动方式；调用者负责独立目录与构建身份。 */
export async function launchDesktop(
  root: string,
  options: LaunchOptions,
): Promise<ElectronApplication> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.MARSHAL_E2E_MODE = options.mode;
  if (options.diagnostics) {
    env.MARSHAL_LOG_LEVEL = "debug";
    env.MARSHAL_AGENT_SESSION_ID = options.diagnostics.sessionId;
    env.MARSHAL_AGENT_RUN_ID = options.diagnostics.runId;
    env.MARSHAL_AGENT_BUILD_ID = options.diagnostics.buildId;
  } else {
    delete env.MARSHAL_AGENT_SESSION_ID;
    delete env.MARSHAL_AGENT_RUN_ID;
    delete env.MARSHAL_AGENT_BUILD_ID;
  }
  const executablePath =
    options.target === "packaged"
      ? process.platform === "darwin"
        ? join(
            root,
            `apps/desktop/release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/Media Marshal.app/Contents/MacOS/Media Marshal`,
          )
        : join(root, "apps/desktop/release/win-unpacked/Media Marshal.exe")
      : undefined;
  return _electron.launch({
    executablePath,
    args: [
      ...(executablePath ? [] : [resolve(root, "apps/desktop")]),
      `--user-data-dir=${resolve(options.dataDir)}`,
    ],
    cwd: root,
    env,
    timeout: 20000,
  });
}
