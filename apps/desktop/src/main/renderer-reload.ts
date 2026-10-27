import type { IpcMain, IpcMainEvent, WebContents, WebFrameMain } from "electron";
import { randomUUID } from "node:crypto";
import { DesktopError, rendererReloadResultSchema, RENDERER_PREPARE_RELOAD_CHANNEL, RENDERER_RELOAD_RESULT_CHANNEL } from "@media-marshal/contracts";
import { requireTrustedRequest } from "./security";

/** 只协调当前窗口的 Renderer；不停止或重建后台 Core。 */
export class RendererReloadController {
  private pending?: { id: string; frame: WebFrameMain; ignoreCache: boolean; promise: Promise<void>; resolve(): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> };
  private disposed = false;
  constructor(private readonly contents: WebContents, private readonly ipc: Pick<IpcMain, "on" | "removeListener">, private readonly canReload: () => boolean, private readonly developmentUrl?: string, private readonly timeoutMs = 15000) {
    ipc.on(RENDERER_RELOAD_RESULT_CHANNEL, this.result);
    contents.on("did-start-navigation", this.navigation);
    contents.on("render-process-gone", this.gone);
    contents.on("destroyed", this.dispose);
  }
  request(ignoreCache = false): Promise<void> {
    if (this.pending) return this.pending.promise;
    try {
      if (this.disposed || this.contents.isDestroyed() || !this.canReload()) throw new DesktopError("CONFLICT", "客户端正在停止，无法重载界面");
      requireTrustedRequest({}, this.contents.getURL(), true, this.developmentUrl);
      // 此分支只用于 Electron 已确认进程崩溃，不能把清理超时当作崩溃。
      if (this.contents.isCrashed()) { this.reload(ignoreCache); return Promise.resolve(); }
      const frame = this.contents.mainFrame, id = randomUUID();
      let resolve!: () => void, reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      const timer = setTimeout(() => this.finish(new DesktopError("TIMEOUT", "界面清理超时，未执行重载；请退出客户端后重新打开")), this.timeoutMs);
      this.pending = { id, frame, ignoreCache, promise, resolve, reject, timer };
      try { this.contents.send(RENDERER_PREPARE_RELOAD_CHANNEL, { id }); }
      catch { this.finish(new DesktopError("INTERRUPTED", "无法联系当前界面，未执行重载；请退出客户端后重新打开")); }
      return promise;
    } catch (error) { return Promise.reject(error); }
  }
  private reload(ignoreCache: boolean) { if (ignoreCache) this.contents.reloadIgnoringCache(); else this.contents.reload(); }
  private result = (event: IpcMainEvent, value: unknown) => {
    const pending = this.pending;
    if (!pending || this.disposed || event.sender !== this.contents || event.senderFrame !== pending.frame || event.senderFrame !== this.contents.mainFrame) return;
    try { requireTrustedRequest(value, event.senderFrame.url, true, this.developmentUrl); }
    catch { return; }
    const parsed = rendererReloadResultSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== pending.id) return;
    if (parsed.data.state === "failed") { this.finish(new DesktopError("INTERRUPTED", "界面清理未完成，未执行重载；请退出客户端后重新打开")); return; }
    if (!this.canReload()) { this.finish(new DesktopError("CONFLICT", "客户端正在停止，未执行界面重载")); return; }
    this.finish();
  };
  private finish(error?: unknown) {
    const pending = this.pending; if (!pending) return;
    this.pending = undefined; clearTimeout(pending.timer);
    if (error) { pending.reject(error); return; }
    try { this.reload(pending.ignoreCache); pending.resolve(); }
    catch { pending.reject(new DesktopError("INTERRUPTED", "界面未能重新加载，请退出客户端后重新打开")); }
  }
  private navigation = (event: { isMainFrame: boolean; isSameDocument: boolean }) => { if (event.isMainFrame && !event.isSameDocument) this.finish(new DesktopError("INTERRUPTED", "界面已导航，原重载请求已结束")); };
  private gone = () => this.finish(new DesktopError("INTERRUPTED", "界面进程已中断，可再次从视图菜单重新加载"));
  dispose = () => {
    if (this.disposed) return; this.disposed = true;
    this.finish(new DesktopError("INTERRUPTED", "界面已关闭，原重载请求已结束"));
    this.ipc.removeListener(RENDERER_RELOAD_RESULT_CHANNEL, this.result);
    this.contents.removeListener("did-start-navigation", this.navigation);
    this.contents.removeListener("render-process-gone", this.gone);
    this.contents.removeListener("destroyed", this.dispose);
  };
}
