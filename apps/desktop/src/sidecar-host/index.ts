import { z } from "zod";
import { CloudError, cloudFailure } from "@media-marshal/contracts";
import { HOST_PROTOCOL_VERSION, type BindingRef } from "@media-marshal/contracts/internal";
import { randomUUID } from "node:crypto";
import { SidecarBinaryResolver, lockedDefinitions, sidecarTarget } from "./binary-resolver";
import { sidecarInitializeSchema, credentialInstallSchema, credentialDropSchema } from "./protocol";
import { createSidecarApplication } from "./application";
import { openListModule } from "./openlist/module";

process.parentPort.once("message", (initial) => {
  const input = sidecarInitializeSchema.safeParse(initial.data);
  const port = initial.ports[0];
  if (!input.success || !port) { process.exit(1); return; }
  const config = input.data;
  const target = sidecarTarget(process.platform, process.arch);
  if (config.guardian.target !== target) { process.exit(1); return; }
  const refreshing = new Map<string, { done: (ok: boolean) => void; deadline: ReturnType<typeof setTimeout> }>();
  const credentialUpdated = (binding: BindingRef, secret: string): Promise<void> => {
    if (stopping || refreshing.size >= 32) return Promise.reject(new CloudError("CONFLICT"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { refreshing.delete(requestId); reject(new CloudError("TIMEOUT")); }, 10000);
      refreshing.set(requestId, { deadline, done: (ok) => { clearTimeout(deadline); refreshing.delete(requestId); if (ok) resolve(); else reject(new CloudError("INTERRUPTED")); } });
      port.postMessage({ kind: "sidecar.credential.refresh", requestId, binding, secret });
    });
  };
  const runtime = createSidecarApplication({
    hostGeneration: config.hostGeneration, coreGeneration: config.coreGeneration, bindings: config.bindings,
    resolver: new SidecarBinaryResolver(config.resourceRoot, target, lockedDefinitions(target, config.guardian.binary)),
    modules: [openListModule({ privateRoot: config.privateRoot, hostGeneration: config.hostGeneration, bindings: config.bindings, observe: (event) => {
      if (event.type === "started" || event.type === "exited" || event.type === "lost") port.postMessage({ kind: "sidecar.native", hostGeneration: config.hostGeneration, ...event });
    }, credentialUpdated, failed: () => { port.postMessage({ kind: "sidecar.failed", protocolVersion: HOST_PROTOCOL_VERSION }); void stop(); } })],
  });
  let heartbeat = Date.now();
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return stopping;
    for (const pending of refreshing.values()) pending.done(false);
    return stopping = runtime.stop().then(
    () => { clearInterval(check); port.postMessage({ kind: "sidecar.stopped", hostGeneration: config.hostGeneration, stopped: true }); setTimeout(() => { port.close(); process.exit(0); }, 25); },
    () => { clearInterval(check); port.close(); process.exit(1); },
    );
  };
  const check = setInterval(() => { if (Date.now() - heartbeat > 10000) void stop(); }, 250);
  port.on("close", () => { void stop(); });
  port.on("message", ({ data }) => {
    if (data?.kind === "sidecar.credential.refresh.result" && z.uuid().safeParse(data.requestId).success && typeof data.ok === "boolean") { refreshing.get(data.requestId)?.done(data.ok); return; }
    if (data?.kind === "sidecar.heartbeat") { heartbeat = Date.now(); return; }
    if (data?.kind === "sidecar.shutdown") { void stop(); return; }
    if (data?.kind === "sidecar.authorize-core" && z.uuid().safeParse(data.coreGeneration).success) { runtime.authorizeCore(data.coreGeneration); return; }
    if (data?.kind === "sidecar.credential.install" || data?.kind === "sidecar.credential.drop") {
      const parsed = data.kind === "sidecar.credential.install" ? credentialInstallSchema.safeParse(data) : credentialDropSchema.safeParse(data);
      if (!parsed.success || stopping) return;
      const request = parsed.data;
      void (async () => {
        try {
          if (request.kind === "sidecar.credential.install") await runtime.installCredential(request.binding, request.secret);
          else await runtime.dropCredential(request.accountId);
          if (!stopping) port.postMessage({ kind: "sidecar.credential.result", requestId: request.requestId, ok: true });
        } catch (error) { if (!stopping) port.postMessage({ kind: "sidecar.credential.result", requestId: request.requestId, ok: false, error: cloudFailure(error) }); }
      })(); return;
    }
    if (data?.kind !== "host.request" || stopping) return;
    void runtime.dispatch(data).then((response) => { if (!stopping) port.postMessage(response); }).catch(() => {});
  });
  port.start();
  void runtime.app.start().then(
    () => { if (!stopping) port.postMessage({ kind: "sidecar.ready", protocolVersion: HOST_PROTOCOL_VERSION, hostGeneration: config.hostGeneration }); },
    async (error) => { port.postMessage({ kind: "sidecar.failed", protocolVersion: HOST_PROTOCOL_VERSION, error: cloudFailure(error) }); await stop(); },
  );
});
