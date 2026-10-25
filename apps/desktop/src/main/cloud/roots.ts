import { DesktopError, type ManagedDownloadRoot } from "@media-marshal/contracts";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { PrivateCoreAction, PrivateCoreInput, PrivateCoreOutput } from "@media-marshal/contracts/internal/core";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathsOverlap } from "@media-marshal/media-core/files";
import { probeManagedVolume } from "./volume-probe";

interface RootCore {
  requestPrivate<K extends PrivateCoreAction>(action: K, payload: PrivateCoreInput<K>): Promise<PrivateCoreOutput<K>>;
  request(action: "cloud.roots.list", payload: {}): Promise<ManagedDownloadRoot[]>;
}
export class DownloadRootController {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly core: RootCore, private readonly host: { installRoot(grant: ManagedRootGrant): Promise<void>; forgetRoot?(id: string): void }, private readonly probe = probeManagedVolume, private readonly protectedPaths: readonly string[] = []) {}
  private async canonicalReserved(path: string): Promise<string> {
    try { return await realpath(path); }
    catch (error) { const parent = dirname(path); if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error; return join(await this.canonicalReserved(parent), basename(path)); }
  }
  async validateDirectory(path: string) {
    const canonical = await realpath(path);
    for (const reserved of this.protectedPaths) if (pathsOverlap(canonical, await this.canonicalReserved(reserved), { caseSensitive: false, unicodeEquivalent: true })) throw new DesktopError("FORBIDDEN", "请使用独立下载目录，不能选择应用安装目录或私有数据位置");
    return canonical;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> { const result = this.queue.catch(() => {}).then(work); this.queue = result; return result; }
  choose(path: string): Promise<ManagedDownloadRoot> {
    return this.serial(async () => {
      const grant = await this.core.requestPrivate("cloud.roots.authorize", await this.probe(await this.validateDirectory(path)));
      try { await this.host.installRoot(grant); }
      catch (error) { this.host.forgetRoot?.(grant.id); await this.core.requestPrivate("cloud.roots.unavailable", { id: grant.id }); throw error; }
      return (await this.core.request("cloud.roots.list", {})).find((root) => root.id === grant.id)!;
    });
  }
  restore() {
    return this.serial(async () => {
      for (const previous of await this.core.requestPrivate("cloud.roots.bootstrap", {})) {
        try { const grant = await this.core.requestPrivate("cloud.roots.authorize", await this.probe(await this.validateDirectory(previous.path), previous.id)); await this.host.installRoot(grant); }
        catch { this.host.forgetRoot?.(previous.id); await this.core.requestPrivate("cloud.roots.unavailable", { id: previous.id }); }
      }
    });
  }
}
