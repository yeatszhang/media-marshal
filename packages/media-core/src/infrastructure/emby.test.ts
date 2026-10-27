import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EmbyClient } from "./emby";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } });
describe("Emby 分页完整性", () => {
  it.each(["重复成员", "总数变化", "缺失中间页", "超出总数"])("视频分页出现%s时拒绝部分成功", async (failure) => {
    const starts: number[] = [];
    const server = createServer((req, res) => {
      expect(req.headers["x-emby-token"]).toBe("fixture-private-key");
      const url = new URL(req.url!, "http://localhost"), start = Number(url.searchParams.get("StartIndex")); starts.push(start);
      expect(url.searchParams.get("ParentId")).toBe("selected-library");
      const items = Array.from({ length: start === 0 ? 200 : failure === "缺失中间页" ? 0 : 1 }, (_, index) => ({ Id: String(start + index) }));
      if (start > 0 && failure === "重复成员") items[0]!.Id = "0";
      res.end(JSON.stringify({ Items: items, TotalRecordCount: start > 0 && failure === "总数变化" ? 202 : failure === "超出总数" ? 199 : 201 }));
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new EmbyClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "fixture-private-key");
    await expect(client.items("selected-library")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(starts).toEqual(failure === "超出总数" ? [0] : [0, 200]);
  });
  it("身份读取的重定向不会转发密钥或访问新的服务器", async () => {
    let redirected = 0;
    const target = createServer((_req, res) => { redirected++; res.end("{}"); });
    servers.push(target); await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const server = createServer((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/secret` }).end(); });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new EmbyClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "fixture-private-key");
    await expect(client.info()).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(redirected).toBe(0);
  });
});
