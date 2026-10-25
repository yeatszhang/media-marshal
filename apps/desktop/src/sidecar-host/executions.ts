import { createHash, randomUUID } from "node:crypto";
import { CloudError, cloudFailure } from "@media-marshal/contracts";
import { ExecutionUncertainError, executionHandleSchema, type BindingRef, type ExecutionContext, type ExecutionHandle, type HostOutput, type TransferEngine, type TransferEvent, type TransferPlan } from "@media-marshal/contracts/internal";
import type { StaticTransferRegistry } from "./registry";

interface Record {
  handle: ExecutionHandle; accountId: string; signature: string; sequence: number;
  context: ExecutionContext; stopped: boolean; state: "RUNNING" | "STOPPED" | "EXITED" | "UNCERTAIN"; code: number | null;
  engine?: TransferEngine; nativeStarted: boolean; started: Promise<void>; releaseStart: () => void; done?: Promise<void>;
}
/** 先发布执行句柄，再准备远端租约；长目录不占住请求应答窗口。 */
export class HostExecutions {
  private records = new Map<string, Record>();
  private retiring = false;
  constructor(private readonly registry: StaticTransferRegistry, private readonly implementation: (binding: BindingRef) => string,
    private readonly staging: (plan: TransferPlan) => Promise<string>,
    private readonly publish: (record: { context: ExecutionContext; handle: ExecutionHandle; sequence: number; event: TransferEvent }) => void = () => {}) {}
  start(plan: TransferPlan, context: ExecutionContext): ExecutionHandle {
    if (this.retiring) throw new CloudError("INTERRUPTED");
    const accountId = plan.items[0]!.source.binding.accountId;
    for (const item of plan.items) this.implementation(item.source.binding);
    const signature = createHash("sha256").update(JSON.stringify({ plan, context })).digest("hex"), previous = this.records.get(plan.attemptId);
    if (previous) { if (previous.signature !== signature) throw new CloudError("CONFLICT"); return { ...previous.handle }; }
    if (this.records.size >= 256 || [...this.records.values()].some((value) => value.accountId === accountId && (value.state === "RUNNING" || value.state === "UNCERTAIN"))) throw new CloudError("CONFLICT");
    const handle = { executionId: randomUUID(), attemptId: plan.attemptId, hostGeneration: context.hostGeneration };
    let releaseStart!: () => void; const started = new Promise<void>((resolve) => { releaseStart = resolve; });
    const record: Record = { handle, accountId, signature, context: { ...context }, sequence: 0, stopped: false, state: "RUNNING", code: null, nativeStarted: false, started, releaseStart };
    this.records.set(plan.attemptId, record);
    // JSON 数据已按宿主契约校验；隔离外部引用，后续修改不能改变在途批次。
    const snapshot = structuredClone(plan);
    record.done = this.run(record, snapshot);
    void record.done.catch(() => {});
    return { ...handle };
  }
  private emit(record: Record, event: TransferEvent) { this.publish({ context: record.context, handle: record.handle, sequence: ++record.sequence, event }); }
  private async run(record: Record, plan: TransferPlan) {
    const prepared: Awaited<ReturnType<StaticTransferRegistry["prepare"]>>[] = [];
    let result: Extract<TransferEvent, { type: "exited" }> | undefined;
    try {
      const stagingDirectory = await this.staging(plan);
      for (const item of plan.items) {
        if (record.stopped || this.retiring) throw new CloudError("INTERRUPTED");
        prepared.push(await this.registry.prepare(this.implementation(item.source.binding), item.source));
      }
      if (record.stopped || this.retiring) throw new CloudError("INTERRUPTED");
      const engine = prepared[0]!.engine;
      if (prepared.some((value) => value.engine !== engine)) throw new CloudError("UNSUPPORTED_CAPABILITY");
      record.engine = engine;
      const handle = await engine.start({ executionId: record.handle.executionId, context: record.context, plan, stagingDirectory, sources: prepared.map((value, index) => ({ itemId: plan.items[index]!.itemId, lease: value.lease })) });
      if (handle.executionId !== record.handle.executionId || handle.attemptId !== record.handle.attemptId || handle.hostGeneration !== record.handle.hostGeneration) throw new CloudError("COMPONENT_UNAVAILABLE");
      record.nativeStarted = true; record.releaseStart();
      if (record.stopped) await engine.stop(record.handle);
      for await (const event of engine.events(record.handle)) { if (event.type === "exited") result = event; else this.emit(record, event); }
      if (!result) { await engine.stop(record.handle); result = { type: "exited", exitCode: -1, stopped: true }; }
    } catch (error) {
      if (!record.stopped && !this.retiring) this.emit(record, { type: "failure", failure: cloudFailure(error) });
      if (error instanceof ExecutionUncertainError) { record.state = "UNCERTAIN"; throw error; }
      if (record.nativeStarted) {
        try { await record.engine!.stop(record.handle); }
        catch { record.state = "UNCERTAIN"; throw new ExecutionUncertainError(); }
      }
    }
    finally {
      record.releaseStart();
      if (record.state !== "UNCERTAIN") {
        const released = await Promise.allSettled(prepared.map((value) => value.release()));
        if (released.some((value) => value.status === "rejected") && !this.retiring) this.emit(record, { type: "failure", failure: cloudFailure(new CloudError("COMPONENT_UNAVAILABLE")) });
        const exit = result ?? { type: "exited" as const, exitCode: -1, stopped: false };
        const terminal = { ...exit, stopped: exit.stopped || record.stopped || this.retiring };
        record.state = terminal.stopped ? "STOPPED" : "EXITED"; record.code = terminal.exitCode; this.emit(record, terminal);
      }
    }
  }
  private record(handle: ExecutionHandle) {
    const parsed = executionHandleSchema.parse(handle), record = this.records.get(parsed.attemptId);
    if (!record || parsed.executionId !== record.handle.executionId || parsed.hostGeneration !== record.handle.hostGeneration) throw new CloudError("INTERRUPTED"); return record;
  }
  async stop(handle: ExecutionHandle): Promise<{ stopped: true }> {
    const record = this.record(handle); record.stopped = true;
    if (record.state === "UNCERTAIN") throw new ExecutionUncertainError();
    await record.started;
    if (record.nativeStarted && record.state === "RUNNING") await record.engine!.stop(record.handle);
    await record.done; return { stopped: true };
  }
  status(attemptId: string): HostOutput<"transfer.status"> {
    const value = this.records.get(attemptId);
    return value ? { handle: { ...value.handle }, state: value.state, lastSequence: value.sequence, exitCode: value.code } : { handle: null, state: "UNKNOWN", lastSequence: 0, exitCode: null };
  }
  async stopAccount(accountId: string) { for (const value of this.records.values()) if (value.accountId === accountId && (value.state === "RUNNING" || value.state === "UNCERTAIN")) await this.stop(value.handle); }
  async dispose() { this.retiring = true; await Promise.all([...this.records.values()].filter((value) => value.state === "RUNNING" || value.state === "UNCERTAIN").map((value) => this.stop(value.handle))); }
}
