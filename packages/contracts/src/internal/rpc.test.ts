import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { CloudError } from "../cloud/index";
import {
  HOST_PROTOCOL_VERSION, type ExecutionContext, type ExecutionHandle, type HostEvent, type TransferPlan,
} from "./index";
import { RestrictedHostClient, RestrictedHostRelay, RestrictedHostServer, parseHostRequest, type HostHandlers } from "./rpc";

afterEach(() => vi.useRealTimers());
const context = (): ExecutionContext => ({ coreGeneration: randomUUID(), hostGeneration: randomUUID(), bindingGeneration: randomUUID(), attemptId: randomUUID() });
function fixture() {
  const ctx = context();
  const binding = { accountId: randomUUID(), bindingId: randomUUID(), generation: ctx.bindingGeneration };
  const plan: TransferPlan = { attemptId: ctx.attemptId, targetGrantId: randomUUID(), items: [{ itemId: randomUUID(), source: { binding, remoteRef: randomUUID(), locator: { kind: "path", segments: ["sample.txt"] }, expectedVersion: null }, targetSegments: ["sample.txt"], expectedSize: 10 }] };
  const handle: ExecutionHandle = { executionId: randomUUID(), attemptId: ctx.attemptId, hostGeneration: ctx.hostGeneration };
  return { ctx, binding, plan, handle };
}
function handlers(handle: ExecutionHandle): HostHandlers {
  return {
    "provider.capabilities": () => ({ authorizationMethods: ["cookie"], accountIdentity: "unavailable", objectIdentity: "path", reliableRevision: false, hashAlgorithms: [], rangeRead: "supported", sourceKinds: ["webdav"] }),
    "provider.list": () => ({ entries: [], nextCursor: null, total: 0, complete: true }),
    "provider.stat": (input) => ({ accountId: input.binding.accountId, name: "sample.txt", type: "file", size: 10, modifiedAt: null, version: null }),
    "transfer.start": vi.fn(() => handle),
    "transfer.stop": vi.fn(() => ({ stopped: true as const })),
    "transfer.status": () => ({ handle, state: "RUNNING", lastSequence: 0, exitCode: null }),
  };
}
function connect(dispatch: HostHandlers, current: (ctx: ExecutionContext) => boolean = () => true, timeout = 15000) {
  let client: RestrictedHostClient;
  const server = new RestrictedHostServer(dispatch, current);
  const returned: unknown[] = [];
  const forwarded: unknown[] = [];
  const relay = new RestrictedHostRelay(
    (message) => { forwarded.push(message); void server.receive(message).then((response) => relay.receiveHost(response)); },
    (message) => { returned.push(message); client.receive(message); }, current,
  );
  client = new RestrictedHostClient((message) => { relay.receiveCore(message); }, current, timeout);
  return { client, relay, server, returned, forwarded };
}

describe("Core → Main → Host 受限反向 RPC", () => {
  it("长传输立即返回稳定执行 ID，查询走独立请求", async () => {
    const { ctx, plan, handle } = fixture();
    const dispatch = handlers(handle);
    const wire = connect(dispatch);
    const result = await wire.client.request("transfer.start", plan, ctx, randomUUID());
    expect(result).toEqual(handle);
    expect(await wire.client.request("transfer.status", { attemptId: ctx.attemptId }, ctx, randomUUID())).toMatchObject({ state: "RUNNING", handle });
    expect(dispatch["transfer.start"]).toHaveBeenCalledOnce();
  });
  it("重复键与重复 attempt 共用一次执行，变更输入被拒绝", async () => {
    const { ctx, plan, handle } = fixture();
    const dispatch = handlers(handle);
    const { client } = connect(dispatch);
    const key = randomUUID();
    const results = await Promise.all([client.request("transfer.start", plan, ctx, key), client.request("transfer.start", plan, ctx, key)]);
    expect(results).toEqual([handle, handle]);
    expect(await client.request("transfer.start", plan, ctx, randomUUID())).toEqual(handle);
    await expect(client.request("transfer.start", { ...plan, targetGrantId: randomUUID() }, ctx, key)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dispatch["transfer.start"]).toHaveBeenCalledOnce();
  });
  it("超时不重发写入，同一意图重试仍取得原执行收据", async () => {
    vi.useFakeTimers();
    const { ctx, plan, handle } = fixture();
    const dispatch = handlers(handle);
    let release!: (value: ExecutionHandle) => void;
    dispatch["transfer.start"] = vi.fn(() => new Promise<ExecutionHandle>((resolve) => { release = resolve; }));
    const { client, forwarded } = connect(dispatch, () => true, 10);
    const key = randomUUID();
    const pending = expect(client.request("transfer.start", plan, ctx, key)).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(forwarded).toHaveLength(1);
    release(handle);
    await vi.advanceTimersByTimeAsync(0);
    expect(await client.request("transfer.start", plan, ctx, key)).toEqual(handle);
    expect(dispatch["transfer.start"]).toHaveBeenCalledOnce();
  });
  it("事件乱序、重复和旧代际均不推进当前观测", () => {
    const { ctx, handle } = fixture();
    const client = new RestrictedHostClient(() => {}, () => true);
    const listener = vi.fn();
    client.observe(handle, ctx, listener);
    const event: HostEvent = { kind: "host.event", protocolVersion: HOST_PROTOCOL_VERSION, context: ctx, executionId: handle.executionId, sequence: 2, event: { type: "progress", bytes: 5, totalBytes: null, bytesPerSecond: 1 } };
    expect(client.receive(event)).toBe(true);
    expect(client.receive({ ...event, sequence: 1 })).toBe(false);
    expect(client.receive(event)).toBe(false);
    expect(client.receive({ ...event, sequence: 3, context: { ...ctx, bindingGeneration: randomUUID() } })).toBe(false);
    client.invalidate();
    expect(client.receive({ ...event, sequence: 3 })).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });
  it("撤销代际会拒绝等待者，并丢弃旧宿主迟到的成功", async () => {
    const { ctx, plan, handle } = fixture();
    let active = true;
    let release!: (value: ExecutionHandle) => void;
    const dispatch = handlers(handle);
    dispatch["transfer.start"] = () => new Promise((resolve) => { release = resolve; });
    const wire = connect(dispatch, () => active);
    const pending = expect(wire.client.request("transfer.start", plan, ctx, randomUUID())).rejects.toMatchObject({ code: "INTERRUPTED" });
    await Promise.resolve();
    active = false;
    wire.client.invalidate(); wire.relay.invalidate(); wire.server.retire();
    release(handle);
    await pending;
    await Promise.resolve(); await Promise.resolve();
    expect(wire.returned).toHaveLength(0);
    await expect(wire.client.request("transfer.start", plan, ctx, randomUUID())).rejects.toMatchObject({ code: "INTERRUPTED" });
  });
  it("私有协议也拒绝未知动作、原始参数和跨 attempt 输入", () => {
    const { ctx, plan } = fixture();
    const request = { kind: "host.request", protocolVersion: HOST_PROTOCOL_VERSION, requestId: randomUUID(), idempotencyKey: randomUUID(), context: ctx, action: "transfer.start", payload: plan };
    expect(parseHostRequest(request).payload).toEqual(plan);
    for (const change of [{ action: "shell.exec" }, { payload: { ...plan, binary: "/tmp/other" } }, { context: { ...ctx, attemptId: randomUUID() } }])
      expect(() => parseHostRequest({ ...request, ...change })).toThrow(CloudError);
  });
  it("退役实例不能因释放收据而重新执行，容量耗尽也不淘汰旧收据", async () => {
    const { ctx, plan, handle } = fixture();
    const dispatch = handlers(handle);
    const server = new RestrictedHostServer(dispatch, () => true, 1);
    const request = { kind: "host.request", protocolVersion: HOST_PROTOCOL_VERSION, requestId: randomUUID(), idempotencyKey: randomUUID(), context: ctx, action: "transfer.start", payload: plan };
    expect(await server.receive(request)).toMatchObject({ ok: true });
    expect(await server.receive({ ...request, requestId: randomUUID(), idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await server.receive({ ...request, requestId: randomUUID() })).toMatchObject({ ok: true });
    server.retire();
    expect(await server.receive(request)).toMatchObject({ ok: false, error: { code: "INTERRUPTED" } });
    expect(dispatch["transfer.start"]).toHaveBeenCalledOnce();
  });
});
