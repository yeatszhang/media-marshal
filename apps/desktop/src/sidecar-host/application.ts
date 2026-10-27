import { createApplication, type ApplicationModule } from "@yeatz/app-framework/application";
import { createIdentifier } from "@yeatz/app-framework/ioc";
import { CloudError } from "@media-marshal/contracts";
import type { BindingRef, CloudDriveProvider, ExecutionContext, ExecutionHandle, TransferEngine, TransferEvent, TransferPlan } from "@media-marshal/contracts/internal";
import { RestrictedHostServer, type HostHandlers } from "@media-marshal/contracts/internal/rpc";
import type { SidecarBinaryResolver, BinaryName } from "./binary-resolver";
import { StaticTransferRegistry } from "./registry";
import { SourceCredentialBroker, SourceCredentialBrokerToken } from "./source-credentials";
import { HostExecutions } from "./executions";

export interface HostBinding extends BindingRef { implementationId: string }
const providerRef = (binding: BindingRef): BindingRef => ({ accountId: binding.accountId, bindingId: binding.bindingId, generation: binding.generation });
export const SidecarRegistryToken = createIdentifier<StaticTransferRegistry>("sidecar.registry");
export const SidecarBinariesToken = createIdentifier<Readonly<Record<BinaryName, string>>>("sidecar.binaries");
export function createSidecarApplication(options: {
  hostGeneration: string; coreGeneration: string; bindings: readonly HostBinding[];
  resolver: Pick<SidecarBinaryResolver, "resolve">;
  providers?: readonly CloudDriveProvider[]; engines?: readonly TransferEngine[];
  modules?: readonly ApplicationModule[];
  staging?: (plan: TransferPlan) => Promise<string>;
  publish?: (input: { context: ExecutionContext; handle: ExecutionHandle; sequence: number; event: TransferEvent }) => void;
}) {
  let coreGeneration: string | null = options.coreGeneration;
  const bindings = new Map(options.bindings.map((binding) => [binding.bindingId, { ...binding }]));
  const credentials = new Map<string, { bindingId: string; generation: string; secret: string }>();
  const sourceCredentials = new SourceCredentialBroker();
  let retiring = false;
  const privateOperations = new Set<Promise<unknown>>();
  const accountQueues = new Map<string, Promise<unknown>>();
  function privateOperation<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    if (retiring) return Promise.reject(new CloudError("INTERRUPTED"));
    const task = (accountQueues.get(accountId) ?? Promise.resolve()).catch(() => {}).then(() => { if (retiring) throw new CloudError("INTERRUPTED"); if (app.state !== "running") throw new CloudError("COMPONENT_UNAVAILABLE"); return work(); });
    accountQueues.set(accountId, task); privateOperations.add(task);
    void task.finally(() => { privateOperations.delete(task); if (accountQueues.get(accountId) === task) accountQueues.delete(accountId); }).catch(() => {});
    return task;
  }
  const registry = new StaticTransferRegistry(options.providers ?? [], options.engines ?? []);
  const resourceModule: ApplicationModule = {
    id: "sidecar.resources",
    async start(ctx) {
      // 未配置账号时连资源准备也不触发，Host 不主动发现或启动外部程序。
      if (bindings.size) ctx.container.bind(SidecarBinariesToken).toConstantValue(await options.resolver.resolve());
    },
  };
  const services: ApplicationModule = { id: "sidecar.services", dependencies: ["sidecar.resources"], register(bind) { bind(SidecarRegistryToken).toConstantValue(registry); bind(SourceCredentialBrokerToken).toConstantValue(sourceCredentials); } };
  const app = createApplication({ modules: [resourceModule, services, ...options.modules ?? []] });
  function provider(ref: BindingRef) {
    const configured = bindings.get(ref.bindingId);
    if (!configured || configured.accountId !== ref.accountId || configured.generation !== ref.generation) throw new CloudError("INTERRUPTED");
    return registry.provider(configured.implementationId);
  }
  const executions = new HostExecutions(registry, (ref) => {
    const binding = bindings.get(ref.bindingId);
    if (!binding || binding.accountId !== ref.accountId || binding.generation !== ref.generation) throw new CloudError("INTERRUPTED");
    return binding.implementationId;
  }, options.staging ?? (async () => { throw new CloudError("LOCAL_UNAVAILABLE"); }), options.publish);
  const handlers: HostHandlers = {
    "provider.capabilities": (input) => provider(input).capabilities(input),
    "provider.list": (input) => provider(input.binding).list(input),
    "provider.stat": (input) => provider(input.binding).stat(input),
    "transfer.start": (input, context) => {
      if (accountQueues.has(input.items[0]!.source.binding.accountId)) throw new CloudError("INTERRUPTED");
      return executions.start(input, context);
    },
    "transfer.stop": (input) => executions.stop(input),
    "transfer.status": (input) => executions.status(input.attemptId),
  };
  const server = new RestrictedHostServer(handlers, (context) =>
    app.state === "running" && context.hostGeneration === options.hostGeneration && context.coreGeneration === coreGeneration && [...bindings.values()].some((binding) => binding.generation === context.bindingGeneration),
  );
  return {
    app,
    dispatch: (value: unknown) => server.receive(value),
    installCredential(binding: HostBinding, secret: string) { return privateOperation(binding.accountId, async () => {
      await executions.stopAccount(binding.accountId);
      const provider = registry.findProvider(binding.implementationId);
      const identity = await provider?.validateCredential({ binding: providerRef(binding), cookie: secret }) ?? { stableKey: null };
      if (retiring) throw new CloudError("INTERRUPTED");
      try {
        for (const previous of bindings.values()) if (previous.accountId === binding.accountId && previous.generation !== binding.generation) await registry.findProvider(previous.implementationId)?.disconnect(providerRef(previous));
      } catch (error) { await provider?.disconnect(providerRef(binding)).catch(() => {}); throw error; }
      for (const [key, previous] of bindings) if (previous.accountId === binding.accountId) bindings.delete(key);
      bindings.set(binding.bindingId, { ...binding });
      credentials.set(binding.accountId, { bindingId: binding.bindingId, generation: binding.generation, secret });
      return { ...identity, capabilities: provider ? await provider.capabilities(providerRef(binding)) : null };
    }); },
    readCredential(binding: BindingRef): string {
      const value = credentials.get(binding.accountId);
      if (!value || value.bindingId !== binding.bindingId || value.generation !== binding.generation) throw new CloudError("AUTH_REQUIRED");
      return value.secret;
    },
    dropCredential(accountId: string) { return privateOperation(accountId, async () => {
      await executions.stopAccount(accountId);
      for (const binding of bindings.values()) if (binding.accountId === accountId) await registry.findProvider(binding.implementationId)?.disconnect(providerRef(binding));
      credentials.delete(accountId);
      for (const [key, binding] of bindings) if (binding.accountId === accountId) bindings.delete(key);
    }); },
    quiesceAccount(accountId: string) { return privateOperation(accountId, () => executions.stopAccount(accountId)); },
    authorizeCore(generation: string) { coreGeneration = generation; },
    async stop() {
      retiring = true; coreGeneration = null; server.retire();
      try { await executions.dispose(); }
      finally { credentials.clear(); sourceCredentials.clear(); await app.stop(); await Promise.allSettled([...privateOperations]); }
    },
  };
}
