import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  configurationConfirmationSchema, configurationPreviewContextSchema, configurationPreviewInvalidation,
  defaultDownloadDirectorySchema, defaultDownloadDirectoryWriteSchema, directoryBindingSchema,
  recognitionAutomaticConsentSchema, recognitionRuleConfigurationSchema, recognitionRuleSnapshotSchema,
  recognitionRuleWriteSchema, syncSourceConfigurationSchema, syncSourceSnapshotSchema, syncSourceWriteSchema,
} from "./index.js";

const directory = () => ({ id: randomUUID(), version: 1, path: "/隔离测试/下载目录" });
const local = () => ({ type: "local", name: "本地同步", inputDirectoryId: randomUUID() });
const cloud = () => ({ type: "cloud", name: "网盘同步", accountId: randomUUID(), remoteRef: randomUUID() });
const target = () => ({ id: randomUUID(), name: "电影", mediaType: "MOVIE", directoryId: randomUUID() });
const edit = () => ({ id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, expectedLifecycleRevision: 0, requestKey: randomUUID() });

describe("同步来源与识别映射的独立契约", () => {
  it("同步来源只持有输入、target、过滤和周期，不接收旧整理策略", () => {
    for (const configuration of [local(), cloud()]) {
      expect(syncSourceConfigurationSchema.parse(configuration)).toMatchObject({ target: { kind: "default" }, filters: [], periodic: { enabled: false } });
      for (const extra of [{ organization: null }, { organization: { targetPath: "/媒体库" } }, { mediaType: "MOVIE" }, { automatic: true }, { targetPath: "/媒体库" }]) expect(syncSourceConfigurationSchema.safeParse({ ...configuration, ...extra }).success).toBe(false);
    }
    expect(syncSourceConfigurationSchema.safeParse({ ...local(), accountId: randomUUID() }).success).toBe(false);
    expect(syncSourceConfigurationSchema.safeParse({ ...cloud(), inputDirectoryId: randomUUID() }).success).toBe(false);
    expect(syncSourceConfigurationSchema.safeParse({ ...local(), client: "alipan" }).success).toBe(false);
  });

  it("默认目录未选择可保存，修改需要并发版本和显式请求身份", () => {
    expect(defaultDownloadDirectorySchema.parse({ version: 0, directory: null }).directory).toBeNull();
    expect(defaultDownloadDirectoryWriteSchema.parse({ expectedVersion: 1, directoryId: randomUUID(), requestKey: randomUUID() })).toHaveProperty("directoryId");
    expect(defaultDownloadDirectoryWriteSchema.safeParse({ directoryId: randomUUID(), requestKey: randomUUID() }).success).toBe(false);
    expect(defaultDownloadDirectoryWriteSchema.safeParse({ expectedVersion: 1, directoryId: randomUUID(), requestKey: randomUUID(), moveFiles: true }).success).toBe(false);
  });

  it("识别规则默认人工 COPY，允许空目标等待配置和多个同类型目标等待选择", () => {
    expect(recognitionRuleConfigurationSchema.parse({ name: "识别", targets: [] })).toMatchObject({ automatic: false, operation: "COPY", input: { kind: "default" } });
    const first = target(), second = target();
    expect(recognitionRuleConfigurationSchema.safeParse({ name: "识别", targets: [first, second, { ...target(), mediaType: "TV_SHOW" }] }).success).toBe(true);
    expect(recognitionRuleConfigurationSchema.safeParse({ name: "识别", targets: [first, first] }).success).toBe(false);
    for (const extra of [{ accountId: randomUUID() }, { periodic: { enabled: true } }, { operation: "MOVE" }, { organization: {} }]) expect(recognitionRuleConfigurationSchema.safeParse({ name: "识别", targets: [first], ...extra }).success).toBe(false);
  });

  it("新写入和读取均拒绝原生授权、任意组件字段及凭据", () => {
    for (const schema of [syncSourceWriteSchema, recognitionRuleWriteSchema]) {
      const configuration = schema === syncSourceWriteSchema ? local() : { name: "识别", targets: [target()] };
      const input = { ...edit(), configuration };
      expect(schema.safeParse(input).success).toBe(true);
      for (const extra of [{ cookie: "fixture-private" }, { grant: {} }, { grantId: randomUUID() }, { volumeIdentity: "private-volume" }, { binaryPath: "/arbitrary" }]) {
        expect(schema.safeParse({ ...input, ...extra }).success).toBe(false);
        expect(schema.safeParse({ ...input, configuration: { ...configuration, ...extra } }).success).toBe(false);
        expect(directoryBindingSchema.safeParse({ ...directory(), ...extra }).success).toBe(false);
      }
      for (const field of ["expectedVersion", "expectedDraftRevision", "expectedLifecycleRevision", "requestKey"]) expect(schema.safeParse({ ...input, [field]: undefined }).success).toBe(false);
    }
  });

  it("同步快照冻结具体目录，默认设置变化不改写既有快照", () => {
    const input = directory(), output = directory();
    const snapshot = { sourceId: randomUUID(), sourceVersion: 1, configuration: { ...local(), inputDirectoryId: input.id }, inputDirectory: input, targetDirectory: output, defaultDirectoryVersion: 2 };
    const parsed = syncSourceSnapshotSchema.parse(snapshot);
    output.path = "/更改后的目录";
    expect(parsed.targetDirectory.path).toBe("/隔离测试/下载目录");
    expect(syncSourceSnapshotSchema.safeParse({ ...snapshot, inputDirectory: null }).success).toBe(false);
    expect(syncSourceSnapshotSchema.safeParse({ ...snapshot, inputDirectory: directory() }).success).toBe(false);
    expect(syncSourceSnapshotSchema.safeParse({ ...snapshot, defaultDirectoryVersion: null }).success).toBe(false);
    const explicit = { ...snapshot, configuration: { ...snapshot.configuration, target: { kind: "directory", directoryId: output.id } }, defaultDirectoryVersion: null };
    expect(syncSourceSnapshotSchema.safeParse(explicit).success).toBe(true);
    expect(syncSourceSnapshotSchema.safeParse({ ...explicit, targetDirectory: directory() }).success).toBe(false);
    expect(syncSourceSnapshotSchema.safeParse({ ...explicit, defaultDirectoryVersion: 2 }).success).toBe(false);
    expect(syncSourceSnapshotSchema.safeParse({ ...snapshot, configuration: cloud() }).success).toBe(false);
  });

  it("识别快照完整冻结目标和 Emby 具体库根、连接与转换版本", () => {
    const output = directory(), mapping = { ...target(), directoryId: output.id };
    const embyBinding = { id: randomUUID(), version: 3, targetId: mapping.id, targetDirectory: output, serverId: "fixture-server", connectionVersion: 2, libraryId: "movies", libraryRoot: "/server/media", mediaType: "MOVIE", conversion: { id: randomUUID(), version: 4, localRoot: output, serverRoot: "/server/media", serverPathStyle: "posix" } };
    const snapshot = { ruleId: randomUUID(), ruleVersion: 5, configuration: { name: "识别", targets: [mapping] }, inputDirectory: directory(), inputMode: "managed-completed", defaultDirectoryVersion: 1, targets: [{ targetId: mapping.id, directory: output, embyBinding }] };
    expect(recognitionRuleSnapshotSchema.parse(snapshot).targets[0]?.embyBinding).toMatchObject({ version: 3, connectionVersion: 2, conversion: { version: 4 } });
    expect(recognitionRuleSnapshotSchema.safeParse({ ...snapshot, targets: [] }).success).toBe(false);
    expect(recognitionRuleSnapshotSchema.safeParse({ ...snapshot, targets: [snapshot.targets[0], snapshot.targets[0]] }).success).toBe(false);
    for (const patch of [{ targetId: randomUUID() }, { mediaType: "TV_SHOW" }, { targetDirectory: { ...output, version: 2 } }]) expect(recognitionRuleSnapshotSchema.safeParse({ ...snapshot, targets: [{ ...snapshot.targets[0], embyBinding: { ...embyBinding, ...patch } }] }).success).toBe(false);
    expect(recognitionRuleSnapshotSchema.safeParse({ ...snapshot, targets: [{ ...snapshot.targets[0], embyBinding: null }] }).success).toBe(true);
  });

  it("确认引用预览上下文，拒绝过期、删除恢复、目录和默认设置版本漂移", () => {
    const context = configurationPreviewContextSchema.parse({ owner: { id: randomUUID(), version: 1, draftRevision: 2, lifecycleRevision: 3 }, configurationFingerprint: "a".repeat(64), directories: [directory(), directory()], defaultDirectoryVersion: 4, expiresAt: 1000 });
    expect(configurationPreviewInvalidation(context, context, 999)).toBeNull();
    expect(configurationPreviewInvalidation(context, { ...context, directories: [...context.directories].reverse() }, 999)).toBeNull();
    expect(configurationPreviewInvalidation(context, context, 1000)).toBe("EXPIRED");
    for (const field of ["version", "draftRevision", "lifecycleRevision"] as const) expect(configurationPreviewInvalidation(context, { ...context, owner: { ...context.owner, [field]: context.owner[field] + 1 } }, 999)).toBe("CONFIGURATION_CHANGED");
    expect(configurationPreviewInvalidation(context, { ...context, configurationFingerprint: "b".repeat(64) }, 999)).toBe("CONFIGURATION_CHANGED");
    expect(configurationPreviewInvalidation(context, { ...context, defaultDirectoryVersion: 5 }, 999)).toBe("DEFAULT_DIRECTORY_CHANGED");
    for (const directories of [[], [directory(), context.directories[1]!], [{ ...context.directories[0]!, version: 2 }, context.directories[1]!], [{ ...context.directories[0]!, path: "/替换路径" }, context.directories[1]!]]) expect(configurationPreviewInvalidation(context, { ...context, directories }, 999)).toBe("DIRECTORY_CHANGED");
    expect(configurationConfirmationSchema.safeParse({ previewId: randomUUID(), requestKey: randomUUID(), context, grants: {} }).success).toBe(false);
  });

  it("自动授权属于识别规则版本，不能用来源授权或客户端完成断言代替", () => {
    const consent = { ruleId: randomUUID(), ruleVersion: 1, samplePreviewId: randomUUID(), configurationFingerprint: "a".repeat(64), accepted: true };
    expect(recognitionAutomaticConsentSchema.safeParse(consent).success).toBe(true);
    for (const extra of [{ accepted: false }, { ruleVersion: undefined }, { sourceId: randomUUID() }, { filesComplete: true }, { verifiedProfile: "猜测客户端" }]) expect(recognitionAutomaticConsentSchema.safeParse({ ...consent, ...extra }).success).toBe(false);
  });
});
