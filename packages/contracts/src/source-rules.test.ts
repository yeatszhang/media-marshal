import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sourceConfigurationSchema, sourceRuleDraftSchema, parseCoreRequest } from "./index";

const cloud = { type: "cloud", name: "网盘来源", accountId: randomUUID(), remoteRef: randomUUID(), downloadRootId: randomUUID() };
const local = { type: "local", name: "本地来源", sourcePath: "/input", organization: { targetPath: "/library" } };
describe("统一来源受限契约", () => {
  it("删除和恢复要求配置、草稿与生命周期版本，只接受固定 ID", () => {
    const payload = { id: randomUUID(), expectedVersion: 1, expectedDraftRevision: 2, expectedLifecycleRevision: 0, requestKey: randomUUID() };
    for (const action of ["source-rules.remove", "source-rules.restore"]) {
      const request = { kind: "request", protocolVersion: 1, requestId: randomUUID(), action, payload }; expect(parseCoreRequest(request).action).toBe(action);
      for (const extra of [{ sourcePath: "/任意目录" }, { deleteFiles: true }, { credential: "fixture-private" }, { expectedLifecycleRevision: undefined }, { expectedDraftRevision: undefined }]) expect(() => parseCoreRequest({ ...request, payload: { ...payload, ...extra } })).toThrow();
    }
  });
  it("本地忽略保留未配置、默认和显式空列表的区别，网盘不接收本地规则", () => {
    expect(sourceConfigurationSchema.parse(local)).not.toHaveProperty("ignoredFilePatterns");
    for (const ignoredFilePatterns of [null, [], ["cache/", "*.tmp"]]) expect(sourceConfigurationSchema.parse({ ...local, ignoredFilePatterns })).toMatchObject({ ignoredFilePatterns });
    expect(sourceConfigurationSchema.parse({ ...local, ignoredFilePatterns: ["  cache/ "] })).toMatchObject({ ignoredFilePatterns: ["cache/"] });
    for (const ignoredFilePatterns of [[""], ["a\nb"], ["a\0b"], ["x".repeat(257)], Array(101).fill("*.tmp")]) expect(sourceConfigurationSchema.safeParse({ ...local, ignoredFilePatterns }).success).toBe(false);
    expect(sourceConfigurationSchema.safeParse({ ...cloud, ignoredFilePatterns: [] }).success).toBe(false);
  });
  it("类型互斥，客户端标签只属于本地配置，默认仅 COPY 和人工确认", () => {
    expect(sourceConfigurationSchema.parse(local)).toMatchObject({ client: "custom", organization: { operation: "COPY", automatic: false } });
    expect(sourceConfigurationSchema.parse(cloud)).toMatchObject({ organization: null, periodic: { enabled: false, intervalSeconds: 900 } });
    for (const value of [{ ...local, accountId: randomUUID() }, { ...cloud, sourcePath: "/input" }, { ...cloud, client: "quark" }, { ...local, organization: null }, { ...local, organization: { targetPath: "/library", operation: "MOVE" } }]) expect(sourceConfigurationSchema.safeParse(value).success).toBe(false);
  });
  it("配置与读取契约不接受凭据、任意组件字段、授权对象或缺失的并发版本", () => {
    const input = { id: randomUUID(), requestKey: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, configuration: cloud };
    expect(sourceRuleDraftSchema.safeParse(input).success).toBe(true);
    for (const extra of [{ cookie: "fixture-secret" }, { credentialRef: randomUUID() }, { binary: "/arbitrary" }, { grant: {} }]) expect(sourceRuleDraftSchema.safeParse({ ...input, configuration: { ...cloud, ...extra } }).success).toBe(false);
    expect(sourceRuleDraftSchema.safeParse({ ...input, expectedVersion: undefined }).success).toBe(false);
    expect(() => parseCoreRequest({ kind: "request", protocolVersion: 1, requestId: randomUUID(), action: "source-rules.apply", payload: { previewId: randomUUID(), requestKey: randomUUID(), grants: { path: "/arbitrary" } } })).toThrow();
  });
  it("过滤条件规范化并限制周期和输入规模", () => {
    expect(sourceConfigurationSchema.parse({ ...cloud, filters: { extensions: ["MKV", "mp4", "mkv"], names: ["b.mkv", "a.mkv", "b.mkv"] } })).toMatchObject({ filters: { extensions: ["mkv", "mp4"], names: ["a.mkv", "b.mkv"] } });
    expect(sourceConfigurationSchema.safeParse({ ...cloud, periodic: { enabled: true, intervalSeconds: 1 } }).success).toBe(false);
    expect(sourceConfigurationSchema.safeParse({ ...local, sourcePath: "x".repeat(4097) }).success).toBe(false);
  });
  it("来源和整理控制仅接受固定动作、版本和幂等 ID", () => {
    const request = { kind: "request", protocolVersion: 1, requestId: randomUUID(), action: "source-rules.control", payload: { id: randomUUID(), expectedVersion: 1, operation: "pause", requestKey: randomUUID() } };
    expect(parseCoreRequest(request).action).toBe("source-rules.control");
    for (const payload of [{ ...request.payload, expectedVersion: undefined }, { ...request.payload, operation: "shell" }, { ...request.payload, paused: true }]) expect(() => parseCoreRequest({ ...request, payload })).toThrow();
    expect(() => parseCoreRequest({ ...request, action: "source-rules.run-once", payload: { id: randomUUID(), expectedVersion: 1, requestKey: randomUUID(), intervalSeconds: 60 } })).toThrow();
    expect(() => parseCoreRequest({ ...request, action: "ingestion.set-paused", payload: { paused: true, requestKey: randomUUID(), command: "resume-all" } })).toThrow();
  });
});
