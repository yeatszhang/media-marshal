import { createHash, randomUUID } from "node:crypto";
import { CloudError, cloudAccountSchema, remoteEntrySchema, remotePageSchema, type CloudAccount, type RemoteEntry, type RemotePage } from "@media-marshal/contracts";
import { bindingRefSchema, hostActions, remoteLocatorSchema, type BindingRef, type RemoteLocator, type SourceRequest } from "@media-marshal/contracts/internal";
import type { CoreHostGateway } from "@media-marshal/contracts/internal/rpc";
import type { CoreDatabase } from "../infrastructure/database.js";

interface Binding extends BindingRef { status: CloudAccount["status"] }
interface Node { id: string; account_id: string; parent_ref: string | null; name: string; type: "file" | "directory"; size: number | null; modified_at: string | null; version_json: string | null; locator_json: string }
interface Cursor { scope: string; binding: Binding; parentRef: string; locator: RemoteLocator; size: number; upstream: string; hostGeneration: string; expires: number; epoch: number; seen: Set<string> }
const locatorKey = (locator: RemoteLocator) => createHash("sha256").update(JSON.stringify(remoteLocatorSchema.parse(locator))).digest("hex");

/** Core 持有远端引用；上游游标和路径只存在于私有调用与实现映射中。 */
export class RemoteCatalog {
  private cursors = new Map<string, Cursor>();
  private epochs = new Map<string, number>();
  private flights = new Set<string>();
  constructor(private readonly database: CoreDatabase, private readonly host: CoreHostGateway, private readonly now = Date.now, private readonly available: (binding: BindingRef) => boolean = () => true) {}
  private binding(accountId: string): Binding {
    const row = this.database.connection.prepare("SELECT a.id AS accountId,a.status,b.id AS bindingId,b.generation FROM cloud_account a JOIN provider_binding b ON b.account_id=a.id AND b.state='ACTIVE' WHERE a.id=?").get(accountId) as Binding | undefined;
    if (!row) throw new CloudError("AUTH_REQUIRED");
    if (row.status === "DISCONNECTED" || row.status === "AUTH_REQUIRED" || row.status === "UNCONFIGURED") throw new CloudError("AUTH_REQUIRED");
    if (!this.available(row)) throw new CloudError("COMPONENT_UNAVAILABLE");
    return { ...bindingRefSchema.parse({ accountId: row.accountId, bindingId: row.bindingId, generation: row.generation }), status: row.status };
  }
  private current(binding: BindingRef) {
    const value = this.binding(binding.accountId);
    if (value.bindingId !== binding.bindingId || value.generation !== binding.generation) throw new CloudError("INTERRUPTED");
  }
  private node(binding: BindingRef, ref: string): Node {
    const value = this.database.connection.prepare("SELECT e.*,m.locator_json FROM remote_entry e JOIN remote_binding m ON m.remote_ref=e.id AND m.account_id=e.account_id WHERE e.id=? AND e.account_id=? AND m.binding_id=?").get(ref, binding.accountId, binding.bindingId) as Node | undefined;
    if (!value) throw new CloudError("REMOTE_NOT_FOUND");
    return value;
  }
  private failure(binding: BindingRef, error: unknown): never {
    if (error instanceof CloudError && (error.code === "AUTH_REQUIRED" || error.code === "REMOTE_NOT_FOUND")) {
      const status = error.code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "RESELECT_REQUIRED";
      this.database.connection.prepare("UPDATE cloud_account SET status=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM provider_binding WHERE id=? AND generation=? AND state='ACTIVE')").run(status, new Date(this.now()).toISOString(), binding.accountId, binding.bindingId, binding.generation);
    }
    throw error;
  }
  accounts(): CloudAccount[] {
    return (this.database.connection.prepare("SELECT id,name,provider_kind,status,capabilities_json FROM cloud_account ORDER BY created_at,id LIMIT 100").all() as { id: string; name: string; provider_kind: string; status: string; capabilities_json: string | null }[]).map((row) => {
      const root = this.database.connection.prepare("SELECT e.id,b.id AS bindingId,b.generation FROM remote_entry e JOIN remote_binding m ON m.remote_ref=e.id JOIN provider_binding b ON b.id=m.binding_id WHERE e.account_id=? AND e.parent_ref IS NULL AND b.state='ACTIVE' LIMIT 1").get(row.id) as { id: string; bindingId: string; generation: string } | undefined;
      const status = root && ["READY", "RESELECT_REQUIRED"].includes(row.status) && !this.available({ accountId: row.id, bindingId: root.bindingId, generation: root.generation }) ? "UNAVAILABLE" : row.status;
      return cloudAccountSchema.parse({ id: row.id, name: row.name, providerKind: row.provider_kind, status, capabilities: row.capabilities_json ? JSON.parse(row.capabilities_json) : null, rootRef: root?.id ?? null });
    });
  }
  source(accountId: string, ref: string): SourceRequest {
    const binding = this.binding(accountId), node = this.node(binding, ref);
    return { binding: bindingRefSchema.parse({ accountId, bindingId: binding.bindingId, generation: binding.generation }), remoteRef: ref, locator: remoteLocatorSchema.parse(JSON.parse(node.locator_json)), expectedVersion: node.version_json ? JSON.parse(node.version_json) : null };
  }
  relativePath(accountId: string, ref: string): string[] {
    const binding = this.binding(accountId), parts: string[] = [], seen = new Set<string>(); let node = this.node(binding, ref);
    for (;;) {
      if (seen.has(node.id) || seen.size >= 256) throw new CloudError("REMOTE_CHANGED"); seen.add(node.id);
      if (node.parent_ref === null) { if (node.type === "file") parts.unshift(node.name); break; }
      parts.unshift(node.name); node = this.node(binding, node.parent_ref);
    }
    return parts;
  }
  async stat(accountId: string, ref: string): Promise<RemoteEntry> {
    const source = this.source(accountId, ref), previous = this.node(source.binding, ref);
    try {
      const metadata = hostActions["provider.stat"].output.parse(await this.host.request("provider.stat", source, this.host.context(source.binding.generation, randomUUID()), randomUUID()));
      this.current(source.binding);
      if (metadata.accountId !== accountId || (previous.parent_ref !== null && metadata.name !== previous.name)) throw new CloudError("REMOTE_CHANGED");
      const result = remoteEntrySchema.parse({ ...metadata, ref, parentRef: previous.parent_ref });
      this.database.connection.prepare("UPDATE remote_entry SET name=?,type=?,size=?,modified_at=?,version_json=?,observed_at=? WHERE id=?").run(result.name, result.type, result.size, result.modifiedAt, result.version ? JSON.stringify(result.version) : null, new Date(this.now()).toISOString(), ref);
      return result;
    } catch (error) { return this.failure(source.binding, error); }
  }
  async list(input: { accountId: string; parentRef: string; cursor?: string | null; pageSize?: number; refresh?: boolean }, session = "public"): Promise<RemotePage> {
    const binding = this.binding(input.accountId), parent = this.node(binding, input.parentRef), size = input.pageSize ?? 50;
    if (parent.type !== "directory" || !Number.isInteger(size) || size < 1 || size > 100 || (input.refresh && input.cursor)) throw new CloudError("INVALID_REQUEST");
    const locator = remoteLocatorSchema.parse(JSON.parse(parent.locator_json)), scope = `${binding.generation}:${parent.id}:${session}`;
    if (this.flights.has(scope)) throw new CloudError("CONFLICT");
    for (const [key, value] of this.cursors) if (value.expires <= this.now()) this.cursors.delete(key);
    let cursor: Cursor | undefined;
    if (input.cursor) {
      cursor = this.cursors.get(input.cursor);
      if (!cursor || cursor.scope !== scope || cursor.parentRef !== parent.id || cursor.binding.accountId !== binding.accountId || cursor.binding.generation !== binding.generation || cursor.size !== size || cursor.epoch !== this.epochs.get(scope)) throw new CloudError("REMOTE_CHANGED");
    } else {
      if (!this.epochs.has(scope) && this.epochs.size >= 1000) {
        const unused = [...this.epochs.keys()].find((key) => !this.flights.has(key) && ![...this.cursors.values()].some((value) => value.scope === key));
        if (!unused) throw new CloudError("CONFLICT");
        this.epochs.delete(unused);
      }
      this.epochs.set(scope, (this.epochs.get(scope) ?? 0) + 1);
      for (const [key, value] of this.cursors) if (value.scope === scope) this.cursors.delete(key);
    }
    if (this.cursors.size >= 1000) throw new CloudError("CONFLICT");
    const epoch = this.epochs.get(scope)!, context = this.host.context(binding.generation, randomUUID());
    if (cursor && cursor.hostGeneration !== context.hostGeneration) throw new CloudError("REMOTE_CHANGED");
    this.flights.add(scope);
    try {
      const page = hostActions["provider.list"].output.parse(await this.host.request("provider.list", { binding: bindingRefSchema.parse({ accountId: binding.accountId, bindingId: binding.bindingId, generation: binding.generation }), parentRef: parent.id, locator, cursor: cursor?.upstream ?? null, pageSize: size }, context, randomUUID()));
      this.current(binding);
      if (page.entries.length > size || page.complete !== (page.nextCursor === null) || (!page.complete && !page.entries.length)) throw new CloudError("REMOTE_CHANGED");
      const seen = new Set(cursor?.seen ?? []), values = page.entries.map((value) => {
        const key = locatorKey(value.locator);
        if (value.entry.accountId !== binding.accountId || seen.has(key)) throw new CloudError("REMOTE_CHANGED");
        if (locator.kind === "path" && (value.locator.kind !== "path" || value.locator.segments.length !== locator.segments.length + 1 || value.locator.segments.at(-1) !== value.entry.name || locator.segments.some((part, index) => value.locator.kind !== "path" || value.locator.segments[index] !== part))) throw new CloudError("REMOTE_CHANGED");
        seen.add(key); return { ...value, key };
      });
      // 游标集和跨页去重有界；过大的目录明确停止，不能伪报扫描完成。
      if (seen.size > 100000) throw new CloudError("UNSUPPORTED_CAPABILITY");
      const otherSeen = [...this.cursors.entries()].reduce((sum, [key, value]) => sum + (key === input.cursor ? 0 : value.seen.size), 0);
      if (!page.complete && otherSeen + seen.size > 100000) throw new CloudError("UNSUPPORTED_CAPABILITY");
      if (page.total !== null && (page.total < seen.size || (page.complete && page.total !== seen.size))) throw new CloudError("REMOTE_CHANGED");
      const items = this.database.connection.transaction(() => values.map((value) => {
        const mapped = this.database.connection.prepare("SELECT remote_ref FROM remote_binding WHERE binding_id=? AND locator_key=?").get(binding.bindingId, value.key) as { remote_ref: string } | undefined;
        const ref = mapped?.remote_ref ?? randomUUID(), result = remoteEntrySchema.parse({ ...value.entry, ref, parentRef: parent.id }), now = new Date(this.now()).toISOString();
        this.database.connection.prepare("INSERT INTO remote_entry(id,account_id,parent_ref,name,type,size,modified_at,version_json,observed_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,size=excluded.size,modified_at=excluded.modified_at,version_json=excluded.version_json,observed_at=excluded.observed_at").run(ref, binding.accountId, parent.id, result.name, result.type, result.size, result.modifiedAt, result.version ? JSON.stringify(result.version) : null, now);
        this.database.connection.prepare("INSERT INTO remote_binding(remote_ref,binding_id,account_id,locator_json,locator_key,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(remote_ref,binding_id) DO UPDATE SET updated_at=excluded.updated_at").run(ref, binding.bindingId, binding.accountId, JSON.stringify(value.locator), value.key, now);
        return result;
      }))();
      let nextCursor: string | null = null;
      if (input.cursor) this.cursors.delete(input.cursor);
      if (page.nextCursor !== null) {
        nextCursor = randomUUID().replaceAll("-", "");
        this.cursors.set(nextCursor, { scope, binding, parentRef: parent.id, locator, size, upstream: page.nextCursor, hostGeneration: context.hostGeneration, expires: this.now() + 15 * 60000, epoch, seen });
      }
      // 没有返回的旧引用继续保留；分页失败、目录变化均不产生删除事实。
      return remotePageSchema.parse({ items, nextCursor, total: page.total, complete: page.complete });
    } catch (error) { return this.failure(binding, error); }
    finally { this.flights.delete(scope); }
  }
}
