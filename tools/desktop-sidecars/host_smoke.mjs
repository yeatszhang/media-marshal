import { _electron } from "@playwright/test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const root = resolve(import.meta.dirname, "../..");
const target = `${process.platform}-${process.arch}`;
const resources = join(root, "apps/desktop/resources/sidecars", target);
const guardian = JSON.parse(await readFile(join(resources, "guardian.json"), "utf8"));
const directory = await mkdtemp(join(tmpdir(), "marshal-host-smoke-"));
let app;
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: [join(import.meta.dirname, "host-main.cjs"), `--fixture-root=${directory}`], env });
  const encryption = await app.evaluate(async ({ safeStorage }) => {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error("系统凭据保护不可用");
    const fixture = "media-marshal-safe-storage-fixture";
    const encrypted = await safeStorage.encryptStringAsync(fixture);
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    if (decrypted.result !== fixture || encrypted.includes(Buffer.from(fixture))) throw new Error("系统凭据保护往返失败");
    return { available: true, roundTrip: true, plaintextAbsent: true };
  });
  const result = await app.evaluate(async ({ utilityProcess, MessageChannelMain }, options) => {
    const child = utilityProcess.fork(options.worker, [], { stdio: "pipe", serviceName: "Sidecar Host 验收" });
    child.stdout?.on("data", () => {}); child.stderr?.on("data", () => {});
    const { port1, port2 } = new MessageChannelMain();
    let ready = false, denied = false, stopped = false, credentialInjected = false, credentialDropped = false, privateReplies = true;
    return await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { child.kill(); reject(new Error("真实 Host 验收超时")); }, 45000);
      const heartbeat = setInterval(() => port1.postMessage({ kind: "sidecar.heartbeat" }), 250);
      port1.on("message", ({ data }) => {
        if (data?.kind === "sidecar.ready") {
          ready = true;
          port1.postMessage({ kind: "sidecar.credential.install", requestId: options.credentialRequestId, binding: options.binding, secret: "fixture-private-cookie" });
        }
        if (data?.kind === "sidecar.credential.result") {
          privateReplies &&= !JSON.stringify(data).includes("fixture-private-cookie");
          if (data.requestId === options.dropRequestId) { credentialDropped = data.ok === true; port1.postMessage({ kind: "sidecar.shutdown" }); return; }
          if (data.requestId !== options.credentialRequestId) return;
          credentialInjected = data.ok === true;
          port1.postMessage({ kind: "host.request", protocolVersion: 1, requestId: options.requestId, idempotencyKey: options.requestKey, context: { coreGeneration: options.coreGeneration, hostGeneration: options.hostGeneration, bindingGeneration: options.binding.generation, attemptId: options.attemptId }, action: "provider.capabilities", payload: { accountId: options.binding.accountId, bindingId: options.binding.bindingId, generation: options.binding.generation } });
        }
        if (data?.kind === "host.response" && data.requestId === options.requestId) {
          denied = data.ok === false && data.error?.code === "UNSUPPORTED_CAPABILITY";
          privateReplies &&= !JSON.stringify(data).includes("fixture-private-cookie");
          port1.postMessage({ kind: "sidecar.credential.drop", requestId: options.dropRequestId, accountId: options.binding.accountId });
        }
        if (data?.kind === "sidecar.stopped") stopped = data.stopped === true;
        if (data?.kind === "sidecar.failed") { clearTimeout(deadline); clearInterval(heartbeat); child.kill(); reject(new Error("真实 Host 初始化失败")); }
      });
      port1.start();
      child.once("spawn", () => child.postMessage({ kind: "sidecar.initialize", protocolVersion: 1, coreGeneration: options.coreGeneration, hostGeneration: options.hostGeneration, resourceRoot: options.resources, privateRoot: options.privateRoot, guardian: options.guardian, bindings: [options.binding] }, [port2]));
      child.once("exit", (code) => {
        clearTimeout(deadline); clearInterval(heartbeat); port1.close();
        if (!ready || !denied || !stopped || !credentialInjected || !credentialDropped || !privateReplies || code !== 0) reject(new Error("真实 Host 生命周期或受限 RPC 未通过"));
        else resolve({ ready, unknownProviderRejected: denied, credentialInjected, credentialDropped, secretAbsentFromResponses: privateReplies, stopped, exitCode: code });
      });
    });
  }, {
    worker: join(root, "apps/desktop/out/main/sidecar-host.js"), resources, guardian, privateRoot: directory,
    coreGeneration: randomUUID(), hostGeneration: randomUUID(), requestId: randomUUID(), requestKey: randomUUID(), attemptId: randomUUID(), credentialRequestId: randomUUID(), dropRequestId: randomUUID(),
    binding: { accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID(), implementationId: "not.registered" },
  });
  const output = join(root, "test-results/sidecars/host-smoke.json");
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify({ target, scope: "真实生产 Utility Host、系统 safeStorage、固定二进制核验、受管 Guardian/OpenList、私有凭据注入/解除、受限 RPC 和干净停止；不连接网盘", encryption, result }, null, 2) + "\n");
  console.log(`${target} 真实 SidecarHost：资源核验、受限 RPC 和正常停止通过`);
} finally {
  await app?.close().catch(() => {});
  await rm(directory, { force: true, recursive: true });
}
