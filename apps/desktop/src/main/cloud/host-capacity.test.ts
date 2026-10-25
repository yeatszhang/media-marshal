import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { HostCapacity } from "./host-capacity";
describe("受管宿主的容量维护触发", () => {
  it("仅接受当前代际的不同终止执行，重放只触发一次；新代际重新计数", () => {
    const capacity = new HostCapacity(2), core = randomUUID(), host = randomUUID();
    const event = (generation = host) => ({ kind: "host.event", protocolVersion: 1, context: { coreGeneration: core, hostGeneration: generation, bindingGeneration: randomUUID(), attemptId: randomUUID() }, executionId: randomUUID(), sequence: 1, event: { type: "exited", exitCode: 0, stopped: false } });
    const first = event(); expect(capacity.observe(event(randomUUID()), core, host)).toBe(false); expect(capacity.observe(first, core, host)).toBe(false); expect(capacity.observe(first, core, host)).toBe(false); expect(capacity.observe(event(), core, host)).toBe(true); expect(capacity.observe(event(), core, host)).toBe(false);
    const next = randomUUID(); expect(capacity.observe(event(next), core, next)).toBe(false); expect(capacity.observe(event(next), core, next)).toBe(true);
  });
});
