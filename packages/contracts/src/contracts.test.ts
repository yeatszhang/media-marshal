import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  DesktopError,
  PROTOCOL_VERSION,
  parseCoreRequest,
  publicError,
  sourceDraftSchema,
  CloudError,
  rpcErrorSchema,
  cloudFailureSchema,
  cloudFailure,
  directoryIssueSchema,
} from "./index";
const request = (action = "runtime.get", payload: unknown = {}) => ({
  kind: "request",
  protocolVersion: PROTOCOL_VERSION,
  requestId: randomUUID(),
  action,
  payload,
});
describe("受限进程契约", () => {
  it("修正只接受任务与已授权目标身份，完整文件清单确认不可省略，不接受路径或证据注入", () => {
    const taskId = randomUUID(), requestKey = randomUUID(), previewId = randomUUID(), input = { taskId, requestKey, selection: { tmdbId: 9, mediaType: "MOVIE" } };
    expect(parseCoreRequest(request("corrections.preview", input))).toMatchObject({ payload: { includeAccessories: true, selection: { season: null, episode: null, episodeEnd: null } } });
    for (const extra of [{ targetPath: "/任意目标" }, { sourcePath: "/任意来源" }, { nativeFiles: { manifestPath: "/任意模块" } }, { expected: { sha256: "a".repeat(64) } }]) expect(() => parseCoreRequest(request("corrections.preview", { ...input, ...extra }))).toThrow();
    for (const extra of [{}, { filesComplete: false }, { filesComplete: true, overwrite: true }]) expect(() => parseCoreRequest(request("corrections.confirm", { previewId, requestKey, ...extra }))).toThrow(); expect(parseCoreRequest(request("corrections.confirm", { previewId, requestKey, filesComplete: true }))).toMatchObject({ payload: { filesComplete: true } });
    expect(() => parseCoreRequest(request("corrections.list", { page: 1000001 }))).toThrow(); expect(() => parseCoreRequest(request("corrections.retry", { id: "../其他任务" }))).toThrow();
  });
  it("批量修正范围由 Core 计算，不接收任意成员、文件证据或目标路径，确认绑定范围指纹", () => {
    const taskId = randomUUID(), requestKey = randomUUID(), input = { taskId, requestKey, scope: "SAME_SEASON", tmdbId: 2 };
    expect(parseCoreRequest(request("corrections.preview-batch", input))).toMatchObject({ payload: { excludedTaskIds: [], includeAccessories: true } });
    for (const extra of [{ taskIds: [taskId] }, { scope: "ALL" }, { targetPath: "/伪造目标" }, { expected: {} }, { tmdbId: 1.1 }]) expect(() => parseCoreRequest(request("corrections.preview-batch", { ...input, ...extra }))).toThrow();
    expect(parseCoreRequest(request("corrections.scope", { taskId, scope: "SAME_SERIES", page: 2 }))).toMatchObject({ payload: { page: 2 } }); expect(() => parseCoreRequest(request("corrections.scope", { taskId, scope: "SAME_SERIES", path: "/任意目录" }))).toThrow();
    const confirmation = { id: taskId, requestKey, fingerprint: "a".repeat(64), filesComplete: true };
    expect(parseCoreRequest(request("corrections.confirm-batch", confirmation))).toMatchObject({ payload: confirmation });
    for (const extra of [{ fingerprint: "x".repeat(64) }, { filesComplete: false }, { overwrite: true }]) expect(() => parseCoreRequest(request("corrections.confirm-batch", { ...confirmation, ...extra }))).toThrow();
    expect(() => parseCoreRequest(request("corrections.batch", { id: taskId, page: 1000001 }))).toThrow();
  });
  it("季集候选查询只接受应用身份与有界分页，不能传路径、候选或季号冒认分组", () => {
    const sourceId = randomUUID(), id = "a".repeat(64); expect(parseCoreRequest(request("ingestion.seasons", {}))).toMatchObject({ payload: { page: 1 } }); expect(parseCoreRequest(request("ingestion.season", { sourceId, id, page: 2 }))).toMatchObject({ payload: { page: 2 } });
    for (const extra of [{ path: "/任意目录" }, { tmdbId: 7 }, { season: 1 }, { page: 1000001 }]) expect(() => parseCoreRequest(request("ingestion.season", { sourceId, id, ...extra }))).toThrow();
  });
  it("批量整理只接收已有任务、版本与作品选择，明确文件完整才能确认，分页和数量有界", () => {
    const id = randomUUID(), requestKey = randomUUID(), item = { taskId: randomUUID(), expectedRevision: 0, selection: { tmdbId: 7, mediaType: "TV_SHOW", season: 1, episode: 2 } };
    expect(parseCoreRequest(request("ingestion.preview-organize-batch", { requestKey, items: [item] }))).toMatchObject({ payload: { includeAccessories: true } });
    for (const items of [[], Array.from({ length: 101 }, () => item), [{ ...item, sourcePath: "/伪造路径" }], [{ ...item, expectedRevision: -1 }]]) expect(() => parseCoreRequest(request("ingestion.preview-organize-batch", { requestKey, items }))).toThrow();
    for (const proof of [{}, { filesComplete: false }, { filesComplete: true, targetPath: "/伪造目标" }]) expect(() => parseCoreRequest(request("ingestion.confirm-organize-batch", { id, requestKey, ...proof }))).toThrow();
    expect(parseCoreRequest(request("ingestion.confirm-organize-batch", { id, requestKey, filesComplete: true }))).toMatchObject({ payload: { filesComplete: true } });
    expect(() => parseCoreRequest(request("ingestion.organize-batch", { id, page: 1000001 }))).toThrow();
    expect(() => parseCoreRequest(request("ingestion.organize-batch-assets", { id, taskId: "../../文件" }))).toThrow();
  });
  it("内容复核仅接受来源身份与幂等标识，查询有界且不接受路径或摘要注入", () => {
    const sourceId = randomUUID(), requestKey = randomUUID();
    expect(parseCoreRequest(request("ingestion.review-content", { sourceId, requestKey }))).toMatchObject({ payload: { sourceId, requestKey } });
    for (const extra of [{ path: "/任意目录" }, { sha256: "a".repeat(64) }, { automatic: true }]) expect(() => parseCoreRequest(request("ingestion.review-content", { sourceId, requestKey, ...extra }))).toThrow();
    expect(() => parseCoreRequest(request("ingestion.content-review-files", { id: requestKey, page: 1000001 }))).toThrow();
    expect(() => parseCoreRequest(request("ingestion.cancel-content-review", { id: "../../其他作业" }))).toThrow();
  });
  it("目录失败携带受限原因和可信配置引用，跨私有与公开通道保留分类", () => {
    const issue = { reason: "SOURCE_OVERLAP" as const, conflict: { kind: "source" as const, id: randomUUID() } };
    const failure = cloudFailureSchema.parse(JSON.parse(JSON.stringify(cloudFailure(new CloudError("CONFLICT", undefined, issue)))));
    const recreated = new CloudError(failure.code, failure.retryAfterSeconds, failure.directoryIssue);
    expect(rpcErrorSchema.parse(publicError(recreated))).toMatchObject({ code: "CONFLICT", directoryIssue: issue, message: expect.stringContaining(issue.conflict.id) });
    const privateIssue = { reason: "PRIVATE_PATH" as const };
    expect(publicError(new DesktopError("FORBIDDEN", "请选择独立下载目录", false, undefined, privateIssue))).toMatchObject({ code: "FORBIDDEN", directoryIssue: privateIssue });
    expect(directoryIssueSchema.safeParse({ ...issue, path: "/private/secret" }).success).toBe(false);
    expect(directoryIssueSchema.safeParse({ ...issue, conflict: { kind: "source", id: "file:///private/secret" } }).success).toBe(false);
    expect(cloudFailureSchema.safeParse({ ...failure, message: "fixture-cookie /private/path" }).success).toBe(false);
    const unknown = publicError(new CloudError("CONFLICT", undefined, { reason: "OWNERSHIP_MISMATCH" }));
    expect(unknown).not.toHaveProperty("directoryIssue.conflict");
    expect(unknown.message).toContain("不会自动接管");
  });
  it("云端错误经过公开核心通道仍保留固定分类和有界退避", () => {
    expect(rpcErrorSchema.parse(publicError(new CloudError("RATE_LIMITED", 30)))).toEqual({ code: "RATE_LIMITED", message: "网盘请求受到限制，请稍后重试", retryable: true, retryAfterSeconds: 30 });
    expect(publicError(new CloudError("AUTH_REQUIRED"))).toMatchObject({ code: "AUTH_REQUIRED", retryable: false });
    expect(publicError(new Error("fixture-cookie /private/path"))).not.toHaveProperty("message", "fixture-cookie /private/path");
  });
  it("拒绝任意命令、SQL、URL 代理和多余参数", () => {
    for (const action of ["shell.exec", "sql.query", "http.fetch", "__proto__"])
      expect(() => parseCoreRequest(request(action))).toThrow(DesktopError);
    expect(() =>
      parseCoreRequest(
        request("runtime.get", { sql: "DROP TABLE media_task" }),
      ),
    ).toThrow();
  });
  it("协议版本不一致明确报错", () => {
    try {
      parseCoreRequest({ ...request(), protocolVersion: 0 });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "PROTOCOL_MISMATCH" });
    }
  });
  it("限制消息与查询规模", () => {
    expect(() =>
      parseCoreRequest(request("runtime.get", { huge: "x".repeat(65536) })),
    ).toThrow();
    expect(() =>
      parseCoreRequest(request("tasks.list", { page: 1, pageSize: 1000 })),
    ).toThrow();
    expect(
      parseCoreRequest(request("tasks.list", { page: 1, pageSize: 25 })),
    ).toMatchObject({ payload: { page: 1, pageSize: 25 } });
  });
  it("来源只能复制，未知网盘行为不允许自动接入", () => {
    const source = {
      name: "电影",
      kind: "quark",
      sourcePath: "/downloads",
      targetPath: "/media",
      mediaType: "AUTO",
      operation: "COPY",
      automatic: false,
    };
    expect(sourceDraftSchema.safeParse(source).success).toBe(true);
    expect(
      sourceDraftSchema.safeParse({ ...source, operation: "MOVE" }).success,
    ).toBe(false);
    expect(
      sourceDraftSchema.safeParse({ ...source, automatic: true }).success,
    ).toBe(false);
  });
  it("原始内部错误不会泄漏凭据及个人路径", () => {
    const error = publicError(
      new Error("/Users/private/movie.mkv API_KEY=secret"),
    );
    expect(JSON.stringify(error)).not.toMatch(/private|secret/);
  });
});
