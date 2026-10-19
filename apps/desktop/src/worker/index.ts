import { createMediaApplication } from "@media-marshal/media-core";
import {
  PROTOCOL_VERSION,
  MAX_RESPONSE_BYTES,
  checkMessageSize,
  parseCoreRequest,
  publicError,
} from "@media-marshal/contracts";

process.parentPort.once("message", (event) => {
  const port = event.ports[0];
  const input = event.data;
  if (
    !port ||
    input?.kind !== "initialize" ||
    input.protocolVersion !== PROTOCOL_VERSION ||
    typeof input.databasePath !== "string"
  ) {
    process.exit(1);
    return;
  }
  const runtime = createMediaApplication(input.databasePath);
  let stopping: Promise<void> | undefined;
  const shutdown = () =>
    (stopping ??= runtime.stop().then(
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
