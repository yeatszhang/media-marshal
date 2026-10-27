// 仅给测试客户端注入局部代理；转发原有链路，不解密 TLS、不记录请求头或地址。
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
export async function networkFaultProxy() {
  const value = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  const upstream = value ? new URL(value) : null;
  if (upstream && !["http:", "https:"].includes(upstream.protocol)) throw new Error("测试代理不支持该上游协议");
  const authorization = upstream?.username ? "Basic " + Buffer.from(decodeURIComponent(upstream.username) + ":" + decodeURIComponent(upstream.password)).toString("base64") : null;
  let unavailable = false; const sockets = new Set();
  const track = (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {}); return socket; };
  const server = http.createServer((request, response) => {
    if (unavailable) { request.socket.destroy(); return; }
    let url; try { url = new URL(request.url); } catch { response.writeHead(400).end(); return; }
    if (!["http:", "https:"].includes(url.protocol)) { response.writeHead(400).end(); return; }
    const headers = { ...request.headers }; delete headers["proxy-authorization"];
    if (authorization) headers["proxy-authorization"] = authorization;
    const transport = (upstream?.protocol ?? url.protocol) === "https:" ? https : http;
    const outgoing = transport.request(upstream ?? url, { method: request.method, path: upstream ? url.href : url.pathname + url.search, headers }, (incoming) => { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response); });
    outgoing.on("socket", track); outgoing.on("error", () => response.destroy()); request.pipe(outgoing);
  });
  server.on("connection", (socket) => { track(socket); if (unavailable) socket.destroy(); });
  server.on("connect", (request, client, head) => {
    if (unavailable) { client.destroy(); return; }
    let destination; try { destination = new URL("https://" + request.url); if (destination.username || destination.password || destination.pathname !== "/") throw new Error(); } catch { client.destroy(); return; }
    const host = upstream?.hostname ?? destination.hostname, port = Number(upstream?.port || (upstream ? upstream.protocol === "https:" ? 443 : 80 : destination.port || 443));
    const peer = track(upstream?.protocol === "https:" ? tls.connect({ host, port, servername: host }) : net.connect({ host, port }));
    const close = () => { peer.destroy(); client.destroy(); }; peer.on("error", close); client.on("error", close); client.once("close", () => peer.destroy());
    const tunnel = (rest = Buffer.alloc(0)) => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (rest.length) client.write(rest); if (head.length) peer.write(head); client.pipe(peer); peer.pipe(client); };
    peer.once(upstream?.protocol === "https:" ? "secureConnect" : "connect", () => {
      if (unavailable) { close(); return; }
      if (!upstream) { tunnel(); return; }
      peer.write(`CONNECT ${request.url} HTTP/1.1\r\nHost: ${request.url}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n`);
      let pending = Buffer.alloc(0);
      const read = (chunk) => {
        pending = Buffer.concat([pending, chunk]); if (pending.length > 65536) { close(); return; }
        const end = pending.indexOf("\r\n\r\n"); if (end < 0) return; peer.off("data", read);
        if (!/^HTTP\/1\.[01] 200 /.test(pending.toString("ascii", 0, end))) { close(); return; } tunnel(pending.subarray(end + 4));
      }; peer.on("data", read);
    });
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  return { url: "http://127.0.0.1:" + server.address().port, cut() { unavailable = true; for (const socket of sockets) socket.destroy(); }, restore() { unavailable = false; }, close() { unavailable = true; for (const socket of sockets) socket.destroy(); return new Promise((done) => server.close(done)); } };
}
