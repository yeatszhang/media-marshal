import { createMediaApplication } from "@media-marshal/media-core";
import {
  PROTOCOL_VERSION,
  MAX_RESPONSE_BYTES,
  checkMessageSize,
  parseCoreRequest,
  publicError,
} from "@media-marshal/contracts";
import { privateCoreRequestSchema } from "@media-marshal/contracts/internal/core";
import { z } from "zod";
import { RestrictedHostClient } from "@media-marshal/contracts/internal/rpc";
import { nativeFileLaunchSchema, parserLaunchSchema } from "@media-marshal/contracts/internal";

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
  const runtime = createMediaApplication(input.databasePath, [], { host: {
    context(bindingGeneration, attemptId) { return { coreGeneration, hostGeneration, bindingGeneration, attemptId }; },
    request: (action, payload, context, key) => host.request(action, payload, context, key),
    observe: (handle, context, listener) => host.observe(handle, context, listener),
  }, cancelHostRequests: () => { hostOnline = false; host.invalidate(); }, ...(input.parser ? { parser: parserLaunchSchema.parse(input.parser) } : {}), ...(input.nativeFiles ? { nativeFiles: nativeFileLaunchSchema.parse(input.nativeFiles) } : {}) });
  let stopping: Promise<void> | undefined;
  let parentHeartbeat = Date.now();
  const shutdown = () =>
    (stopping ??= runtime.stop().finally(() => host.invalidate()).then(
      () => {
        clearInterval(parentCheck);
        port.close();
        process.exit(0);
      },
      () => { clearInterval(parentCheck); process.exit(1); },
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
    if (message.data?.kind === "core.private.request") {
      const parsed = privateCoreRequestSchema.safeParse(message.data);
      if (!parsed.success || stopping) return;
      void runtime.dispatchPrivate(parsed.data).then(
        (result) => port.postMessage({ kind: "core.private.response", requestId: parsed.data.requestId, ok: true, result }),
        (error) => port.postMessage({ kind: "core.private.response", requestId: parsed.data.requestId, ok: false, error: publicError(error) }),
      ); return;
    }
    void (async () => {
      let requestId: string | undefined;
      try {
        const request = parseCoreRequest(message.data);
        requestId = request.requestId;
        const result = await runtime.dispatch(request);
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
      if (!stopping)
        port.postMessage({ kind: "ready", protocolVersion: PROTOCOL_VERSION });
    },
    async () => {
      await runtime.stop().catch(() => {});
      process.exit(1);
    },
  );
});
