// 仅由测试显式导入；生产注册表不注册这些实现。
import { randomUUID } from "node:crypto";
import type { DriveCapabilities } from "@media-marshal/contracts";
import type {
  BindingRef, CloudDriveProvider, ExecutionHandle, HostInput, PrivateCredentialInput,
  PrivateTransferPlan, SourceRequest, TransferEngine, TransferEvent,
} from "@media-marshal/contracts/internal";

export class FakeDriveProvider implements CloudDriveProvider {
  readonly implementationId = "test.drive";
  acquired = 0;
  released = 0;
  async capabilities(_: BindingRef): Promise<DriveCapabilities> {
    return { authorizationMethods: ["cookie"], accountIdentity: "unavailable", objectIdentity: "path", reliableRevision: false, hashAlgorithms: [], rangeRead: "supported", sourceKinds: ["webdav"] };
  }
  async validateCredential(_: PrivateCredentialInput) { return { stableKey: null }; }
  async list(input: HostInput<"provider.list">) { return { entries: [{ entry: await this.stat({ binding: input.binding, remoteRef: input.parentRef, locator: input.locator, expectedVersion: null }), locator: { kind: "path" as const, segments: ["sample.txt"] } }], nextCursor: null, total: 1, complete: true }; }
  async stat(input: SourceRequest) { return { accountId: input.binding.accountId, name: "sample.txt", type: "file" as const, size: 10, modifiedAt: null, version: null }; }
  async acquireSource(input: SourceRequest) { this.acquired++; return { leaseId: randomUUID(), generation: input.binding.generation, kind: "webdav" as const, endpoint: "http://127.0.0.1:5244/dav/", root: "/", credentialHandle: randomUUID() }; }
  async releaseSource(_: string) { this.released++; }
}
export class FakeTransferEngine implements TransferEngine {
  readonly implementationId = "test.transfer";
  starts = 0;
  stops = 0;
  constructor(readonly supportedSourceKinds: readonly "webdav"[] = ["webdav"]) {}
  async start(input: PrivateTransferPlan): Promise<ExecutionHandle> {
    this.starts++;
    return { executionId: randomUUID(), attemptId: input.plan.attemptId, hostGeneration: input.context.hostGeneration };
  }
  async stop(_: ExecutionHandle) { this.stops++; return { stopped: true as const }; }
  async *events(_: ExecutionHandle): AsyncIterable<TransferEvent> {
    yield { type: "progress", bytes: 10, totalBytes: 10, bytesPerSecond: 10 };
    yield { type: "exited", exitCode: 0, stopped: false };
  }
}
