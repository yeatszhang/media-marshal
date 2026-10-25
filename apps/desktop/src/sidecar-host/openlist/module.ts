import type { ApplicationModule } from "@yeatz/app-framework/application";
import { SidecarBinariesToken, SidecarRegistryToken, type HostBinding } from "../application";
import { SourceCredentialBrokerToken } from "../source-credentials";
import { OpenListQuarkProvider } from "./provider";
import { CloudError } from "@media-marshal/contracts";
import type { BindingRef } from "@media-marshal/contracts/internal";
import { OpenListRuntime, OpenListRuntimeToken } from "./runtime";
import type { NativeObservation } from "../guardian";
import { RcloneCliEngine } from "../rclone/engine";
import { join } from "node:path";

export function openListModule(options: { privateRoot: string; hostGeneration: string; bindings: readonly HostBinding[]; observe?: (event: NativeObservation) => void; failed?: () => void; credentialUpdated?: (binding: BindingRef, cookie: string) => Promise<void>; ready?: (runtime: OpenListRuntime) => void }): ApplicationModule {
  return {
    id: "sidecar.openlist", dependencies: ["sidecar.resources", "sidecar.services"],
    async start(ctx) {
      const runtime = new OpenListRuntime({ privateRoot: options.privateRoot, hostGeneration: options.hostGeneration, binaries: ctx.get(SidecarBinariesToken), observe: options.observe, failed: options.failed });
      // 下游初始化失败也必须先停止已启动的守护与服务。
      ctx.disposables.add(() => runtime.stop());
      await runtime.start();
      for (const binding of options.bindings) await runtime.readOnlyAccess(binding.generation);
      ctx.container.bind(OpenListRuntimeToken).toConstantValue(runtime);
      ctx.get(SidecarRegistryToken).registerProvider(new OpenListQuarkProvider(runtime, ctx.get(SourceCredentialBrokerToken), options.credentialUpdated ?? (async () => { throw new CloudError("COMPONENT_UNAVAILABLE"); })));
      const engine = new RcloneCliEngine(runtime.transport, ctx.get(SourceCredentialBrokerToken), join(runtime.sessionRoot, "rclone"));
      ctx.get(SidecarRegistryToken).registerEngine(engine);
      ctx.disposables.add(() => engine.dispose());
      options.ready?.(runtime);
    },
  };
}
