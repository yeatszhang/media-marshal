import type { ApplicationModule } from "@yeatz/app-framework/application";
import { SidecarBinariesToken, type HostBinding } from "../application";
import { OpenListRuntime, OpenListRuntimeToken } from "./runtime";
import type { NativeObservation } from "../guardian";

export function openListModule(options: { privateRoot: string; hostGeneration: string; bindings: readonly HostBinding[]; observe?: (event: NativeObservation) => void; ready?: (runtime: OpenListRuntime) => void }): ApplicationModule {
  return {
    id: "sidecar.openlist", dependencies: ["sidecar.resources"],
    async start(ctx) {
      const runtime = new OpenListRuntime({ privateRoot: options.privateRoot, hostGeneration: options.hostGeneration, binaries: ctx.get(SidecarBinariesToken), observe: options.observe });
      // 下游初始化失败也必须先停止已启动的守护与服务。
      ctx.disposables.add(() => runtime.stop());
      await runtime.start();
      for (const binding of options.bindings) await runtime.readOnlyAccess(binding.accountId);
      ctx.container.bind(OpenListRuntimeToken).toConstantValue(runtime);
      options.ready?.(runtime);
    },
  };
}
