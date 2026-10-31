import { createMediaApplication } from "@media-marshal/media-core";
import {
  PROTOCOL_VERSION,
  MAX_RESPONSE_BYTES,
  checkMessageSize,
  parseCoreRequest,
  publicError,
} from "@media-marshal/contracts";
import { coreRequestCancellationSchema, privateCoreRequestSchema } from "@media-marshal/contracts/internal/core";
import { z } from "zod";
import { RestrictedHostClient } from "@media-marshal/contracts/internal/rpc";
import { nativeFileLaunchSchema, parserLaunchSchema } from "@media-marshal/contracts/internal";
import { createProcessLogger, setRootLogger } from "../logging/node";

const log = createProcessLogger("core").child({ scope: "core" });
setRootLogger(log);
log.info({ event: "core.start" }, "媒体核心进程已启动");
process.on("uncaughtExceptionMonitor", (error) => log.fatal({ error }, "媒体核心发生未捕获异常"));

process.parentPort.once("message", (event) => {
  const port = event.ports[0];
  const input = event.data;
  if (
    !port ||
    input?.kind !== "initialize" ||
    input.protocolVersion !== PROTOCOL_VERSION ||
    typeof input.databasePath !== "string"
    || !z.uuid().safeParse(input.coreGeneration).success || !z.uuid().safeParse(input.hostGeneration).success
  ) {
    process.exit(1);
    return;
  }
  const coreGeneration = input.coreGeneration as string;
  let hostGeneration = input.hostGeneration as string;
  let hostOnline = true;
  const host = new RestrictedHostClient((message) => port.postMessage(message), (context) => hostOnline && context.coreGeneration === coreGeneration && context.hostGeneration === hostGeneration);
  const runtime = createMediaApplication(input.databasePath, [], { logger: log, host: {
    context(bindingGeneration, attemptId) { return { coreGeneration, hostGeneration, bindingGeneration, attemptId }; },
    request: (action, payload, context, key) => host.request(action, payload, context, key),
    observe: (handle, context, listener) => host.observe(handle, context, listener),
  }, cancelHostRequests: () => { hostOnline = false; host.invalidate(); }, ...(input.parser ? { parser: parserLaunchSchema.parse(input.parser) } : {}), ...(input.nativeFiles ? { nativeFiles: nativeFileLaunchSchema.parse(input.nativeFiles) } : {}) });
  let stopping: Promise<void> | undefined;
  let parentHeartbeat = Date.now();
  const shutdown = () =>
    (stopping ??= runtime.stop().finally(() => host.invalidate()).then(
      () => {
        log.info({ event: "core.stopped" }, "媒体核心已停止");
        clearInterval(parentCheck);
        port.close();
        process.exit(0);
      },
      (error) => { log.error({ error }, "媒体核心停止失败"); clearInterval(parentCheck); process.exit(1); },
    ));
  const parentCheck = setInterval(() => { if (Date.now() - parentHeartbeat > 5000) void shutdown(); }, 250);
  port.on("close", () => {
    void shutdown();
  });
  port.on("message", (message) => {
    if (message.data?.kind === "core.heartbeat" && message.data.protocolVersion === PROTOCOL_VERSION) { parentHeartbeat = Date.now(); return; }
    if (message.data?.kind === "host.response" || message.data?.kind === "host.event") { host.receive(message.data); return; }
    if (message.data?.kind === "sidecar.generation" && z.uuid().safeParse(message.data.hostGeneration).success) {
      host.invalidate(); runtime.invalidateCloudRuntime(); hostGeneration = message.data.hostGeneration; runtime.confirmCloudWritersStopped(hostGeneration); hostOnline = true; return;
    }
    if (message.data?.kind === "sidecar.lost" && message.data.hostGeneration === hostGeneration) { hostOnline = false; host.invalidate(); runtime.invalidateCloudRuntime(); return; }
    if (message.data?.kind === "shutdown") {
      void shutdown();
      return;
    }
    if (message.data?.kind === "core.request.cancel") {
      const parsed = coreRequestCancellationSchema.safeParse(message.data);
      if (parsed.success) runtime.cancelRequest(parsed.data);
      return;
    }
    if (message.data?.kind === "core.private.request") {
      const parsed = privateCoreRequestSchema.safeParse(message.data);
      if (!parsed.success || stopping) return;
      void runtime.dispatchPrivate(parsed.data).then(
        (result) => port.postMessage({ kind: "core.private.response", requestId: parsed.data.requestId, ok: true, result }),
        (error) => {
          log.warn({ action: parsed.data.action, requestId: parsed.data.requestId, error }, "核心内部请求未完成");
          port.postMessage({ kind: "core.private.response", requestId: parsed.data.requestId, ok: false, error: publicError(error) });
        },
      ); return;
    }
    void (async () => {
      let requestId: string | undefined;
      let action: string | undefined;
      const started = performance.now();
      try {
        const request = parseCoreRequest(message.data);
        requestId = request.requestId;
        action = request.action;
        const result = await runtime.dispatch(request);
        log.debug({ action, requestId, durationMs: Math.round(performance.now() - started) }, "核心请求已完成");
        const response = {
          kind: "response",
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          ok: true,
          result,
        };
        checkMessageSize(response, MAX_RESPONSE_BYTES);
        port.postMessage(response);
      } catch (error) {
        log.warn({ action, requestId, error, durationMs: Math.round(performance.now() - started) }, "核心请求未完成");
        if (!requestId && typeof message.data?.requestId === "string")
          requestId = message.data.requestId;
        if (requestId)
          port.postMessage({
            kind: "response",
            protocolVersion: PROTOCOL_VERSION,
            requestId,
            ok: false,
            error: publicError(error),
          });
      }
    })();
  });
  port.start();
  void runtime.app.start().then(
    () => {
      if (!stopping) {
        log.info({ event: "core.ready" }, "媒体核心已就绪");
        port.postMessage({ kind: "ready", protocolVersion: PROTOCOL_VERSION });
      }
    },
    async (error) => {
      log.error({ event: "core.start.failed", error }, "媒体核心启动失败");
      await runtime.stop().catch(() => {});
      process.exit(1);
    },
  );
});
