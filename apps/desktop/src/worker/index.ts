import { createMediaApplication } from "@media-marshal/media-core";
import {
  PROTOCOL_VERSION,
  MAX_RESPONSE_BYTES,
  checkMessageSize,
  parseCoreRequest,
  publicError,
} from "@media-marshal/contracts";
import { z } from "zod";
import { RestrictedHostClient } from "@media-marshal/contracts/internal/rpc";

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
  } });
  let stopping: Promise<void> | undefined;
  const shutdown = () =>
    (stopping ??= (host.invalidate(), runtime.stop()).then(
      () => {
        port.close();
        process.exit(0);
      },
      () => process.exit(1),
    ));
  port.on("close", () => {
    void shutdown();
  });
  port.on("message", (message) => {
    if (message.data?.kind === "host.response" || message.data?.kind === "host.event") { host.receive(message.data); return; }
    if (message.data?.kind === "sidecar.generation" && z.uuid().safeParse(message.data.hostGeneration).success) {
      host.invalidate(); hostGeneration = message.data.hostGeneration; hostOnline = true; return;
    }
    if (message.data?.kind === "sidecar.lost" && message.data.hostGeneration === hostGeneration) { hostOnline = false; host.invalidate(); return; }
    if (message.data?.kind === "shutdown") {
      void shutdown();
      return;
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
