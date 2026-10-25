import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CloudError, driveCapabilitiesSchema, remoteEntrySchema, versionEvidenceSchema } from "@media-marshal/contracts";
import { bindingRefSchema, sourceRequestSchema, hostActions, type BindingRef, type CloudDriveProvider, type HostInput, type HostOutput, type PrivateCredentialInput, type SourceRequest, type TransferSourceLease } from "@media-marshal/contracts/internal";
import { OpenListApiError, type OpenListClient } from "./client";
import { SourceCredentialBroker } from "../source-credentials";

interface Gateway { readonly client: Pick<OpenListClient, "api" | "origin">; readOnlyAccess(scopeId: string): Promise<{ username: string; password: string; mountPath: string }> }
interface Mount { binding: BindingRef; id: number; path: string; cookie: string }
const upstreamEntry = z.object({ name: remoteEntrySchema.shape.name, size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), is_dir: z.boolean(), modified: z.string().nullable().optional() });
const rawPage = z.object({ content: z.array(upstreamEntry).max(100).nullable(), total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const cursorSchema = z.strictObject({ generation: z.uuid(), parent: z.string().max(4096), page: z.number().int().min(2).max(100000), size: z.number().int().min(1).max(100), total: z.number().int().nonnegative() });
const capabilities = driveCapabilitiesSchema.parse({ authorizationMethods: ["cookie"], accountIdentity: "unavailable", objectIdentity: "path", reliableRevision: false, hashAlgorithms: [], rangeRead: "unknown", sourceKinds: ["webdav"] });
function normalizeError(error: unknown): never {
  if (error instanceof CloudError) throw error;
  if (error instanceof OpenListApiError) {
    if (error.reason === "authentication") throw new CloudError("AUTH_REQUIRED");
    if (error.reason === "rate-limit") throw new CloudError("RATE_LIMITED", 30);
    if (error.reason === "network") throw new CloudError("NETWORK_UNAVAILABLE");
    if (error.reason === "not-found") throw new CloudError("REMOTE_NOT_FOUND");
  }
  throw new CloudError("COMPONENT_UNAVAILABLE");
}
function entry(accountId: string, value: z.infer<typeof upstreamEntry>): HostOutput<"provider.stat"> {
  const modifiedAt = value.modified && !value.modified.startsWith("0001-") && z.iso.datetime({ offset: true }).safeParse(value.modified).success ? value.modified : null;
  return { accountId, name: value.name, type: value.is_dir ? "directory" : "file", size: value.is_dir ? null : value.size, modifiedAt, version: value.is_dir ? null : { kind: "weak", size: value.size, modifiedAt } };
}
export class OpenListQuarkProvider implements CloudDriveProvider {
  readonly implementationId = "openlist.quark";
  private mounts = new Map<string, Mount>();
  private pending = new Map<string, { cookie: string; promise: Promise<{ stableKey: null }> }>();
  private leases = new Map<string, { handle: string; binding: BindingRef }>();
  private readonly cursorKey = randomBytes(32);
  constructor(private readonly gateway: Gateway, private readonly credentials: SourceCredentialBroker, private readonly updated: (binding: BindingRef, cookie: string) => Promise<void> = async () => {}) {}
  async capabilities(_binding: BindingRef) { return driveCapabilitiesSchema.parse(capabilities); }
  validateCredential(input: PrivateCredentialInput): Promise<{ stableKey: null }> {
    const binding = bindingRefSchema.parse(input.binding), cookie = input.cookie;
    if (!cookie || cookie.length > 32768 || /[\r\n\0]/.test(cookie)) return Promise.reject(new CloudError("INVALID_REQUEST"));
    const pending = this.pending.get(binding.generation);
    if (pending) return pending.cookie === cookie ? pending.promise : Promise.reject(new CloudError("CONFLICT"));
    const promise = this.mount(binding, cookie).finally(() => this.pending.delete(binding.generation));
    this.pending.set(binding.generation, { cookie, promise }); return promise;
  }
  private async mount(binding: BindingRef, cookie: string): Promise<{ stableKey: null }> {
    const existing = this.mounts.get(binding.generation);
    if (existing) {
      if (existing.binding.accountId !== binding.accountId || existing.binding.bindingId !== binding.bindingId || existing.cookie !== cookie) throw new CloudError("CONFLICT");
      try { await this.readRoot(existing); return { stableKey: null }; } catch (error) { normalizeError(error); }
    }
    const reader = await this.gateway.readOnlyAccess(binding.generation);
    let id: number | undefined;
    try {
      const created = await this.gateway.client.api("POST", "/api/admin/storage/create", { mount_path: reader.mountPath, driver: "Quark", addition: JSON.stringify({ cookie, root_folder_id: "0", use_transcoding_address: false, only_list_video_file: false }), web_proxy: true, webdav_policy: "native_proxy", proxy_range: true, enable_sign: true });
      id = z.object({ id: z.number().int().positive() }).parse(created).id;
      const mount: Mount = { binding, id, path: reader.mountPath, cookie };
      await this.readRoot(mount); this.mounts.set(binding.generation, mount);
      await this.refreshCredential(binding);
      // 固定驱动不提供可信上游 UID；不能伪造同账号证明，重新授权由 Core 要求重选根。
      return { stableKey: null };
    } catch (error) {
      const candidateId = id ?? (error instanceof OpenListApiError ? error.resourceId : undefined);
      if (candidateId) await this.gateway.client.api("POST", `/api/admin/storage/delete?id=${candidateId}`).catch(() => {});
      this.mounts.delete(binding.generation); normalizeError(error);
    }
  }
  private async readRoot(mount: Mount) {
    const value = await this.gateway.client.api("POST", "/api/fs/list", { path: mount.path, page: 1, per_page: 1, refresh: true });
    rawPage.parse(value);
  }
  private configured(binding: BindingRef): Mount {
    const mount = this.mounts.get(binding.generation);
    if (!mount || mount.binding.accountId !== binding.accountId || mount.binding.bindingId !== binding.bindingId) throw new CloudError("AUTH_REQUIRED");
    return mount;
  }
  private path(mount: Mount, locator: SourceRequest["locator"]): string {
    if (locator.kind !== "path") throw new CloudError("UNSUPPORTED_CAPABILITY");
    const result = mount.path + (locator.segments.length ? "/" + locator.segments.join("/") : "");
    if (result.length > 4096) throw new CloudError("INVALID_REQUEST"); return result;
  }
  private cursor(value: z.infer<typeof cursorSchema>): string {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return payload + "." + createHmac("sha256", this.cursorKey).update(payload).digest("base64url");
  }
  async list(input: HostInput<"provider.list">): Promise<HostOutput<"provider.list">> {
    const parsed = hostActions["provider.list"].input.parse(input), mount = this.configured(parsed.binding), parent = this.path(mount, parsed.locator);
    let page = 1, expectedTotal: number | undefined;
    if (parsed.cursor) {
      try {
        const [payload, signature, extra] = parsed.cursor.split(".");
        if (!payload || !signature || extra) throw new Error();
        const actual = Buffer.from(signature, "base64url"), expected = createHmac("sha256", this.cursorKey).update(payload).digest();
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
        const cursor = cursorSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
        if (cursor.generation !== parsed.binding.generation || cursor.parent !== parent || cursor.size !== parsed.pageSize) throw new Error();
        page = cursor.page; expectedTotal = cursor.total;
      } catch { throw new CloudError("INVALID_REQUEST"); }
    }
    try {
      const data = rawPage.parse(await this.gateway.client.api("POST", "/api/fs/list", { path: parent, page, per_page: parsed.pageSize, refresh: page === 1 }));
      const content = data.content ?? [];
      if (content.length > parsed.pageSize || (expectedTotal !== undefined && data.total !== expectedTotal) || (!content.length && (page - 1) * parsed.pageSize < data.total) || data.total < (page - 1) * parsed.pageSize + content.length || new Set(content.map((value) => value.name)).size !== content.length) throw new CloudError("REMOTE_CHANGED");
      const complete = page * parsed.pageSize >= data.total;
      if (!complete && content.length !== parsed.pageSize) throw new CloudError("REMOTE_CHANGED");
      if (!complete && page >= 100000) throw new CloudError("UNSUPPORTED_CAPABILITY");
      await this.refreshCredential(parsed.binding);
      return { entries: content.map((value) => ({ entry: entry(parsed.binding.accountId, value), locator: { kind: "path", segments: [...(parsed.locator.kind === "path" ? parsed.locator.segments : []), value.name] } })), nextCursor: complete ? null : this.cursor({ generation: parsed.binding.generation, parent, page: page + 1, size: parsed.pageSize, total: data.total }), total: data.total, complete };
    } catch (error) { normalizeError(error); }
  }
  async stat(input: SourceRequest): Promise<HostOutput<"provider.stat">> {
    const parsed = sourceRequestSchema.parse(input), mount = this.configured(parsed.binding);
    try {
      if (parsed.locator.kind === "path" && !parsed.locator.segments.length) return { accountId: parsed.binding.accountId, name: "网盘根目录", type: "directory", size: null, modifiedAt: null, version: null };
      const value = upstreamEntry.parse(await this.gateway.client.api("POST", "/api/fs/get", { path: this.path(mount, parsed.locator) }));
      const result = entry(parsed.binding.accountId, value); await this.refreshCredential(parsed.binding); return result;
    } catch (error) {
      if (error instanceof OpenListApiError && error.reason === "not-found" && parsed.locator.kind === "path") await this.confirmMissing(mount, parsed.locator.segments);
      normalizeError(error);
    }
  }
  private async confirmMissing(mount: Mount, segments: string[]): Promise<never> {
    const wanted = segments.at(-1), parent = this.path(mount, { kind: "path", segments: segments.slice(0, -1) }), seen = new Set<string>(); let total: number | undefined;
    // 网关的“对象不存在”也可能来自网络失败。只接受刷新父目录后的完整缺失证据。
    for (let page = 1; page <= 100; page++) {
      let data: z.infer<typeof rawPage>;
      try { data = rawPage.parse(await this.gateway.client.api("POST", "/api/fs/list", { path: parent, page, per_page: 100, refresh: page === 1 })); }
      catch (error) {
        if (error instanceof OpenListApiError && error.reason === "not-found") throw new CloudError("NETWORK_UNAVAILABLE");
        normalizeError(error);
      }
      const content = data.content ?? [];
      if (data.total > 10000 || (total !== undefined && total !== data.total)) throw new CloudError("COMPONENT_UNAVAILABLE"); total = data.total;
      for (const item of content) {
        if (seen.has(item.name)) throw new CloudError("COMPONENT_UNAVAILABLE"); seen.add(item.name);
        if (item.name === wanted) throw new CloudError("NETWORK_UNAVAILABLE");
      }
      if (seen.size > total || (seen.size < total && content.length !== 100)) throw new CloudError("COMPONENT_UNAVAILABLE");
      if (seen.size === total) throw new CloudError("REMOTE_NOT_FOUND");
    }
    throw new CloudError("COMPONENT_UNAVAILABLE");
  }
  async acquireSource(input: SourceRequest): Promise<TransferSourceLease> {
    const parsed = sourceRequestSchema.parse(input), mount = this.configured(parsed.binding), metadata = await this.stat(parsed);
    if (metadata.type !== "file") throw new CloudError("UNSUPPORTED_CAPABILITY");
    if (parsed.expectedVersion && JSON.stringify(versionEvidenceSchema.parse(parsed.expectedVersion)) !== JSON.stringify(metadata.version)) throw new CloudError("REMOTE_CHANGED");
    const reader = await this.gateway.readOnlyAccess(parsed.binding.generation), handle = this.credentials.issue(parsed.binding, reader), id = randomUUID();
    this.leases.set(id, { handle, binding: mount.binding });
    if (parsed.locator.kind !== "path") throw new CloudError("UNSUPPORTED_CAPABILITY");
    return { leaseId: id, generation: parsed.binding.generation, kind: "webdav", endpoint: this.gateway.client.origin + "/dav", root: "/", credentialHandle: handle, file: { remoteRef: parsed.remoteRef, segments: [...parsed.locator.segments] } };
  }
  async releaseSource(leaseId: string): Promise<void> {
    const lease = this.leases.get(leaseId); if (!lease) return;
    this.credentials.release(lease.handle); this.leases.delete(leaseId); await this.refreshCredential(lease.binding);
  }
  async refreshCredential(binding: BindingRef): Promise<void> {
    const mount = this.configured(binding);
    try {
      const value = z.object({ id: z.number().int(), mount_path: z.string(), driver: z.literal("Quark"), addition: z.string().max(65536) }).parse(await this.gateway.client.api("GET", `/api/admin/storage/get?id=${mount.id}`));
      if (value.id !== mount.id || value.mount_path !== mount.path) throw new CloudError("COMPONENT_UNAVAILABLE");
      const addition = z.object({ cookie: z.string().min(1).max(32768).refine((value) => !/[\r\n\0]/.test(value)) }).parse(JSON.parse(value.addition));
      if (addition.cookie !== mount.cookie) { await this.updated(binding, addition.cookie); mount.cookie = addition.cookie; }
    } catch (error) { normalizeError(error); }
  }
  async disconnect(binding: BindingRef): Promise<void> {
    const mount = this.mounts.get(binding.generation); if (!mount) return;
    this.configured(binding); this.credentials.revoke(binding);
    await this.gateway.client.api("POST", `/api/admin/storage/delete?id=${mount.id}`); this.mounts.delete(binding.generation);
  }
}
