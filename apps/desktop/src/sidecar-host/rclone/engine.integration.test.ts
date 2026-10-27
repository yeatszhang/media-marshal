import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, readFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { PrivateTransferPlan, TransferEvent } from "@media-marshal/contracts/internal";
import { SidecarBinaryResolver, lockedDefinitions, sidecarTarget } from "../binary-resolver";
import { guardianManifestSchema } from "../protocol";
import { ManagedGuardian } from "../guardian";
import { SourceCredentialBroker } from "../source-credentials";
import { testWebDav } from "../testing/webdav";
import { RcloneCliEngine } from "./engine";
import { FakeDriveProvider } from "../testing/fakes";
import { createSidecarApplication } from "../application";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(names: string[], options: { slow?: boolean; failRead?: Set<string> } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-rclone-engine-"))); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const files = new Map(names.map((name) => [name, options.slow ? Buffer.alloc(4 * 1024 * 1024, 65) : Buffer.from("测试字节:" + name)]));
  const server = await testWebDav(files, options); cleanups.push(() => server.close());
  const target = sidecarTarget(process.platform, process.arch), resource = resolve("apps/desktop/resources/sidecars", target), manifest = guardianManifestSchema.parse(JSON.parse(await readFile(join(resource, "guardian.json"), "utf8")));
  const binaries = await new SidecarBinaryResolver(resource, target, lockedDefinitions(target, manifest.binary)).resolve();
  const guardian = new ManagedGuardian(directory, binaries); await guardian.launch(); cleanups.push(() => guardian.shutdown());
  const broker = new SourceCredentialBroker(), engine = new RcloneCliEngine(guardian, broker, join(directory, "configuration")); cleanups.push(() => engine.dispose());
  const binding = { accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID() }, attemptId = randomUUID(), staging = join(directory, "staging"); await mkdir(staging);
  const items = names.map((name) => ({ itemId: randomUUID(), source: { binding, remoteRef: randomUUID(), locator: { kind: "stable-id" as const, objectKey: "opaque-business-object" }, expectedVersion: null }, targetSegments: name.split("/"), expectedSize: files.get(name)!.length }));
  const input: PrivateTransferPlan = { plan: { attemptId, targetGrantId: randomUUID(), items }, context: { attemptId, coreGeneration: randomUUID(), hostGeneration: randomUUID(), bindingGeneration: binding.generation }, stagingDirectory: staging, sources: items.map((item, index) => ({ itemId: item.itemId, lease: { leaseId: randomUUID(), generation: binding.generation, kind: "webdav", endpoint: server.endpoint, root: "/", credentialHandle: broker.issue(binding, server), file: { remoteRef: item.source.remoteRef, segments: names[index]!.split("/") } } })) };
  return { engine, guardian, broker, server, input, directory, files };
}
describe.runIf(process.env.MARSHAL_NATIVE_TESTS === "1")("真实 Rclone Engine 与独立 WebDAV", () => {
  it("批次非零退出保留完整项，失败条目不伪装为成功，也不转发原始错误", async () => {
    const f = await fixture(["good.txt", "failed.txt"], { failRead: new Set(["failed.txt"]) }), handle = await f.engine.start(f.input), events: TransferEvent[] = [];
    for await (const event of f.engine.events(handle)) events.push(event);
    await f.engine.stop(handle);
    expect(events.at(-1)).toMatchObject({ type: "exited", stopped: false }); expect((events.at(-1) as { exitCode: number }).exitCode).not.toBe(0);
    expect(events.some((event) => event.type === "failure")).toBe(true);
    expect(await readFile(join(f.input.stagingDirectory, "good.txt"))).toEqual(f.files.get("good.txt"));
    await expect(stat(join(f.input.stagingDirectory, "failed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(events)).not.toMatch(/fixture read failure|failed.txt|password/);
  }, 60000);
  it("正式宿主的 start/status 与账号静止窗口等待真实 Rclone 退出及租约释放", async () => {
    const f = await fixture(["host-transfer.bin"], { slow: true }), provider = new FakeDriveProvider();
    provider.acquireSource = async () => { provider.acquired++; return f.input.sources[0]!.lease; };
    provider.releaseSource = async () => { provider.released++; f.broker.release(f.input.sources[0]!.lease.credentialHandle); };
    const binding = { ...f.input.plan.items[0]!.source.binding, implementationId: provider.implementationId };
    const app = createSidecarApplication({ hostGeneration: f.input.context.hostGeneration, coreGeneration: f.input.context.coreGeneration, bindings: [binding], providers: [provider], engines: [f.engine], resolver: { resolve: async () => ({ guardian: "/fixture", openlist: "/fixture", rclone: "/fixture" }) }, staging: async (plan) => { if (plan.targetGrantId !== f.input.plan.targetGrantId) throw new Error("未授权受管根"); return f.input.stagingDirectory; } });
    await app.app.start(); cleanups.push(() => app.stop());
    const response = await app.dispatch({ kind: "host.request", protocolVersion: 1, action: "transfer.start", requestId: randomUUID(), idempotencyKey: randomUUID(), context: f.input.context, payload: f.input.plan });
    expect(response.ok).toBe(true); await f.server.firstGet;
    await app.quiesceAccount(binding.accountId);
    const status = await app.dispatch({ kind: "host.request", protocolVersion: 1, action: "transfer.status", requestId: randomUUID(), idempotencyKey: randomUUID(), context: f.input.context, payload: { attemptId: f.input.plan.attemptId } });
    expect(status).toMatchObject({ ok: true, result: { state: "STOPPED" } }); expect(provider.released).toBe(1);
    expect(() => f.broker.read(f.input.sources[0]!.lease.credentialHandle, binding.generation)).toThrow();
  }, 60000);
  it("在途快照隔离输入修改，重复意图不重放，已有暂存内容不能被覆盖", async () => {
    const f = await fixture(["immutable.txt"]), original = structuredClone(f.input), running = f.engine.start(f.input);
    f.input.plan.items[0]!.targetSegments[0] = "changed.txt";
    const handle = await running; for await (const _ of f.engine.events(handle)) {} await f.engine.stop(handle);
    expect(await f.engine.start(original)).toEqual(handle);
    expect(await readFile(join(original.stagingDirectory, "immutable.txt"))).toEqual(f.files.get("immutable.txt"));
    await expect(f.engine.start(f.input)).rejects.toMatchObject({ code: "CONFLICT" });
    const attemptId = randomUUID(); await expect(f.engine.start({ ...original, plan: { ...original.plan, attemptId }, context: { ...original.context, attemptId } })).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
  }, 60000);
  it("中文、空格、前导选项与过滤字符均按精确文件传输，业务 stable-id 不参与读取路径", async () => {
    const names = ["中文 空格.txt", "--config.txt", "[literal]#?.txt"], f = await fixture(names), handle = await f.engine.start(f.input), events: TransferEvent[] = [];
    for await (const event of f.engine.events(handle)) events.push(event);
    await f.engine.stop(handle);
    expect(events.at(-1)).toEqual({ type: "exited", exitCode: 0, stopped: false });
    for (const name of names) expect(await readFile(join(f.input.stagingDirectory, name))).toEqual(f.files.get(name));
    expect(await readdir(join(f.directory, "configuration"))).toEqual([]);
    expect(JSON.stringify(events)).not.toMatch(/fixture-read-only|dav|中文|literal|password|credential/);
  }, 60000);
  it.runIf(process.platform !== "win32")("换行名称使用单文件 copyto，不能进入清单表达式", async () => {
    const name = "换行\n文件.txt", f = await fixture([name]), handle = await f.engine.start(f.input);
    for await (const _ of f.engine.events(handle)) {}
    await f.engine.stop(handle); expect(await readFile(join(f.input.stagingDirectory, name))).toEqual(f.files.get(name));
  }, 60000);
  it("停止确认后才能创建新 attempt，旧结果与凭据不会成为另一个写入者", async () => {
    const f = await fixture(["large.bin"], { slow: true }), handle = await f.engine.start(f.input);
    await f.server.firstGet;
    const privateDirectories = await readdir(join(f.directory, "configuration"));
    const configuration = join(f.directory, "configuration", privateDirectories[0]!, "rclone.conf");
    expect(await readFile(configuration, "utf8")).not.toContain(f.server.password);
    if (process.platform !== "win32") expect((await stat(configuration)).mode & 0o077).toBe(0);
    await f.engine.stop(handle);
    const events: TransferEvent[] = []; for await (const event of f.engine.events(handle)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "exited", stopped: true });
    await expect(f.engine.stop({ ...handle, hostGeneration: randomUUID() })).rejects.toMatchObject({ code: "INTERRUPTED" });
    const second = join(f.directory, "second"); await mkdir(second);
    const attemptId = randomUUID(), next = { ...f.input, stagingDirectory: second, plan: { ...f.input.plan, attemptId }, context: { ...f.input.context, attemptId } };
    const restarted = await f.engine.start(next); for await (const _ of f.engine.events(restarted)) {} await f.engine.stop(restarted);
    expect(await readFile(join(second, "large.bin"))).toEqual(f.files.get("large.bin"));
  }, 60000);
});
