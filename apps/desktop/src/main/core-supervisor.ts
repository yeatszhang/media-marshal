import {
  MessageChannelMain,
  utilityProcess,
  type UtilityProcess,
  type MessagePortMain,
} from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DesktopError,
  PROTOCOL_VERSION,
  MAX_RESPONSE_BYTES,
  checkMessageSize,
  coreActions,
  responseSchema,
  type CoreAction,
  type CoreInput,
  type CoreOutput,
  type DesktopRuntime,
} from "@media-marshal/contracts";
import type { CoreHostBridge } from "@media-marshal/contracts/internal/rpc";
import { privateCoreActions, privateCoreResponseSchema, type PrivateCoreAction, type PrivateCoreInput, type PrivateCoreOutput } from "@media-marshal/contracts/internal/core";
import { CloudError, cloudErrorCodeSchema } from "@media-marshal/contracts";
import type { NativeFileLaunch, ParserLaunch } from "@media-marshal/contracts/internal";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
export class CoreSupervisor {
  private child?: UtilityProcess;
  private port?: MessagePortMain;
  private exited?: Promise<void>;
  private pending = new Map<string, Pending>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private stopping = false;
  private stopEpoch = 0;
  private starting?: Promise<void>;
  state: DesktopRuntime["core"] = "starting";
  detail: string | null = null;
  beforeStart?: () => Promise<void>;
  onReady?: () => Promise<void>;
  constructor(
    private readonly workerPath: string,
    private readonly dataDir: string,
    private hostBridge?: CoreHostBridge,
    private readonly parser?: () => Promise<ParserLaunch | undefined>,
    private readonly nativeFiles?: () => Promise<NativeFileLaunch | undefined>,
  ) {}
  attachHostBridge(bridge: CoreHostBridge): void {
    if (this.child || this.starting) throw new DesktopError("CONFLICT", "核心运行期间不能更换宿主通道");
    this.hostBridge = bridge;
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = this.spawn().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async spawn(): Promise<void> {
    if (this.child) throw new DesktopError("CONFLICT", "旧核心尚未退出");
    this.state = "starting";
    this.detail = null;
    try { await this.beforeStart?.(); }
    catch (error) {
      if (!this.stopping) { this.state = "failed"; this.detail = "启动前检查未完成，请检查升级备份，或从应用菜单恢复匹配备份"; }
      throw error;
    }
    if (this.stopping) throw new DesktopError("INTERRUPTED", "核心启动已停止", true);
    const parser = await this.parser?.();
    if (this.stopping) throw new DesktopError("INTERRUPTED", "核心启动已停止", true);
    const nativeFiles = await this.nativeFiles?.();
    if (this.stopping) throw new DesktopError("INTERRUPTED", "核心启动已停止", true);
    const child = utilityProcess.fork(this.workerPath, [], {
      serviceName: "Media Marshal Core",
      stdio: "pipe",
    });
    this.child = child;
    const { port1, port2 } = new MessageChannelMain();
    this.port = port1;
    const coreGeneration = randomUUID();
    const hostGeneration = this.hostBridge?.generation ?? randomUUID();
    this.hostBridge?.attachCore(coreGeneration, (message) => port1.postMessage(message));
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // 子进程错误不直接输出，避免原始数据库/文件错误泄漏个人路径。
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    let readyResolve!: () => void, readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const readyTimer = setTimeout(() => {
      readyReject(new DesktopError("TIMEOUT", "核心启动超时", true));
      child.kill();
    }, 15000);
    const fail = () => {
      clearTimeout(readyTimer);
      readyReject(
        new DesktopError("CORE_UNAVAILABLE", "媒体核心启动失败或已中断", true),
      );
    };
    port1.on("message", (event) => {
      const message: unknown = event.data;
      try {
        checkMessageSize(message, MAX_RESPONSE_BYTES);
      } catch {
        child.kill();
        return;
      }
      if (message && typeof message === "object" && "kind" in message && message.kind === "host.request") {
        this.hostBridge?.receiveCore(message);
        return;
      }
      if (
        message &&
        typeof message === "object" &&
        "kind" in message &&
        message.kind === "ready"
      ) {
        if (this.stopping || this.child !== child) { fail(); child.kill(); return; }
        if (
          !("protocolVersion" in message) ||
          message.protocolVersion !== PROTOCOL_VERSION
        ) {
          fail();
          child.kill();
          return;
        }
        clearTimeout(readyTimer);
        this.state = "ready";
        this.detail = null;
        readyResolve();
        void this.onReady?.().catch(() => {});
        return;
      }
      const privateResponse = privateCoreResponseSchema.safeParse(message);
      if (privateResponse.success) {
        const response = privateResponse.data, pending = this.pending.get(response.requestId);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(response.requestId);
        if (response.ok) pending.resolve(response.result);
        else {
          const code = cloudErrorCodeSchema.safeParse(response.error.code);
          const cloud = code.success ? new CloudError(code.data, response.error.retryAfterSeconds, response.error.directoryIssue) : null;
          pending.reject(cloud?.message === response.error.message ? cloud : new DesktopError(response.error.code, response.error.message, response.error.retryable, response.error.retryAfterSeconds, response.error.directoryIssue));
        }
        return;
      }
      const parsed = responseSchema.safeParse(message);
      if (!parsed.success) return;
      const response = parsed.data,
        pending = this.pending.get(response.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.requestId);
      if (response.ok) pending.resolve(response.result);
      else
        pending.reject(
          new DesktopError(
            response.error.code,
            response.error.message,
            response.error.retryable,
            response.error.retryAfterSeconds,
            response.error.directoryIssue,
          ),
        );
    });
    port1.start();
    this.exited = new Promise<void>((resolve) =>
      child.once("exit", () => {
        clearInterval(heartbeat);
        fail();
        port1.close();
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(
            new DesktopError(
              "INTERRUPTED",
              "核心已中断，请查询当前状态后重试",
              true,
            ),
          );
        }
        this.pending.clear();
        this.state = this.stopping ? "stopping" : "failed";
        this.detail = this.stopping
          ? null
          : "媒体核心已中断，正在恢复或等待重试";
        void (async () => {
          let stopped = true;
          try { await this.hostBridge?.detachCore(coreGeneration); } catch { stopped = false; this.detail = "旧云端执行尚未确认停止，核心恢复已阻断"; }
          if (this.child === child) { this.child = undefined; this.port = undefined; }
          resolve();
          if (stopped && !this.stopping && this.attempts < 3) {
            this.attempts++;
            this.retryTimer = setTimeout(() => { void this.start().catch(() => {}); }, this.attempts * 1000);
          }
        })();
      }),
    );
    child.once("spawn", () => {
      child.postMessage(
        {
          kind: "initialize",
          protocolVersion: PROTOCOL_VERSION,
          databasePath: join(this.dataDir, "desktop.sqlite3"),
          coreGeneration, hostGeneration,
          ...(parser ? { parser } : {}),
          ...(nativeFiles ? { nativeFiles } : {}),
        },
        [port2],
      );
      heartbeat = setInterval(() => { try { port1.postMessage({ kind: "core.heartbeat", protocolVersion: PROTOCOL_VERSION }); } catch {} }, 500);
    });
    try {
      await ready;
    } catch (error) {
      this.state = this.stopping ? "stopping" : "failed";
      this.detail = this.stopping ? null : "媒体核心不可用，请重试或检查诊断";
      throw error;
    }
  }
  async request<K extends CoreAction>(
    action: K,
    payload: CoreInput<K>,
  ): Promise<CoreOutput<K>> {
    if (this.state !== "ready" || !this.port)
      throw new DesktopError("CORE_UNAVAILABLE", "媒体核心尚未就绪", true);
    if (this.pending.size >= 64)
      throw new DesktopError("CONFLICT", "请求过多，请稍后重试", true);
    const input = coreActions[action].input.parse(payload);
    const requestId = randomUUID();
    const message = {
      kind: "request",
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      action,
      payload: input,
    };
    checkMessageSize(message);
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new DesktopError(
            "TIMEOUT",
            "请求等待超时，请查询状态，不要重复提交",
            true,
          ),
        );
      }, 15000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.port!.postMessage(message);
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new DesktopError("INTERRUPTED", "核心通信已中断", true));
      }
    });
    return coreActions[action].output.parse(result) as CoreOutput<K>;
  }
  async restart(): Promise<void> {
    const epoch = this.stopEpoch + 1;
    await this.stop();
    await this.starting?.catch(() => {});
    if (this.stopEpoch !== epoch) throw new DesktopError("INTERRUPTED", "核心重启已被停止操作撤销", true);
    this.attempts = 0;
    await this.start();
  }
  async requestPrivate<K extends PrivateCoreAction>(action: K, payload: PrivateCoreInput<K>): Promise<PrivateCoreOutput<K>> {
    if (this.state !== "ready" || !this.port) throw new CloudError("COMPONENT_UNAVAILABLE");
    if (this.pending.size >= 64) throw new CloudError("CONFLICT");
    const requestId = randomUUID(), message = { kind: "core.private.request", requestId, action, payload: privateCoreActions[action].input.parse(payload) };
    checkMessageSize(message);
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new CloudError("TIMEOUT")); }, 15000);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.port!.postMessage(message); }
      catch { clearTimeout(timer); this.pending.delete(requestId); reject(new CloudError("INTERRUPTED")); }
    });
    return privateCoreActions[action].output.parse(result) as PrivateCoreOutput<K>;
  }
  async stop(): Promise<void> {
    this.stopEpoch++;
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    // 启动也受管理；关闭不能遗漏尚未握手的子进程。
    const child = this.child;
    this.state = "stopping";
    if (!child) return;
    this.port?.postMessage({
      kind: "shutdown",
      protocolVersion: PROTOCOL_VERSION,
    });
    const timer = setTimeout(() => child.kill(), 8000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
