import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DesktopError } from "@media-marshal/contracts";

export type CodexAction = "recognize" | "recognize-cluster" | "recognize-directory" | "usage";
export interface CodexGateway { request(action: CodexAction, input: unknown, signal?: AbortSignal): Promise<unknown>; close(): Promise<void> }
export interface CodexProcessConfiguration { executable: string; args?: string[]; runtimeDirectory: string; cliPath: string; model: string; dailyCalls: number }

/** 每次请求独立启动冻结引擎；缓存及预算在原运行目录持久复用，关闭仅终止自有进程。 */
export class CodexProcess implements CodexGateway {
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private flights = new Set<ChildProcessWithoutNullStreams>();
  private count = 0;
  constructor(private readonly configuration: () => CodexProcessConfiguration, private readonly timeoutMs = 160000) {}
  request(action: CodexAction, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || this.count >= 32) return Promise.reject(new DesktopError("COMPONENT_UNAVAILABLE", "Codex 识别服务不可用或队列已满，请稍后重试", true));
    this.count++;
    const work = this.queue.catch(() => {}).then(() => this.run(action, input, signal)).finally(() => { this.count--; });
    this.queue = work; return work;
  }
  private async run(action: CodexAction, input: unknown, signal?: AbortSignal) {
    if (this.closed || signal?.aborted) throw new DesktopError("INTERRUPTED", "Codex 识别已取消，原任务保留", true);
    const options = this.configuration(), id = randomUUID(), initialization = randomUUID();
    const request = JSON.stringify({ protocolVersion: 1, requestId: id, action, input });
    if (Buffer.byteLength(request) > 65535) throw new DesktopError("INVALID_REQUEST", "Codex 名称上下文超过允许大小，请缩小目录范围");
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "USER", "SHELL", "CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ELECTRON_RUN_AS_NODE"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(options.executable, [...(options.args ?? []), "--codex-stdio"], { env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.flights.add(child);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { child.stdin.end(); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1500); } };
    const ended = new Promise<void>((resolve) => child.once("close", () => { clearTimeout(killTimer); this.flights.delete(child); resolve(); }));
    try {
      return await new Promise<unknown>((resolve, reject) => {
        let buffer = "", bytes = 0, initialized = false;
        const abort = () => { reject(new DesktopError("INTERRUPTED", "Codex 识别已取消，原任务保留", true)); stop(); };
        const timer = setTimeout(() => { reject(new DesktopError("TIMEOUT", "Codex 识别超时，请检查网络后重试", true)); stop(); }, this.timeoutMs);
        const fail = (message = "Codex 识别进程未完成，请检查 CLI 安装、登录状态和网络后重试") => reject(new DesktopError("COMPONENT_UNAVAILABLE", message, true));
        signal?.addEventListener("abort", abort, { once: true });
        child.once("close", () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); fail(); });
        child.once("error", () => fail("无法启动 Codex 识别组件，请检查安装资源后重启核心"));
        child.stderr.on("data", () => {});
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 1024 * 1024 + 4096) { fail("Codex 识别返回超过允许大小，请缩小目录范围"); stop(); return; }
          buffer += chunk;
          for (;;) {
            const end = buffer.indexOf("\n"); if (end < 0) break;
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            try {
              const value = JSON.parse(line), expected = initialized ? id : initialization;
              if (value.protocolVersion !== 1 || value.requestId !== expected || typeof value.ok !== "boolean" || Object.keys(value).some((key) => !["protocolVersion", "requestId", "ok", value.ok ? "result" : "error"].includes(key))) throw new Error();
              if (!value.ok) {
                const reasons: Record<string, string> = {
                  BUDGET_EXCEEDED: "Codex 今日调用预算已用完，请明日重试或人工选择作品",
                  COMPONENT_UNAVAILABLE: "找不到 Codex CLI，请安装并在设置中核对可执行文件路径",
                  TIMEOUT: "Codex 识别超时，请检查网络后重试",
                  INVALID_REQUEST: "Codex 请求或结构化结果无效，请核对名称后重试",
                  RECOGNITION_FAILED: "Codex 调用未完成，请检查本机登录状态和网络后重试",
                };
                reject(new DesktopError(value.error?.code === "TIMEOUT" ? "TIMEOUT" : "COMPONENT_UNAVAILABLE", reasons[String(value.error?.code)] ?? "Codex 返回无效结果，请核对名称后重试", true));
                stop(); return;
              }
              if (!initialized) { if (value.result?.status !== "ready") throw new Error(); initialized = true; }
              else { resolve(value.result); child.stdin.end(); }
            } catch { fail("Codex 识别协议响应无效，请重启核心后重试"); stop(); return; }
          }
        });
        child.stdin.on("error", () => fail());
        child.stdin.write(JSON.stringify({ protocolVersion: 1, requestId: initialization, action: "initialize", input: { runtime_dir: options.runtimeDirectory, codex_path: options.cliPath, model: options.model, max_daily_calls: options.dailyCalls } }) + "\n" + request + "\n");
        if (signal?.aborted) abort();
      });
    } finally { stop(); await ended; }
  }
  async close() { this.closed = true; for (const child of this.flights) child.kill("SIGTERM"); await this.queue.catch(() => {}); }
}
