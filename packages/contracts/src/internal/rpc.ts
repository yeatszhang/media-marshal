import {
  CloudError, cloudFailure, type CloudFailure,
} from "../cloud/index.js";
import {
  HOST_PROTOCOL_VERSION, executionContextSchema, executionHandleSchema, hostActions,
  hostEventSchema, hostRequestSchema, hostResponseSchema,
  type ExecutionContext, type ExecutionHandle, type HostAction, type HostEvent,
  type HostInput, type HostOutput, type HostRequest, type HostResponse,
} from "./index.js";

type Send = (value: HostRequest | HostResponse | HostEvent) => void;
type Authority = (context: ExecutionContext) => boolean;
export interface CoreHostBridge {
  readonly generation: string;
  attachCore(generation: string, send: (value: unknown) => void): void;
  receiveCore(value: unknown): boolean;
  detachCore(generation: string): Promise<void>;
}
export interface CoreHostGateway {
  context(bindingGeneration: string, attemptId: string): ExecutionContext;
  request<K extends HostAction>(action: K, payload: HostInput<K>, context: ExecutionContext, idempotencyKey: string): Promise<HostOutput<K>>;
}
export type HostHandlers = { [K in HostAction]: (payload: HostInput<K>, context: ExecutionContext) => Promise<HostOutput<K>> | HostOutput<K> };
const MAX_REQUEST = 64 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
function bounded(value: unknown, limit: number) {
  try {
    const json = JSON.stringify(value);
    if (!json || new TextEncoder().encode(json).length > limit) throw new Error();
  } catch { throw new CloudError("INVALID_REQUEST"); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function sameContext(a: ExecutionContext, b: ExecutionContext) {
  return a.coreGeneration === b.coreGeneration && a.hostGeneration === b.hostGeneration &&
    a.bindingGeneration === b.bindingGeneration && a.attemptId === b.attemptId;
}
export function parseHostRequest(value: unknown): HostRequest {
  bounded(value, MAX_REQUEST);
  const parsed = hostRequestSchema.safeParse(value);
  if (!parsed.success) throw new CloudError("INVALID_REQUEST");
  const request = parsed.data;
  const payload = hostActions[request.action].input.safeParse(request.payload);
  if (!payload.success) throw new CloudError("INVALID_REQUEST");
  request.payload = payload.data;
  const context = request.context;
  const matchesBinding = (binding: { generation: string }) => binding.generation === context.bindingGeneration;
  switch (request.action) {
    case "provider.capabilities":
      if (!matchesBinding(payload.data as HostInput<"provider.capabilities">)) throw new CloudError("INTERRUPTED");
      break;
    case "provider.list":
    case "provider.stat":
      if (!matchesBinding((payload.data as HostInput<"provider.list">).binding)) throw new CloudError("INTERRUPTED");
      break;
    case "transfer.start": {
      const plan = payload.data as HostInput<"transfer.start">;
      const first = plan.items[0]!.source.binding;
      if (plan.attemptId !== context.attemptId || plan.items.some((item) =>
        !matchesBinding(item.source.binding) || item.source.binding.accountId !== first.accountId || item.source.binding.bindingId !== first.bindingId))
        throw new CloudError("INTERRUPTED");
      break;
    }
    case "transfer.stop": {
      const handle = payload.data as ExecutionHandle;
      if (handle.attemptId !== context.attemptId || handle.hostGeneration !== context.hostGeneration) throw new CloudError("INTERRUPTED");
      break;
    }
    case "transfer.status":
      if ((payload.data as HostInput<"transfer.status">).attemptId !== context.attemptId) throw new CloudError("INTERRUPTED");
  }
  return request;
}
function failureResponse(request: HostRequest, error: unknown): HostResponse {
  return { kind: "host.response", protocolVersion: HOST_PROTOCOL_VERSION, requestId: request.requestId, context: request.context, ok: false, error: cloudFailure(error) };
}
function errorFromFailure(failure: CloudFailure) { return new CloudError(failure.code, failure.retryAfterSeconds); }

// 幂等收据在当前受权代际内保留；满额时拒绝新执行，绝不淘汰收据后重放写入。
export class RestrictedHostServer {
  private receipts = new Map<string, { signature: string; result: Promise<unknown> }>();
  private keys = new Map<string, string>();
  private active = 0;
  private retired = false;
  constructor(private readonly handlers: HostHandlers, private readonly current: Authority, private readonly maximum = 512) {}
  async receive(value: unknown): Promise<HostResponse> {
    const request = parseHostRequest(value);
    try {
      if (this.retired || !this.current(request.context)) throw new CloudError("INTERRUPTED");
      const mutating = request.action === "transfer.start" || request.action === "transfer.stop";
      let result: unknown;
      if (mutating) {
        const scope = canonical(request.context);
        const key = `${scope}:${request.idempotencyKey}`;
        const intent = `${scope}:${request.action}`;
        const signature = canonical({ action: request.action, payload: request.payload });
        const priorKey = this.keys.get(key);
        if (priorKey && priorKey !== signature) throw new CloudError("CONFLICT");
        const receipt = this.receipts.get(intent);
        if (receipt && receipt.signature !== signature) throw new CloudError("CONFLICT");
        if (receipt) {
          if (!priorKey && this.keys.size >= this.maximum) throw new CloudError("CONFLICT");
          this.keys.set(key, signature);
          result = await receipt.result;
        } else {
          if (this.receipts.size >= this.maximum || this.keys.size >= this.maximum || this.active >= 64) throw new CloudError("CONFLICT");
          // 先占据意图，再执行异步处理器；重复消息共享同一个 Promise。
          const execution = Promise.resolve().then(() => this.execute(request));
          this.keys.set(key, signature);
          this.receipts.set(intent, { signature, result: execution });
          result = await execution;
        }
      } else {
        if (this.active >= 64) throw new CloudError("CONFLICT");
        result = await this.execute(request);
      }
      if (this.retired || !this.current(request.context)) throw new CloudError("INTERRUPTED");
      const response: HostResponse = { kind: "host.response", protocolVersion: HOST_PROTOCOL_VERSION, requestId: request.requestId, context: request.context, ok: true, result };
      bounded(response, MAX_RESPONSE);
      return response;
    } catch (error) { return failureResponse(request, error); }
  }
  private async execute(request: HostRequest): Promise<unknown> {
    if (this.active >= 64) throw new CloudError("CONFLICT");
    this.active++;
    try {
      if (this.retired || !this.current(request.context)) throw new CloudError("INTERRUPTED");
      // 动作与入参在 parseHostRequest 中关联校验，返回值还须按同一动作校验。
      const handler = this.handlers[request.action] as (input: unknown, context: ExecutionContext) => unknown;
      const result = hostActions[request.action].output.parse(await handler(request.payload, request.context));
      if (request.action === "transfer.start") {
        const handle = result as ExecutionHandle;
        if (handle.attemptId !== request.context.attemptId || handle.hostGeneration !== request.context.hostGeneration) throw new CloudError("COMPONENT_UNAVAILABLE");
      }
      return result;
    } finally { this.active--; }
  }
  retire() {
    // 退役不可逆；停止 OS 执行由生命周期层完成，不能借清缓存重新接受同代际写入。
    this.retired = true;
    this.receipts.clear();
    this.keys.clear();
  }
}

interface Pending {
  request: HostRequest;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
export class RestrictedHostClient {
  private pending = new Map<string, Pending>();
  private streams = new Map<string, { context: ExecutionContext; last: number; listener: (event: HostEvent) => void }>();
  constructor(private readonly send: Send, private readonly current: Authority, private readonly timeoutMs = 15000) {}
  request<K extends HostAction>(action: K, payload: HostInput<K>, context: ExecutionContext, idempotencyKey: string): Promise<HostOutput<K>> {
    if (!this.current(context)) return Promise.reject(new CloudError("INTERRUPTED"));
    if (this.pending.size >= 64) return Promise.reject(new CloudError("CONFLICT"));
    let request: HostRequest;
    try {
      request = parseHostRequest({ kind: "host.request", protocolVersion: HOST_PROTOCOL_VERSION, requestId: globalThis.crypto.randomUUID(), idempotencyKey, context, action, payload });
    } catch (error) { return Promise.reject(error); }
    return new Promise<HostOutput<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        // 不自动重发；调用方凭 attempt 查询，重试也必须复用原意图。
        reject(new CloudError("TIMEOUT"));
      }, this.timeoutMs);
      this.pending.set(request.requestId, { request, resolve: resolve as (value: unknown) => void, reject, timer });
      try { this.send(request); } catch {
        clearTimeout(timer); this.pending.delete(request.requestId); reject(new CloudError("INTERRUPTED"));
      }
    });
  }
  receive(value: unknown): boolean {
    try { bounded(value, MAX_RESPONSE); } catch { return false; }
    const event = hostEventSchema.safeParse(value);
    if (event.success) {
      const stream = this.streams.get(event.data.executionId);
      if (!stream || !this.current(event.data.context) || !sameContext(stream.context, event.data.context) || event.data.sequence <= stream.last) return false;
      stream.last = event.data.sequence;
      stream.listener(event.data);
      return true;
    }
    const response = hostResponseSchema.safeParse(value);
    if (!response.success) return false;
    const pending = this.pending.get(response.data.requestId);
    if (!pending || !sameContext(pending.request.context, response.data.context) || !this.current(response.data.context)) return false;
    clearTimeout(pending.timer); this.pending.delete(response.data.requestId);
    if (!response.data.ok) pending.reject(errorFromFailure(response.data.error));
    else {
      const result = hostActions[pending.request.action].output.safeParse(response.data.result);
      if (result.success) pending.resolve(result.data);
      else pending.reject(new CloudError("COMPONENT_UNAVAILABLE"));
    }
    return true;
  }
  observe(handle: ExecutionHandle, context: ExecutionContext, listener: (event: HostEvent) => void): () => void {
    executionHandleSchema.parse(handle); executionContextSchema.parse(context);
    if (!this.current(context) || handle.attemptId !== context.attemptId || handle.hostGeneration !== context.hostGeneration) throw new CloudError("INTERRUPTED");
    if (this.streams.has(handle.executionId) || this.streams.size >= 64) throw new CloudError("CONFLICT");
    this.streams.set(handle.executionId, { context: { ...context }, last: 0, listener });
    return () => { this.streams.delete(handle.executionId); };
  }
  invalidate() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new CloudError("INTERRUPTED")); }
    this.pending.clear(); this.streams.clear();
  }
}

// Main 独占转发入口；Preload 与 Renderer 不持有这两个私有端口。
export class RestrictedHostRelay {
  private pending = new Map<string, HostRequest>();
  constructor(private readonly toHost: Send, private readonly toCore: Send, private readonly current: Authority) {}
  receiveCore(value: unknown): boolean {
    let request: HostRequest;
    try { request = parseHostRequest(value); } catch { return false; }
    if (!this.current(request.context)) { this.toCore(failureResponse(request, new CloudError("INTERRUPTED"))); return false; }
    const existing = this.pending.get(request.requestId);
    if (existing) {
      if (canonical(existing) !== canonical(request)) this.toCore(failureResponse(request, new CloudError("CONFLICT")));
      return false;
    }
    if (this.pending.size >= 64) { this.toCore(failureResponse(request, new CloudError("CONFLICT"))); return false; }
    this.pending.set(request.requestId, request);
    try { this.toHost(request); } catch {
      this.pending.delete(request.requestId); this.toCore(failureResponse(request, new CloudError("COMPONENT_UNAVAILABLE")));
    }
    return true;
  }
  receiveHost(value: unknown): boolean {
    try { bounded(value, MAX_RESPONSE); } catch { return false; }
    const event = hostEventSchema.safeParse(value);
    if (event.success) {
      if (!this.current(event.data.context)) return false;
      this.toCore(event.data); return true;
    }
    const parsed = hostResponseSchema.safeParse(value);
    if (!parsed.success) return false;
    const response = parsed.data;
    const request = this.pending.get(response.requestId);
    if (!request || !this.current(response.context) || !sameContext(request.context, response.context)) return false;
    this.pending.delete(response.requestId);
    if (response.ok && !hostActions[request.action].output.safeParse(response.result).success)
      this.toCore(failureResponse(request, new CloudError("COMPONENT_UNAVAILABLE")));
    else this.toCore(response);
    return true;
  }
  invalidate() { this.pending.clear(); }
}
