import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { assetPath, requireEmbyItemUrl, requireTrustedRequest, trustedFrame } from "./security";
describe("页面权限与本地协议", () => {
  it("Emby 条目页限定配置的 HTTP(S) 服务器和精确子路径，拒绝秘密和额外路由", () => {
    for (const base of ["http://127.0.0.1:8096", "https://emby.example/emby", "https://emby.example/emby/"]) {
      const path = base.replace(/\/$/, "") + "/web/index.html#!/item?id=media-1&serverId=server-1";
      expect(requireEmbyItemUrl(path, base).href).toBe(path);
      for (const invalid of [
        "javascript:alert(1)", "file:///tmp/web/index.html#!/item?id=1&serverId=1", path.replace("id=media-1", "id=media-1&api_key=secret"),
        path.replace("/web/", "/other/web/"), path.replace("#!/item", "?api_key=secret#!/item"), path.replace("#!/item", "#!/login"),
        path.replace("http://", "http://user:secret@"), "https://another.example/web/index.html#!/item?id=1&serverId=1",
      ].filter((value) => value !== path)) expect(() => requireEmbyItemUrl(invalid, base)).toThrow();
    }
  });
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
