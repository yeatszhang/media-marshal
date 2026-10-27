import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DesktopError } from "@media-marshal/contracts";
import { normalizeParse, type ParsedMedia } from "../domain/media.js";

interface Pending { id: string; resolve(value: unknown): void; reject(error: unknown): void; clear(): void }
export interface NameParser { readonly ready: boolean; start(): Promise<void>; parse(filename: string, signal?: AbortSignal): Promise<ParsedMedia>; close(): Promise<void> }
const unavailable = () => new DesktopError("COMPONENT_UNAVAILABLE", "离线名称解析器不可用，请重试核心或检查安装资源", true);
/** 单通道、有界队列；超时后先确认旧进程退出，再重启，最多恢复三次。 */
export class ParserProcess implements NameParser {
  private child?: ChildProcessWithoutNullStreams; private ended?: Promise<void>; private pending?: Pending;
  private queue: Promise<unknown> = Promise.resolve(); private starting?: Promise<void>; private stopping?: Promise<void>; private closed = false; private count = 0; private launches = 0; private available = false;
  constructor(private readonly executable: string, private readonly options: { args?: readonly string[]; timeoutMs?: number; testNode?: boolean } = {}) {}
  get ready() { return this.available && !!this.child && !this.closed; }
  start(): Promise<void> { if (this.closed) return Promise.reject(unavailable()); return this.starting ??= this.ensure().finally(() => { this.starting = undefined; }); }
  private async ensure() {
    await this.stopping; if (this.ready) return;
    if (this.closed || this.child || this.launches >= 4) throw unavailable();
    this.launches++;
    const env: NodeJS.ProcessEnv = { PATH: process.platform === "win32" ? process.env.SystemRoot + "\\System32" : "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
    for (const key of ["SystemRoot", "TMP", "TEMP", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
    if (this.options.testNode) env.ELECTRON_RUN_AS_NODE = "1";
    const child = spawn(this.executable, [...(this.options.args ?? [])], { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, env });
    this.child = child; let buffer = Buffer.alloc(0);
    this.ended = new Promise<void>((resolve) => child.once("close", () => { if (this.child === child) { this.available = false; this.child = undefined; this.reject(unavailable()); } resolve(); }));
    child.on("error", () => { this.available = false; this.reject(unavailable()); });
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      if (buffer.length + chunk.length > 1024 * 1024 + 1) { this.reject(unavailable()); void this.stopChild().catch(() => {}); return; }
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf(10); if (end < 0) break; const line = buffer.subarray(0, end); buffer = Buffer.from(buffer.subarray(end + 1));
        try {
          const message = JSON.parse(line.toString("utf8")), pending = this.pending;
          if (!pending || !message || typeof message !== "object" || message.protocolVersion !== 1 || message.requestId !== pending.id || typeof message.ok !== "boolean" || Object.keys(message).some((key) => !["protocolVersion", "requestId", "ok", message.ok ? "result" : "error"].includes(key))) throw unavailable();
          if ((message.ok && !Object.hasOwn(message, "result")) || (!message.ok && (!message.error || !["INVALID_REQUEST", "PARSE_FAILED"].includes(message.error.code)))) throw unavailable();
          this.pending = undefined; pending.clear();
          if (message.ok && Object.hasOwn(message, "result")) pending.resolve(message.result);
          else pending.reject(new DesktopError("INVALID_REQUEST", "名称无法解析，请手动核对", true));
        } catch { this.reject(unavailable()); void this.stopChild().catch(() => {}); return; }
      }
    });
    try { const health = await this.request("health"); if (!health || typeof health !== "object" || (health as Record<string, unknown>).status !== "ready" || (health as Record<string, unknown>).guessitVersion !== "3.8.0") throw unavailable(); this.available = true; }
    catch (error) { await this.stopChild(); throw error; }
  }
  parse(filename: string, signal?: AbortSignal): Promise<ParsedMedia> {
    if (this.closed || this.count >= 32) return Promise.reject(unavailable());
    if (!filename.trim() || filename.length > 16384 || /[/\\\0\r\n]/.test(filename)) return Promise.reject(new DesktopError("INVALID_REQUEST", "仅支持有界的名称文本"));
    this.count++;
    const work = this.queue.catch(() => {}).then(async () => {
      if (this.closed || signal?.aborted) throw new DesktopError("INTERRUPTED", "名称解析已停止等待", true);
      await this.start(); const raw = await this.request("parse", filename, signal); return normalizeParse(raw, filename);
    }).finally(() => { this.count--; });
    this.queue = work; return work;
  }
  private request(action: "health" | "parse", filename?: string, signal?: AbortSignal): Promise<unknown> {
    if (!this.child || this.pending || this.closed) return Promise.reject(unavailable());
    const id = randomUUID(), data = JSON.stringify({ protocolVersion: 1, requestId: id, action, ...(action === "parse" ? { filename } : {}) }) + "\n";
    if (Buffer.byteLength(data) > 65536) return Promise.reject(new DesktopError("INVALID_REQUEST", "名称解析请求超过允许大小"));
    return new Promise((resolve, reject) => {
      const abort = () => { this.reject(new DesktopError("INTERRUPTED", "名称解析已停止等待", true)); void this.stopChild().catch(() => {}); }, timer = setTimeout(() => { this.reject(new DesktopError("TIMEOUT", "名称解析超时，请核对名称后重试", true)); void this.stopChild().catch(() => {}); }, this.options.timeoutMs ?? 5000);
      this.pending = { id, resolve, reject, clear: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) { abort(); return; }
      this.child!.stdin.write(data, (error) => { if (error && this.pending?.id === id) { this.reject(unavailable()); void this.stopChild().catch(() => {}); } });
    });
  }
  private reject(error: unknown) { const pending = this.pending; if (pending) { this.pending = undefined; pending.clear(); pending.reject(error); } }
  private stopChild(): Promise<void> {
    return this.stopping ??= (async () => {
      this.available = false; const child = this.child, ended = this.ended; if (!child || !ended) return;
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exited = await Promise.race([ended.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 200); })]); clearTimeout(timer);
      if (!exited && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.race([ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), 2000); })]).finally(() => clearTimeout(timer));
    })().finally(() => { this.stopping = undefined; });
  }
  async close() { this.closed = true; this.reject(new DesktopError("INTERRUPTED", "名称解析器正在停止", true)); await this.stopChild(); await this.queue.catch(() => {}); }
}
