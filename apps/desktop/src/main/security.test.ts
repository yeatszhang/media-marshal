import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { assetPath, requireTrustedRequest, trustedFrame } from "./security";
describe("页面权限与本地协议", () => {
  it("仅信任自身顶层页面，开发源需显式指定", () => {
    expect(trustedFrame("marshal://app/index.html", true)).toBe(true);
    expect(trustedFrame("marshal://evil/index.html", true)).toBe(false);
    expect(trustedFrame("marshal://app/index.html", false)).toBe(false);
    expect(trustedFrame("https://example.com", true)).toBe(false);
    expect(trustedFrame("http://localhost:5173", true)).toBe(false);
    expect(
      trustedFrame("http://localhost:5173", true, "http://localhost:5173"),
    ).toBe(true);
  });
  it("拒绝本地文件源、跨域请求、超限消息和编码后的路径越界", () => {
    expect(() =>
      requireTrustedRequest({}, "file:///tmp/index.html", true),
    ).toThrow();
    expect(() =>
      requireTrustedRequest({ data: "x".repeat(65536) }, "marshal://app", true),
    ).toThrow();
    const root = resolve(tmpdir(), "app", "renderer");
    expect(() => assetPath(root, "marshal://app/%2f..%2fsecrets")).toThrow();
    expect(assetPath(root, "marshal://app/assets/index.js")).toBe(
      join(root, "assets", "index.js"),
    );
  });
});
