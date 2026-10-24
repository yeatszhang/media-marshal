import { createApplication, type ApplicationModule } from "@yeatz/app-framework/application";
import { createIdentifier } from "@yeatz/app-framework/ioc";
import { CloudError } from "@media-marshal/contracts";
import type { BindingRef, CloudDriveProvider, HostInput, TransferEngine } from "@media-marshal/contracts/internal";
import { RestrictedHostServer, type HostHandlers } from "@media-marshal/contracts/internal/rpc";
import type { SidecarBinaryResolver, BinaryName } from "./binary-resolver";
import { StaticTransferRegistry } from "./registry";

export interface HostBinding extends BindingRef { implementationId: string }
export const SidecarRegistryToken = createIdentifier<StaticTransferRegistry>("sidecar.registry");
export const SidecarBinariesToken = createIdentifier<Readonly<Record<BinaryName, string>>>("sidecar.binaries");
export function createSidecarApplication(options: {
  hostGeneration: string; coreGeneration: string; bindings: readonly HostBinding[];
  resolver: Pick<SidecarBinaryResolver, "resolve">;
  providers?: readonly CloudDriveProvider[]; engines?: readonly TransferEngine[];
  modules?: readonly ApplicationModule[];
}) {
  let coreGeneration: string | null = options.coreGeneration;
  const bindings = new Map(options.bindings.map((binding) => [binding.bindingId, { ...binding }]));
  const credentials = new Map<string, { bindingId: string; generation: string; secret: string }>();
  const registry = new StaticTransferRegistry(options.providers ?? [], options.engines ?? []);
  const resourceModule: ApplicationModule = {
    id: "sidecar.resources",
    async start(ctx) {
      // 未配置账号时连资源准备也不触发，Host 不主动发现或启动外部程序。
      if (bindings.size) ctx.container.bind(SidecarBinariesToken).toConstantValue(await options.resolver.resolve());
    },
  };
  const services: ApplicationModule = { id: "sidecar.services", dependencies: ["sidecar.resources"], register(bind) { bind(SidecarRegistryToken).toConstantValue(registry); } };
  const app = createApplication({ modules: [resourceModule, services, ...options.modules ?? []] });
  function provider(ref: BindingRef) {
    const configured = bindings.get(ref.bindingId);
    if (!configured || configured.accountId !== ref.accountId || configured.generation !== ref.generation) throw new CloudError("INTERRUPTED");
    return registry.provider(configured.implementationId);
  }
  const unavailable = () => { throw new CloudError("COMPONENT_UNAVAILABLE"); };
  const handlers: HostHandlers = {
    "provider.capabilities": (input) => provider(input).capabilities(input),
    "provider.list": (input) => provider(input.binding).list(input),
    "provider.stat": (input) => provider(input.binding).stat(input),
    "transfer.start": unavailable, "transfer.stop": unavailable,
    "transfer.status": (_: HostInput<"transfer.status">) => ({ handle: null, state: "UNKNOWN", lastSequence: 0, exitCode: null }),
  };
  const server = new RestrictedHostServer(handlers, (context) =>
    app.state === "running" && context.hostGeneration === options.hostGeneration && context.coreGeneration === coreGeneration && [...bindings.values()].some((binding) => binding.generation === context.bindingGeneration),
  );
  return {
    app,
    dispatch: (value: unknown) => server.receive(value),
    installCredential(binding: HostBinding, secret: string) {
      for (const [key, previous] of bindings) if (previous.accountId === binding.accountId) bindings.delete(key);
      bindings.set(binding.bindingId, { ...binding });
      credentials.set(binding.accountId, { bindingId: binding.bindingId, generation: binding.generation, secret });
    },
    readCredential(binding: BindingRef): string {
      const value = credentials.get(binding.accountId);
      if (!value || value.bindingId !== binding.bindingId || value.generation !== binding.generation) throw new CloudError("AUTH_REQUIRED");
      return value.secret;
    },
    dropCredential(accountId: string) {
      credentials.delete(accountId);
      for (const [key, binding] of bindings) if (binding.accountId === accountId) bindings.delete(key);
    },
    authorizeCore(generation: string) { coreGeneration = generation; },
    async stop() { coreGeneration = null; server.retire(); credentials.clear(); await app.stop(); },
  };
}
