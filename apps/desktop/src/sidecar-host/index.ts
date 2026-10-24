import { z } from "zod";
import { cloudFailure } from "@media-marshal/contracts";
import { HOST_PROTOCOL_VERSION } from "@media-marshal/contracts/internal";
import { SidecarBinaryResolver, lockedDefinitions, sidecarTarget } from "./binary-resolver";
import { sidecarInitializeSchema, credentialInstallSchema, credentialDropSchema } from "./protocol";
import { createSidecarApplication } from "./application";

process.parentPort.once("message", (initial) => {
  const input = sidecarInitializeSchema.safeParse(initial.data);
  const port = initial.ports[0];
  if (!input.success || !port) { process.exit(1); return; }
  const config = input.data;
  const target = sidecarTarget(process.platform, process.arch);
  if (config.guardian.target !== target) { process.exit(1); return; }
  const runtime = createSidecarApplication({
    hostGeneration: config.hostGeneration, coreGeneration: config.coreGeneration, bindings: config.bindings,
    resolver: new SidecarBinaryResolver(config.resourceRoot, target, lockedDefinitions(target, config.guardian.binary)),
  });
  let heartbeat = Date.now();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= runtime.stop().then(
    () => { clearInterval(check); port.postMessage({ kind: "sidecar.stopped", hostGeneration: config.hostGeneration, stopped: true }); setTimeout(() => { port.close(); process.exit(0); }, 25); },
    () => { clearInterval(check); port.close(); process.exit(1); },
  );
  const check = setInterval(() => { if (Date.now() - heartbeat > 10000) void stop(); }, 250);
  port.on("close", () => { void stop(); });
  port.on("message", ({ data }) => {
    if (data?.kind === "sidecar.heartbeat") { heartbeat = Date.now(); return; }
    if (data?.kind === "sidecar.shutdown") { void stop(); return; }
    if (data?.kind === "sidecar.authorize-core" && z.uuid().safeParse(data.coreGeneration).success) { runtime.authorizeCore(data.coreGeneration); return; }
    if (data?.kind === "sidecar.credential.install" || data?.kind === "sidecar.credential.drop") {
      const parsed = data.kind === "sidecar.credential.install" ? credentialInstallSchema.safeParse(data) : credentialDropSchema.safeParse(data);
      if (!parsed.success || stopping) return;
      if (parsed.data.kind === "sidecar.credential.install") runtime.installCredential(parsed.data.binding, parsed.data.secret);
      else runtime.dropCredential(parsed.data.accountId);
      port.postMessage({ kind: "sidecar.credential.result", requestId: parsed.data.requestId, ok: true }); return;
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
