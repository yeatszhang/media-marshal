import { hostEventSchema } from "@media-marshal/contracts/internal";

/** 保留整代际幂等收据；达到软容量后通过停写、OS 回收和新代际维护，不淘汰旧键。 */
export class HostCapacity {
  private generation?: string; private seen = new Set<string>(); private reported = false;
  constructor(private readonly threshold = 128) {}
  observe(value: unknown, coreGeneration: string | undefined, hostGeneration: string) {
    if (this.generation !== hostGeneration) { this.generation = hostGeneration; this.seen.clear(); this.reported = false; }
    const parsed = hostEventSchema.safeParse(value);
    if (!parsed.success || parsed.data.context.coreGeneration !== coreGeneration || parsed.data.context.hostGeneration !== hostGeneration || parsed.data.event.type !== "exited") return false;
    this.seen.add(parsed.data.context.attemptId);
    if (!this.reported && this.seen.size >= this.threshold) { this.reported = true; return true; } return false;
  }
}
