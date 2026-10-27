// 仅测试使用的独立只读 WebDAV；不依赖 OpenList，不注册到生产宿主。
import { createServer } from "node:http";
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export async function testWebDav(files: Map<string, Buffer>, options: { slow?: boolean; failRead?: Set<string> } = {}) {
  const username = "fixture-reader", password = "fixture-read-only-password", authorization = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  const gets: string[] = [], directories = new Set([""]);
  for (const file of files.keys()) { const parts = file.split("/"); for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/")); }
  let started!: () => void; const firstGet = new Promise<void>((resolve) => { started = resolve; });
  const server = createServer((request, response) => {
    if (request.headers.authorization !== authorization) { response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' }).end(); return; }
    let path: string;
    try { path = decodeURIComponent(new URL(request.url!, "http://127.0.0.1").pathname).replace(/^\/dav\/?/, "").replace(/\/$/, ""); } catch { response.writeHead(400).end(); return; }
    const file = files.get(path), directory = directories.has(path);
    if (!file && !directory) { response.writeHead(404).end(); return; }
    if (request.method === "OPTIONS") { response.writeHead(200, { DAV: "1,2", Allow: "OPTIONS, PROPFIND, HEAD, GET" }).end(); return; }
    if (request.method === "PROPFIND") {
      const names = [path];
      if (request.headers.depth !== "0" && directory) for (const name of [...directories, ...files.keys()]) if (name !== path && name.split("/").slice(0, -1).join("/") === path) names.push(name);
      const body = names.map((name) => `<d:response><d:href>/dav/${name.split("/").map(encodeURIComponent).join("/")}${name && directories.has(name) ? "/" : ""}</d:href><d:propstat><d:prop><d:displayname>${xml(name.split("/").at(-1) || "root")}</d:displayname><d:resourcetype>${directories.has(name) ? "<d:collection/>" : ""}</d:resourcetype><d:getcontentlength>${files.get(name)?.length ?? 0}</d:getcontentlength><d:getlastmodified>Sat, 24 Oct 2026 12:00:00 GMT</d:getlastmodified><d:getcontenttype>application/octet-stream</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("");
      response.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" }).end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`); return;
    }
    if (request.method === "HEAD" && file) { response.writeHead(200, { "Content-Length": file.length, "Accept-Ranges": "bytes" }).end(); return; }
    if (request.method !== "GET" || !file) { response.writeHead(405).end(); return; }
    gets.push(path); started();
    if (options.failRead?.has(path)) { response.writeHead(500).end("fixture read failure"); return; }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? ""), start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), file.length - 1) : file.length - 1;
    if (start > end || start >= file.length) { response.writeHead(416).end(); return; }
    response.writeHead(range ? 206 : 200, { "Content-Length": end - start + 1, "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${end}/${file.length}` } : {}) });
    if (!options.slow) { response.end(file.subarray(start, end + 1)); return; }
    let offset = start;
    const write = () => { if (response.destroyed) return; const until = Math.min(offset + 65536, end + 1); response.write(file.subarray(offset, until)); offset = until; if (offset > end) response.end(); else setTimeout(write, 20); };
    write();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/dav/`, username, password, gets, firstGet, async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
