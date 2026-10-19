import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  DesktopError,
  PROTOCOL_VERSION,
  parseCoreRequest,
  publicError,
  sourceDraftSchema,
} from "./index";
const request = (action = "runtime.get", payload: unknown = {}) => ({
  kind: "request",
  protocolVersion: PROTOCOL_VERSION,
  requestId: randomUUID(),
  action,
  payload,
});
describe("受限进程契约", () => {
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
