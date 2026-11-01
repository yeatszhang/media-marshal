import { DesktopError, publicError, type CoreAction, type CoreInput, type CoreOutput } from "@media-marshal/contracts";
import type { PrivateCoreAction, PrivateCoreInput, PrivateCoreOutput } from "@media-marshal/contracts/internal/core";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { DownloadRootController } from "./cloud/roots";
import { probeManagedVolume, probeReadOnlyVolume } from "./cloud/volume-probe";
import { getLogger } from "../logging/node";

interface DirectoryCore {
  request<K extends CoreAction>(action: K, input: CoreInput<K>): Promise<CoreOutput<K>>;
  requestPrivate<K extends PrivateCoreAction>(action: K, input: PrivateCoreInput<K>): Promise<PrivateCoreOutput<K>>;
}
type SavedDirectory = PrivateCoreOutput<"configuration.bootstrap">[number];

/** 恢复始终复用已登记身份；不能把同路径的新卷当成原目录。 */
export class ConfigurationDirectoryController {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly core: DirectoryCore, private readonly roots: Pick<DownloadRootController, "validateDirectory" | "choose">, private readonly probes = { ordinary: probeReadOnlyVolume, media: probeManagedVolume }) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.catch(() => {}).then(work); this.queue = task; return task;
  }
  private async authorize(previous: SavedDirectory) {
    const path = await this.roots.validateDirectory(previous.grant.path);
    // 下载目标同时恢复 Core、传输宿主与配置读取句柄，避免只恢复其中一层。
    let grant: ManagedRootGrant | undefined;
    if (previous.kind === "managed") {
      const root = (await this.core.request("cloud.roots.list", {})).find((root) => root.id === previous.grant.id);
      if (root?.state !== "AVAILABLE") await this.roots.choose(path);
      grant = (await this.core.requestPrivate("cloud.roots.bootstrap", {})).find((root) => root.id === previous.grant.id);
    } else grant = await this.probes[previous.kind](path, previous.grant.id);
    if (!grant) throw new DesktopError("LOCAL_UNAVAILABLE", "原下载目录授权不存在，请在设置中重新选择原目录", true);
    await this.core.requestPrivate("configuration.authorize", { kind: previous.kind, grant });
  }
  restore(): Promise<void> {
    return this.serial(async () => {
      for (const previous of await this.core.requestPrivate("configuration.bootstrap", {})) {
        try { await this.authorize(previous); }
        catch (error) { this.report(previous, error); }
      }
    });
  }
  private report(previous: SavedDirectory, error: unknown) {
    const failure = publicError(error);
    getLogger("directories").warn({ event: "directory.restore.failed", directoryId: previous.grant.id, kind: previous.kind, code: failure.code, directoryIssue: failure.directoryIssue, error }, "配置目录授权恢复未完成");
  }
  prepareSyncPreview(input: CoreInput<"sync.preview">): Promise<boolean> {
    return this.serial(async () => {
      const source = (await this.core.request("sync.list", { includeDeleted: false })).find((row) => row.id === input.id);
      if (!source) return false; // 配置不存在或版本冲突仍由 Core 的预览校验返回。
      const configuration = input.mode === "execution" ? source.snapshot?.configuration : source.draft;
      if (!configuration) return false;
      const targetId = input.mode === "execution" || configuration.target.kind === "default"
        ? (await this.core.request("configuration.default", {})).directory?.id : configuration.target.directoryId;
      const ids = new Set([targetId, ...(configuration.type === "local" ? [configuration.inputDirectoryId] : [])]);
      const directories = await this.core.request("configuration.directories", {});
      const unavailable = directories.filter((directory) => ids.has(directory.id) && !directory.available);
      // 并发请求或启动恢复可能已修复句柄；原失败请求仍需获准重试一次。
      if (!unavailable.length) return [...ids].every((id) => directories.some((directory) => directory.id === id && directory.available));
      const saved = await this.core.requestPrivate("configuration.bootstrap", {});
      for (const directory of unavailable) {
        const previous = saved.find((value) => value.grant.id === directory.id);
        try {
          if (!previous) throw new DesktopError("LOCAL_UNAVAILABLE", "目录尚未授权", true);
          await this.authorize(previous);
        } catch (error) {
          if (previous) this.report(previous, error);
          const failure = publicError(error), action = directory.kind === "managed" ? "请在设置中重新选择原下载目录后重试" : "请重新选择并授权原目录后重试";
          throw new DesktopError(failure.code, `同步预览无法访问目录「${directory.path}」：${failure.message}。${action}`, failure.retryable, failure.retryAfterSeconds, failure.directoryIssue);
        }
      }
      return true;
    });
  }
}
