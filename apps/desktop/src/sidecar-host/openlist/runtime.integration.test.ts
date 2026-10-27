import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenListRuntime, unusedPort } from "./runtime";
import { SidecarBinaryResolver, lockedDefinitions, sidecarTarget } from "../binary-resolver";
import { guardianManifestSchema } from "../protocol";
import { OpenListQuarkProvider } from "./provider";
import { SourceCredentialBroker } from "../source-credentials";

const running: OpenListRuntime[] = [], directories: string[] = [], servers: Server[] = [];
async function fixture(port?: () => Promise<number>) {
  const directory = await mkdtemp(join(tmpdir(), "marshal-owned-gateway-")); directories.push(directory);
  const target = sidecarTarget(process.platform, process.arch), resourceRoot = resolve("apps/desktop/resources/sidecars", target);
  const guardian = guardianManifestSchema.parse(JSON.parse(await readFile(join(resourceRoot, "guardian.json"), "utf8")));
  const binaries = await new SidecarBinaryResolver(resourceRoot, target, lockedDefinitions(target, guardian.binary)).resolve();
  const runtime = new OpenListRuntime({ privateRoot: directory, hostGeneration: randomUUID(), binaries, port }); running.push(runtime);
  return { runtime, directory };
}
afterEach(async () => {
  await Promise.allSettled(running.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(servers.splice(0).map((server) => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); }));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
describe.runIf(process.env.MARSHAL_NATIVE_TESTS === "1")("真实受管 OpenList 初始化", () => {
  it.runIf(process.env.MARSHAL_QUARK_INVALID_PROBE === "1")("合成失效 Cookie 在固定普通 Quark 驱动中映射认证失效并清理挂载", async () => {
    const { runtime } = await fixture(); await runtime.start();
    const provider = new OpenListQuarkProvider(runtime, new SourceCredentialBroker());
    await expect(provider.validateCredential({ binding: { accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID() }, cookie: "__pus=invalid; __puus=invalid" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(await runtime.client.api("GET", "/api/admin/storage/list?page=1&per_page=100")).toMatchObject({ total: 0 });
  }, 60000);
  it("私有实例、匿名拒绝与限定范围只读用户均实际生效", async () => {
    const { runtime, directory } = await fixture(); await runtime.start();
    const accountId = randomUUID();
    const [reader, concurrent] = await Promise.all([runtime.readOnlyAccess(accountId), runtime.readOnlyAccess(accountId)]);
    expect(reader).toEqual(concurrent);
    const source = join(directory, "source"); await mkdir(source); await writeFile(join(source, "sample.txt"), "fixture-content");
    await runtime.client.api("POST", "/api/admin/storage/create", { mount_path: reader.mountPath, driver: "Local", addition: JSON.stringify({ root_folder_path: source }), web_proxy: true, webdav_policy: "native_proxy", proxy_range: true, enable_sign: true });
    const auth = `Basic ${Buffer.from(`${reader.username}:${reader.password}`).toString("base64")}`;
    expect((await runtime.client.raw("GET", "/dav/sample.txt")).status).toBe(401);
    expect((await runtime.client.raw("GET", "/dav/sample.txt", undefined, auth)).bytes.toString()).toBe("fixture-content");
    expect((await runtime.client.raw("PUT", "/dav/forbidden.txt", undefined, auth)).status).toBe(403);
    await expect(stat(join(source, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60000);
  it("端口被其他实例占用时停止旧尝试，再选择新端口", async () => {
    const foreign = createServer((_request, response) => { response.end("foreign"); }); servers.push(foreign);
    await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    const occupied = (foreign.address() as { port: number }).port;
    let selections = 0;
    const { runtime } = await fixture(async () => ++selections === 1 ? occupied : unusedPort());
    await runtime.start(); expect(selections).toBe(2); expect(runtime.client.port).not.toBe(occupied);
  }, 60000);
  it("连续启动失败只尝试三次，失败后关闭受管进程且不能继续使用客户端", async () => {
    const foreign = createServer((_request, response) => response.end("foreign")); servers.push(foreign);
    await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    const occupied = (foreign.address() as { port: number }).port;
    let selections = 0;
    const { runtime } = await fixture(async () => { selections++; return occupied; });
    await expect(runtime.start()).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
    expect(selections).toBe(3);
    expect(() => runtime.client).toThrow();
    await expect(runtime.start()).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
  }, 60000);
});
