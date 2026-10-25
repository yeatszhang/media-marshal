import { CloudError, type ManagedDownloadRoot } from "@media-marshal/contracts";
import { managedRootGrantSchema, type ManagedRootGrant } from "@media-marshal/contracts/internal";
import { ManagedRoots, pathsOverlap, sameVolumeRoot, assertSpaceBudget } from "../files/index.js";
import type { CoreDatabase } from "../infrastructure/database.js";

interface RootRow { id: string; canonical_path: string; volume_identity: string; state: ManagedDownloadRoot["state"] }
export class CloudRoots {
  readonly files = new ManagedRoots();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly database: CoreDatabase) {
    database.connection.prepare("UPDATE managed_download_root SET state='UNAVAILABLE'").run();
  }
  bootstrap(): ManagedRootGrant[] {
    return (this.database.connection.prepare("SELECT * FROM managed_download_root ORDER BY created_at,id LIMIT 100").all() as RootRow[])
      .map((row) => managedRootGrantSchema.parse({ id: row.id, path: row.canonical_path, volume: JSON.parse(row.volume_identity) }));
  }
  private overlap(grant: ManagedRootGrant) {
    const db = this.database.connection;
    const otherRoots = (db.prepare("SELECT * FROM managed_download_root WHERE id!=?").all(grant.id) as RootRow[]);
    const sources = db.prepare("SELECT s.id,s.source_path,s.target_path,i.download_root_id FROM desktop_source s LEFT JOIN ingestion_source i ON i.source_id=s.id ORDER BY s.created_at,s.id").all() as { id: string; source_path: string; target_path: string; download_root_id: string | null }[];
    const targets = db.prepare("SELECT id,grant_json FROM media_target_root ORDER BY id").all() as { id: string; grant_json: string }[];
    const target = targets.find((row) => pathsOverlap(grant.path, JSON.parse(row.grant_json).path, grant.volume));
    if (target) throw new CloudError("CONFLICT", undefined, { reason: "TARGET_OVERLAP", conflict: { kind: "media-target", id: target.id } });
    const otherRoot = otherRoots.find((other) => pathsOverlap(grant.path, other.canonical_path, grant.volume));
    if (otherRoot) throw new CloudError("CONFLICT", undefined, { reason: "DOWNLOAD_ROOT_OVERLAP", conflict: { kind: "download-root", id: otherRoot.id } });
    for (const source of sources) {
      if (pathsOverlap(grant.path, source.target_path, grant.volume)) throw new CloudError("CONFLICT", undefined, { reason: "TARGET_OVERLAP", conflict: { kind: "source", id: source.id } });
      if (source.download_root_id !== grant.id && pathsOverlap(grant.path, source.source_path, grant.volume)) throw new CloudError("CONFLICT", undefined, { reason: "SOURCE_OVERLAP", conflict: { kind: "source", id: source.id } });
    }
  }
  authorize(value: ManagedRootGrant): Promise<ManagedRootGrant> {
    const work = this.queue.catch(() => {}).then(async () => {
      const input = managedRootGrantSchema.parse(value), db = this.database.connection;
      const previous = db.prepare("SELECT * FROM managed_download_root WHERE canonical_path=? OR id=?").get(input.path, input.id) as RootRow | undefined;
      if (previous && (previous.canonical_path !== input.path || !sameVolumeRoot(JSON.parse(previous.volume_identity), input.volume))) throw new CloudError("LOCAL_UNAVAILABLE", undefined, { reason: "IDENTITY_CHANGED", conflict: { kind: "download-root", id: previous.id } });
      const grant = { ...input, id: previous?.id ?? input.id };
      if (!previous && (db.prepare("SELECT count(*) AS count FROM managed_download_root").get() as { count: number }).count >= 100) throw new CloudError("CONFLICT");
      this.overlap(grant);
      await this.files.install(grant);
      // 异步卷核验/初始化期间普通来源可能被保存，落库前重新检查。
      this.overlap(grant);
      db.prepare("INSERT INTO managed_download_root(id,grant_id,canonical_path,volume_identity,state,created_at) VALUES(?,?,?,?,'AVAILABLE',?) ON CONFLICT(id) DO UPDATE SET volume_identity=excluded.volume_identity,state='AVAILABLE'")
        .run(grant.id, grant.id, grant.path, JSON.stringify(grant.volume), new Date().toISOString());
      return grant;
    });
    this.queue = work; return work;
  }
  unavailable(id: string) { this.database.connection.prepare("UPDATE managed_download_root SET state='UNAVAILABLE' WHERE id=?").run(id); return {}; }
  async list(): Promise<ManagedDownloadRoot[]> {
    const rows = this.database.connection.prepare("SELECT * FROM managed_download_root ORDER BY created_at,id LIMIT 100").all() as RootRow[];
    return Promise.all(rows.map(async (row) => {
      let availableBytes: number | null = null;
      if (row.state === "AVAILABLE") try { availableBytes = await this.files.get(row.id).check(); } catch { this.unavailable(row.id); row.state = "UNAVAILABLE"; }
      return { id: row.id, path: row.canonical_path, state: row.state, availableBytes };
    }));
  }
  async budget(id: string, bytes: number, mediaCopyBytes = 0) {
    const row = this.database.connection.prepare("SELECT state FROM managed_download_root WHERE id=?").get(id) as RootRow | undefined;
    if (row?.state !== "AVAILABLE") throw new CloudError("LOCAL_UNAVAILABLE");
    const reserved = this.database.connection.prepare("SELECT coalesce(sum(i.expected_size),0) AS bytes FROM download_claim c JOIN download_item i ON i.id=c.item_id WHERE c.target_root_id=? AND i.state!='COMPLETED'").get(id) as { bytes: number };
    const available = await this.files.get(id).check(); assertSpaceBudget(available, bytes, reserved.bytes, mediaCopyBytes); return available;
  }
  async close() { await this.queue.catch(() => {}); await this.files.close(); }
}
