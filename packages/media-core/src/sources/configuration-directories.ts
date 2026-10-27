import { DesktopError, type DirectoryBinding, type DefaultDownloadDirectory } from "@media-marshal/contracts";
import { managedRootGrantSchema, type ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { CloudRoots } from "../cloud/roots.js";
import { SourceRoot } from "../files/source-root.js";
import { sameVolumeRoot, pathsOverlap, isManagedPrivatePath } from "../files/index.js";

export interface ConfigurationDirectory extends DirectoryBinding { kind: "ordinary" | "managed" | "media"; available: boolean }
interface Row extends DirectoryBinding { kind: ConfigurationDirectory["kind"]; grant_json: string | null }
/** 目录身份独立于规则；公开响应只含引用，原生授权仅经 Main 私有入口安装。 */
export class ConfigurationDirectories {
  private readers = new Map<string, SourceRoot>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly database: CoreDatabase, private readonly roots: CloudRoots) {}
  private row(id: string) { return this.database.connection.prepare("SELECT * FROM configuration_directory WHERE id=?").get(id) as Row | undefined; }
  bootstrap() {
    return (this.database.connection.prepare("SELECT kind,grant_json FROM configuration_directory WHERE grant_json IS NOT NULL ORDER BY id LIMIT 1000").all() as { kind: Row["kind"]; grant_json: string }[]).map((row) => ({ kind: row.kind, grant: managedRootGrantSchema.parse(JSON.parse(row.grant_json)) }));
  }
  async list(): Promise<ConfigurationDirectory[]> {
    const rows = this.database.connection.prepare("SELECT * FROM configuration_directory ORDER BY created_at,id LIMIT 1000").all() as Row[], result: ConfigurationDirectory[] = [];
    for (let start = 0; start < rows.length; start += 16) result.push(...await Promise.all(rows.slice(start, start + 16).map(async (row) => {
      let available = false; const reader = this.readers.get(row.id);
      if (reader) try { await reader.check(); available = !this.closed && this.readers.get(row.id) === reader; } catch { /* 不从不可访问推断原文件被删除或许可已撤销。 */ }
      return { id: row.id, version: row.version, path: row.path, kind: row.kind, available };
    })));
    return result;
  }
  binding(id: string): DirectoryBinding {
    const row = this.row(id); if (!row?.grant_json) throw new DesktopError("LOCAL_UNAVAILABLE", "原目录尚未授权，请选择并核验原目录后重试", true);
    return { id: row.id, version: row.version, path: row.path };
  }
  grant(id: string) { const row = this.row(id); if (!row?.grant_json) throw new DesktopError("LOCAL_UNAVAILABLE", "原目录尚未授权，请先核验目录", true); return managedRootGrantSchema.parse(JSON.parse(row.grant_json)); }
  kind(id: string) { return this.row(id)?.kind; }
  reader(id: string) { const value = this.readers.get(id); if (!value) throw new DesktopError("LOCAL_UNAVAILABLE", "原目录或磁盘尚未恢复，请重新授权原目录；不会接管同名替代卷", true); return value; }
  authorize(value: ManagedRootGrant, kind: Row["kind"]): Promise<DirectoryBinding> {
    const work = this.queue.catch(() => {}).then(async () => {
      if (this.closed) throw new DesktopError("INTERRUPTED", "目录服务正在停止", true);
      const input = managedRootGrantSchema.parse(value), db = this.database.connection;
      if (isManagedPrivatePath(input.path.split(/[\\/]/))) throw new DesktopError("UNSAFE_PATH", "不能将私有暂存或恢复目录作为输入，请选择普通目录或受管下载根");
      if (kind === "ordinary") {
        const managed = db.prepare("SELECT canonical_path FROM managed_download_root").all() as { canonical_path: string }[];
        if (managed.some((root) => pathsOverlap(root.canonical_path, input.path, input.volume))) throw new DesktopError("UNSAFE_PATH", "所选目录与受管下载根重叠，请选择该受管根复用正式完成区，不按普通目录接管内部或父目录");
      }
      const existing = db.prepare("SELECT * FROM configuration_directory WHERE path=? OR id=?").all(input.path, input.id) as Row[];
      if (existing.length > 1) throw new DesktopError("CONFLICT", "目录路径与历史身份不一致，请核对原卷和目录");
      const previous = existing[0];
      if (previous && (previous.path !== input.path || previous.id !== input.id || previous.grant_json && !sameVolumeRoot(managedRootGrantSchema.parse(JSON.parse(previous.grant_json)).volume, input.volume))) throw new DesktopError("LOCAL_UNAVAILABLE", "目录与原卷身份不一致，请恢复原磁盘后重试", true);
      if (previous && previous.kind !== kind) throw new DesktopError("CONFLICT", "目录已有其他阶段的授权，请复用现有目录引用；受管根不能按普通目录接管");
      if (!previous && (db.prepare("SELECT count(*) AS n FROM configuration_directory").get() as { n: number }).n >= 1000) throw new DesktopError("CONFLICT", "已授权目录超过一千项，请复用已有目录");
      if (kind === "managed") await this.roots.authorize(input);
      const reader = await SourceRoot.open(input);
      if (this.closed) { await reader.close(); throw new DesktopError("INTERRUPTED", "目录服务正在停止", true); }
      try {
        db.prepare("INSERT INTO configuration_directory(id,version,path,grant_json,kind,created_at) VALUES(?,1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET grant_json=excluded.grant_json").run(input.id, input.path, JSON.stringify(input), kind, new Date().toISOString());
      } catch (error) { await reader.close(); throw error; }
      const old = this.readers.get(input.id); this.readers.set(input.id, reader); await old?.close();
      return this.binding(input.id);
    });
    this.queue = work; return work;
  }
  defaults(): DefaultDownloadDirectory {
    const row = this.database.connection.prepare("SELECT version,directory_id FROM default_download_directory WHERE singleton=1").get() as { version: number; directory_id: string | null };
    return { version: row.version, directory: row.directory_id ? this.binding(row.directory_id) : null };
  }
  setDefault(input: { expectedVersion: number; directoryId: string | null; requestKey: string }): DefaultDownloadDirectory {
    if (this.closed) throw new DesktopError("INTERRUPTED", "目录服务正在停止", true);
    const db = this.database.connection, key = "configuration.default." + input.requestKey, signature = JSON.stringify(input);
    return db.transaction(() => {
      const receipt = db.prepare("SELECT value FROM app_setting WHERE key=?").get(key) as { value: string } | undefined;
      if (receipt) { const saved = JSON.parse(receipt.value); if (saved.signature !== signature) throw new DesktopError("CONFLICT", "该请求已用于其他默认目录设置"); return saved.result as DefaultDownloadDirectory; }
      if (input.directoryId && this.kind(input.directoryId) !== "managed") throw new DesktopError("CONFLICT", "默认下载目录需要受管下载根，请通过选择下载目录授权");
      const result = db.prepare("UPDATE default_download_directory SET directory_id=?,version=version+1 WHERE singleton=1 AND version=?").run(input.directoryId, input.expectedVersion);
      if (!result.changes) throw new DesktopError("CONFLICT", "默认下载目录设置已变化，请刷新后再保存");
      const saved = this.defaults(); db.prepare("INSERT INTO app_setting VALUES(?,?)").run(key, JSON.stringify({ signature, result: saved })); return saved;
    })();
  }
  resolve(selection: { kind: "default" } | { kind: "directory"; directoryId: string }) {
    const defaults = this.defaults(), id = selection.kind === "default" ? defaults.directory?.id : selection.directoryId;
    if (!id) throw new DesktopError("CONFLICT", "尚未设置默认本地下载目录，请先在设置选择目录或显式选择目标");
    return { directory: this.binding(id), defaultDirectoryVersion: selection.kind === "default" ? defaults.version : null };
  }
  async close() { this.closed = true; await this.queue.catch(() => {}); await Promise.allSettled([...this.readers.values()].map((root) => root.close())); this.readers.clear(); }
}
