import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { identify, sameProcess, type ProcessIdentity } from "./process.ts";
/** 只结束本次创建且身份仍匹配的测试根进程，未知后代由原有会话记录单独诊断。 */
export async function checkProcess(
  root: string,
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  const child = spawn(executable, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let identity: ProcessIdentity | undefined;
  try {
    identity = child.pid ? identify(child.pid) : undefined;
  } catch {
    /* 身份不可查时仍须收口管道，不能结束未知 PID。 */
  }
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  let bytes = 0,
    timedOut = false,
    truncated = false;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 1024 * 1024) chunks.push(chunk);
    else truncated = true;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 1024 * 1024) errors.push(chunk);
    else truncated = true;
  });
  const signal = (signal: NodeJS.Signals) => {
    try {
      if (identity && sameProcess(identity)) child.kill(signal);
    } catch {
      /* 未知身份不能据此强杀。 */
    }
  };
  let expiry: ReturnType<typeof setTimeout>,
    force: ReturnType<typeof setTimeout>,
    abandon: ReturnType<typeof setTimeout>;
  try {
    const exitCode = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
      expiry = setTimeout(() => {
        timedOut = true;
        signal("SIGTERM");
      }, timeoutMs);
      force = setTimeout(() => {
        if (timedOut) signal("SIGKILL");
      }, timeoutMs + 3000);
      abandon = setTimeout(() => {
        timedOut = true;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        done(null);
      }, timeoutMs + 5000);
    });
    return {
      text: Buffer.concat(chunks).toString("utf8"),
      errorText: Buffer.concat(errors).toString("utf8"),
      exitCode,
      timedOut,
      truncated,
      owner: identity
        ? {
            pid: identity.pid,
            created: identity.created,
            commandHash: createHash("sha256").update(identity.command).digest("hex"),
          }
        : undefined,
    };
  } finally {
    clearTimeout(expiry!);
    clearTimeout(force!);
    clearTimeout(abandon!);
  }
}
