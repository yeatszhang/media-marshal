import { CloudError, driveCapabilitiesSchema } from "@media-marshal/contracts";
import {
  implementationIdSchema, transferSourceLeaseSchema,
  type CloudDriveProvider, type SourceRequest, type TransferEngine,
} from "@media-marshal/contracts/internal";

export class StaticTransferRegistry {
  private providers = new Map<string, CloudDriveProvider>();
  private engines = new Map<string, TransferEngine>();
  constructor(providers: readonly CloudDriveProvider[], engines: readonly TransferEngine[]) {
    for (const provider of providers) this.registerProvider(provider);
    for (const engine of engines) {
      implementationIdSchema.parse(engine.implementationId);
      if (this.engines.has(engine.implementationId)) throw new CloudError("CONFLICT");
      this.engines.set(engine.implementationId, engine);
    }
  }
  registerProvider(provider: CloudDriveProvider) {
    implementationIdSchema.parse(provider.implementationId);
    if (this.providers.has(provider.implementationId)) throw new CloudError("CONFLICT");
    this.providers.set(provider.implementationId, provider);
  }
  findProvider(implementationId: string): CloudDriveProvider | undefined { return this.providers.get(implementationId); }
  provider(implementationId: string): CloudDriveProvider {
    const provider = this.providers.get(implementationId);
    if (!provider) throw new CloudError("UNSUPPORTED_CAPABILITY");
    return provider;
  }
  async prepare(implementationId: string, source: SourceRequest) {
    const provider = this.provider(implementationId);
    const capabilityResult = driveCapabilitiesSchema.safeParse(await provider.capabilities(source.binding));
    if (!capabilityResult.success) throw new CloudError("COMPONENT_UNAVAILABLE");
    const capabilities = capabilityResult.data;
    const engine = [...this.engines.values()].find((candidate) => capabilities.sourceKinds.some((kind) => candidate.supportedSourceKinds.includes(kind)));
    // 协商必须先于租约与写操作，不能在能力不匹配时尝试组件私有兜底。
    if (!engine) throw new CloudError("UNSUPPORTED_CAPABILITY");
    const raw = await provider.acquireSource(source);
    const parsed = transferSourceLeaseSchema.safeParse(raw);
    if (!parsed.success || !engine.supportedSourceKinds.includes(parsed.data.kind) || !capabilities.sourceKinds.includes(parsed.data.kind) || parsed.data.generation !== source.binding.generation) {
      await provider.releaseSource(raw.leaseId);
      if (!parsed.success) throw new CloudError("COMPONENT_UNAVAILABLE");
      throw new CloudError(parsed.data.generation !== source.binding.generation ? "INTERRUPTED" : "UNSUPPORTED_CAPABILITY");
    }
    let released: Promise<void> | undefined;
    return { engine, lease: parsed.data, release: () => released ??= provider.releaseSource(parsed.data.leaseId) };
  }
}
