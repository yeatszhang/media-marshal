import { describe, expect, it } from "vitest";
import { defaultDiagnostic } from "./diagnostics";
describe("默认诊断白名单", () => {
  it("忽略账号、Cookie、签名地址和路径，不复制原始异常", () => {
    const text = defaultDiagnostic({ appVersion: "0.1.0", electronVersion: "44.9.0", target: "darwin-arm64", core: "ready", cloud: {
      state: "FAILED", configuredAccounts: 1, lastFailure: "AUTH_REQUIRED", cookie: "fixture-private-cookie", path: "/Users/private", token: "fixture-token", raw_url: "https://example.invalid/?sign=secret",
    } } as any);
    expect(text).not.toMatch(/fixture|Users|private-cookie|https:|raw_url|token/);
    const report = JSON.parse(text);
    expect(report.privateDataIncluded).toBe(false); expect(report.cloud.lastFailure).toBe("AUTH_REQUIRED");
    expect(Object.keys(report.cloud)).toEqual(["state", "configuredAccounts", "lastFailure"]);
  });
  it("不接受用原始错误替代固定错误码", () => {
    expect(() => defaultDiagnostic({ appVersion: "0.1.0", electronVersion: "44.9.0", target: "win32-x64", core: "ready", cloud: { state: "FAILED", configuredAccounts: 1, lastFailure: "/private/error-cookie" } } as any)).toThrow();
  });
});
