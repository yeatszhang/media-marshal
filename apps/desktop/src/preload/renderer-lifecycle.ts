import { rendererPrepareReloadSchema, RENDERER_PREPARE_RELOAD_CHANNEL, RENDERER_RELOAD_RESULT_CHANNEL } from "@media-marshal/contracts";

interface ReloadPort {
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
  send(channel: string, value: unknown): void;
}
/** 回调留在当前隔离上下文，IPC 只发送固定收据。 */
export function rendererReloadBridge(port: ReloadPort) {
  let listener: (() => Promise<void>) | undefined;
  let flight: { id: string; promise: Promise<void> } | undefined;
  const reply = (id: string, state: "prepared" | "failed") => { try { port.send(RENDERER_RELOAD_RESULT_CHANNEL, { id, state }); } catch { /* 文档已销毁时由 Main 的导航／销毁监听结束握手。 */ } };
  port.on(RENDERER_PREPARE_RELOAD_CHANNEL, (_event, value) => {
    const parsed = rendererPrepareReloadSchema.safeParse(value); if (!parsed.success) return;
    const { id } = parsed.data;
    if (flight?.id === id) return;
    if (flight) { reply(id, "failed"); return; }
    const cleanup = listener;
    const promise = Promise.resolve().then(async () => { if (!cleanup) throw new Error(); await cleanup(); }).then(
      () => { reply(id, "prepared"); },
      () => { reply(id, "failed"); },
    ).finally(() => { if (flight?.promise === promise) flight = undefined; });
    flight = { id, promise };
  });
  return (next: () => Promise<void>) => {
    if (typeof next !== "function" || listener) throw new Error("界面清理只能注册一个有效回调");
    listener = next;
    return () => { if (listener === next) listener = undefined; };
  };
}
