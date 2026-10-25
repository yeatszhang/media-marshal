import { createHash, randomUUID } from "node:crypto";
import { CloudError, type DriveCapabilities } from "@media-marshal/contracts";
import type { BindingRef, CloudDriveProvider, HostInput, PrivateCredentialInput, SourceRequest } from "@media-marshal/contracts/internal";
import { SourceCredentialBroker } from "../source-credentials";

/** 独立契约夹具；不导入 OpenList，也不注册到正式应用。 */
export class TestWebDavProvider implements CloudDriveProvider {
  readonly implementationId = "test.independent-webdav";
  fault?: () => void;
  private leases = new Map<string, string>();
  constructor(readonly files: Map<string, Buffer>, private readonly broker: SourceCredentialBroker, private readonly server: { endpoint: string; username: string; password: string }) {}
  async capabilities(_: BindingRef): Promise<DriveCapabilities> { return { authorizationMethods: ["cookie"], accountIdentity: "stable-id", objectIdentity: "path", reliableRevision: false, hashAlgorithms: ["sha256"], rangeRead: "supported", sourceKinds: ["webdav"] }; }
  async validateCredential(_: PrivateCredentialInput) { return { stableKey: "independent-test-account" }; }
  private path(input: SourceRequest) { if (input.locator.kind !== "path") throw new CloudError("REMOTE_NOT_FOUND"); return input.locator.segments.join("/"); }
  async stat(input: SourceRequest) {
    this.fault?.(); const path = this.path(input), data = this.files.get(path), directory = !path || [...this.files.keys()].some((name) => name.startsWith(path + "/"));
    if (!data && !directory) throw new CloudError("REMOTE_NOT_FOUND");
    return { accountId: input.binding.accountId, name: path.split("/").at(-1) || "测试网盘", type: data ? "file" as const : "directory" as const, size: data?.length ?? null, modifiedAt: null, version: data ? { kind: "hash" as const, algorithm: "sha256" as const, value: createHash("sha256").update(data).digest("hex") } : null };
  }
  async list(input: HostInput<"provider.list">) {
    this.fault?.(); const path = this.path({ binding: input.binding, locator: input.locator, remoteRef: input.parentRef, expectedVersion: null }), prefix = path ? path + "/" : "";
    const children = [...new Set([...this.files.keys()].filter((name) => name.startsWith(prefix)).map((name) => prefix + name.slice(prefix.length).split("/")[0]))].sort();
    const offset = input.cursor ? Number(input.cursor) : 0, page = children.slice(offset, offset + input.pageSize);
    const entries = await Promise.all(page.map(async (name) => { const locator = { kind: "path" as const, segments: name.split("/") }; return { locator, entry: await this.stat({ binding: input.binding, remoteRef: input.parentRef, locator, expectedVersion: null }) }; }));
    const complete = offset + page.length >= children.length;
    return { entries, total: children.length, complete, nextCursor: complete ? null : String(offset + page.length) };
  }
  async acquireSource(input: SourceRequest) {
    await this.stat(input); const leaseId = randomUUID(), credentialHandle = this.broker.issue(input.binding, this.server); this.leases.set(leaseId, credentialHandle);
    return { leaseId, generation: input.binding.generation, kind: "webdav" as const, endpoint: this.server.endpoint, root: "/", credentialHandle, file: { remoteRef: input.remoteRef, segments: this.path(input).split("/") } };
  }
  async releaseSource(leaseId: string) { const handle = this.leases.get(leaseId); if (handle) this.broker.release(handle); this.leases.delete(leaseId); }
  async disconnect(_: BindingRef) { for (const id of [...this.leases.keys()]) await this.releaseSource(id); }
}
