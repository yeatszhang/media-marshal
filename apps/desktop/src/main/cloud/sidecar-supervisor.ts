import { MessageChannelMain, utilityProcess, type UtilityProcess, type MessagePortMain } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CloudError, cloudFailure, cloudFailureSchema, type CloudErrorCode } from "@media-marshal/contracts";
import { HOST_PROTOCOL_VERSION } from "@media-marshal/contracts/internal";
import { RestrictedHostRelay, parseHostRequest, type CoreHostBridge } from "@media-marshal/contracts/internal/rpc";
import { guardianManifestSchema, hostBindingSchema, credentialInstallSchema, credentialDropSchema } from "../../sidecar-host/protocol";
import { sidecarTarget, SidecarBinaryResolver, lockedDefinitions } from "../../sidecar-host/binary-resolver";
import type { HostBinding } from "../../sidecar-host/application";
import { NativeProcessOwnership } from "./process-ownership";
import { ensurePrivateDirectory } from "./private-files";
import { clearPrivateSessions } from "./private-sessions";
import type { ComponentDiagnostic } from "./diagnostics";

export class SidecarSupervisor implements CoreHostBridge {
  generation = randomUUID();
  private coreGeneration?: string;
  private toCore?: (value: unknown) => void;
  private relay?: RestrictedHostRelay;
  private child?: UtilityProcess;
  private port?: MessagePortMain;
  private heartbeat?: ReturnType<typeof setInterval>;
  private exited?: Promise<void>;
  private starting?: Promise<void>;
  private bindings: HostBinding[] = [];
  private stopping = false;
  private uncertain = false;
  private epoch = 0;
  private cleanStop = false;
  private ownership?: NativeProcessOwnership;
  private fault?: CloudErrorCode;
  private credentialRequests = new Map<string, { resolve: () => void; reject: (error: unknown) => void; deadline: ReturnType<typeof setTimeout> }>();
  constructor(private readonly options: { workerPath: string; appPath: string; resourceRoot: string; privateRoot: string }) {}
  diagnostic(): ComponentDiagnostic {
    return { state: this.uncertain ? "UNCERTAIN" : this.stopping && this.child ? "STOPPING" : this.starting ? "STARTING" : this.fault ? "FAILED" : this.child ? "READY" : "DISABLED", configuredAccounts: this.bindings.length, lastFailure: this.fault ?? null };
  }
  attachCore(generation: string, send: (value: unknown) => void) {
    z.uuid().parse(generation);
    this.coreGeneration = generation; this.toCore = send;
    this.relay = new RestrictedHostRelay(
      (message) => { if (!this.port) throw new CloudError("COMPONENT_UNAVAILABLE"); this.port.postMessage(message); },
      (message) => this.toCore?.(message),
      (context) => context.coreGeneration === this.coreGeneration && context.hostGeneration === this.generation && this.bindings.some((binding) => binding.generation === context.bindingGeneration),
    );
    this.port?.postMessage({ kind: "sidecar.authorize-core", coreGeneration: generation });
  }
  receiveCore(value: unknown): boolean {
    if (!this.port) {
      try {
        const request = parseHostRequest(value);
        if (request.context.coreGeneration !== this.coreGeneration) return false;
        this.toCore?.({ kind: "host.response", protocolVersion: HOST_PROTOCOL_VERSION, requestId: request.requestId, context: request.context, ok: false, error: cloudFailure(new CloudError("COMPONENT_UNAVAILABLE")) });
      } catch {}
      return false;
    }
    return this.relay?.receiveCore(value) ?? false;
  }
  async start(bindings: readonly HostBinding[]): Promise<void> {
    if (!bindings.length) return;
    if (this.uncertain || this.child || this.starting) throw new CloudError("CONFLICT");
    const valid = z.array(hostBindingSchema).min(1).max(100).parse(bindings);
    if (!this.coreGeneration) throw new CloudError("COMPONENT_UNAVAILABLE");
    this.stopping = false;
    const epoch = ++this.epoch;
    this.starting = this.spawn(valid, epoch, this.coreGeneration).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async spawn(bindings: HostBinding[], epoch: number, coreGeneration: string) {
    const target = sidecarTarget(process.platform, process.arch);
    // 开发态取工作区元数据，安装态由 ASAR 内受保护的构建清单提供；不读 userData 的摘要。
    let guardian;
    try {
      guardian = guardianManifestSchema.parse(JSON.parse(await readFile(join(this.options.appPath, "resources/sidecars", target, "guardian.json"), "utf8")));
      if (guardian.target !== target) throw new Error();
    } catch { throw new CloudError("COMPONENT_UNAVAILABLE"); }
    const binaries = await new SidecarBinaryResolver(this.options.resourceRoot, target, lockedDefinitions(target, guardian.binary)).resolve();
    await ensurePrivateDirectory(this.options.privateRoot);
    this.ownership = new NativeProcessOwnership(this.options.privateRoot, binaries);
    // 新 Main 同样从 OS 扫描旧 session，覆盖强杀前 started 消息尚未送达的窗口。
    await this.ownership.reap();
    await clearPrivateSessions(this.options.privateRoot);
    if (epoch !== this.epoch || this.stopping || coreGeneration !== this.coreGeneration) throw new CloudError("INTERRUPTED");
    this.generation = randomUUID(); this.bindings = bindings; this.stopping = false;
    this.cleanStop = false;
    this.fault = undefined;
    this.toCore?.({ kind: "sidecar.generation", hostGeneration: this.generation });
    const child = utilityProcess.fork(this.options.workerPath, [], { serviceName: "Media Marshal Sidecar Host", stdio: "pipe" });
    this.child = child;
    child.stdout?.on("data", () => {}); child.stderr?.on("data", () => {});
    const { port1, port2 } = new MessageChannelMain(); this.port = port1;
    let resolveReady!: () => void, rejectReady!: (reason: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const deadline = setTimeout(() => { rejectReady(new CloudError("TIMEOUT")); child.kill(); }, 30000);
    let nativeBarrier = Promise.resolve();
    let guardianExecutionId: string | undefined;
    port1.on("message", ({ data }) => {
      if (this.child !== child) return;
      if (data?.kind === "sidecar.native" && data.hostGeneration === this.generation) {
        nativeBarrier = nativeBarrier.then(async () => {
          if (data.type === "started" && z.uuid().safeParse(data.executionId).success && Number.isSafeInteger(data.pid) && data.pid > 0 && (data.program === "guardian" || data.program === "openlist" || data.program === "rclone")) {
            if (data.program === "guardian") guardianExecutionId = data.executionId;
            const parent = data.program === "guardian" ? child.pid : guardianExecutionId ? this.ownership?.parent(guardianExecutionId) : undefined;
            if (!parent) throw new CloudError("CONFLICT");
            await this.ownership!.register(data.executionId, data.pid, parent, binaries[data.program as keyof typeof binaries]);
          } else if (data.type === "exited" && z.uuid().safeParse(data.executionId).success) await this.ownership!.stopped(data.executionId);
          else if (data.type === "lost") throw new CloudError("COMPONENT_UNAVAILABLE");
          else throw new CloudError("INVALID_REQUEST");
        }).catch(() => { this.uncertain = true; this.fault = "COMPONENT_UNAVAILABLE"; this.relay?.invalidate(); child.kill(); });
        return;
      }
      if (data?.kind === "sidecar.ready" && data.protocolVersion === HOST_PROTOCOL_VERSION && data.hostGeneration === this.generation) {
        void nativeBarrier.then(() => { clearTimeout(deadline); if (this.uncertain) rejectReady(new CloudError("CONFLICT")); else resolveReady(); }); return;
      }
      if (data?.kind === "sidecar.failed") {
        const failure = cloudFailureSchema.safeParse(data.error);
        this.fault = failure.success ? failure.data.code : "COMPONENT_UNAVAILABLE";
        this.relay?.invalidate(); this.toCore?.({ kind: "sidecar.lost", hostGeneration: this.generation });
        rejectReady(new CloudError("COMPONENT_UNAVAILABLE")); return;
      }
      if (data?.kind === "sidecar.stopped" && data.hostGeneration === this.generation && data.stopped === true) { this.cleanStop = true; return; }
      if (data?.kind === "sidecar.credential.result" && data.ok === true) {
        const pending = this.credentialRequests.get(data.requestId);
        if (pending) { clearTimeout(pending.deadline); this.credentialRequests.delete(data.requestId); pending.resolve(); } return;
      }
      this.relay?.receiveHost(data);
    });
    port1.start();
    this.exited = new Promise<void>((resolve) => child.once("exit", () => {
      clearTimeout(deadline); clearInterval(this.heartbeat); port1.close();
      rejectReady(new CloudError("COMPONENT_UNAVAILABLE"));
      this.relay?.invalidate();
      if (!this.stopping) this.fault ??= "COMPONENT_UNAVAILABLE";
      for (const pending of this.credentialRequests.values()) { clearTimeout(pending.deadline); pending.reject(new CloudError("INTERRUPTED")); }
      this.credentialRequests.clear();
      if (!this.stopping) this.toCore?.({ kind: "sidecar.lost", hostGeneration: this.generation });
      void (async () => {
        await nativeBarrier;
        try { await this.ownership!.reap(); await clearPrivateSessions(this.options.privateRoot); this.uncertain = false; }
        catch { this.uncertain = true; }
        if (this.child === child) { this.child = undefined; this.port = undefined; }
        resolve();
      })();
    }));
    child.once("spawn", () => {
      child.postMessage({ kind: "sidecar.initialize", protocolVersion: HOST_PROTOCOL_VERSION, hostGeneration: this.generation, coreGeneration: this.coreGeneration, resourceRoot: this.options.resourceRoot, privateRoot: this.options.privateRoot, guardian, bindings }, [port2]);
      this.heartbeat = setInterval(() => { try { port1.postMessage({ kind: "sidecar.heartbeat" }); } catch { this.uncertain = true; child.kill(); } }, 250);
    });
    try { await ready; } catch (error) { await this.stop(); throw error; }
  }
  async detachCore(generation: string): Promise<void> {
    if (generation !== this.coreGeneration) return;
    this.coreGeneration = undefined; this.toCore = undefined; this.relay?.invalidate();
    await this.stop();
  }
  async installCredential(binding: HostBinding, secret: string): Promise<void> {
    const payload = credentialInstallSchema.parse({ kind: "sidecar.credential.install", requestId: randomUUID(), binding, secret });
    if (!this.child) await this.start([payload.binding]);
    await this.credentialRequest(payload);
    this.bindings = [...this.bindings.filter((entry) => entry.accountId !== payload.binding.accountId), { ...payload.binding }];
  }
  async dropCredential(accountId: string): Promise<void> {
    if (this.uncertain) throw new CloudError("CONFLICT");
    if (this.port) await this.credentialRequest(credentialDropSchema.parse({ kind: "sidecar.credential.drop", requestId: randomUUID(), accountId }));
    this.bindings = this.bindings.filter((binding) => binding.accountId !== accountId);
  }
  async quiesceAccount(_: string): Promise<void> {
    // 传输执行器接入前没有 Go 写入者；未知 Host 状态始终阻止凭据轮换。
    if (this.uncertain) throw new CloudError("CONFLICT");
  }
  private credentialRequest(payload: z.infer<typeof credentialInstallSchema> | z.infer<typeof credentialDropSchema>): Promise<void> {
    if (!this.port || this.credentialRequests.size >= 32) return Promise.reject(new CloudError("COMPONENT_UNAVAILABLE"));
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { this.credentialRequests.delete(payload.requestId); reject(new CloudError("TIMEOUT")); }, 10000);
      this.credentialRequests.set(payload.requestId, { resolve, reject, deadline });
      try { this.port!.postMessage(payload); } catch { clearTimeout(deadline); this.credentialRequests.delete(payload.requestId); reject(new CloudError("INTERRUPTED")); }
    });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.epoch++;
    this.relay?.invalidate();
    const child = this.child;
    if (!child) { if (this.uncertain) { await this.ownership?.reap(); await clearPrivateSessions(this.options.privateRoot); this.uncertain = false; } return; }
    this.port?.postMessage({ kind: "sidecar.shutdown" });
    const deadline = setTimeout(() => child.kill(), 8000);
    try { await this.exited; if (this.uncertain) throw new CloudError("COMPONENT_UNAVAILABLE"); } finally { clearTimeout(deadline); }
  }
}
