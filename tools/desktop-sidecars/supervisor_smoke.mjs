import { _electron } from "@playwright/test";
import { build } from "vite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { identify, matches, stopVerified } = createRequire(import.meta.url)("./process-identity.cjs");

const root = resolve(import.meta.dirname, "../..");
const output = join(root, "build-artifacts/desktop-sidecars/supervisor-fixture");
await build({ configFile: false, logLevel: "error", resolve: { alias: [
  { find: "@media-marshal/contracts/internal/core", replacement: join(root, "packages/contracts/src/internal/core.ts") },
  { find: "@media-marshal/contracts/internal/rpc", replacement: join(root, "packages/contracts/src/internal/rpc.ts") },
  { find: "@media-marshal/contracts/internal", replacement: join(root, "packages/contracts/src/internal/index.ts") },
  { find: "@media-marshal/contracts", replacement: join(root, "packages/contracts/src/index.ts") },
] }, build: { ssr: join(import.meta.dirname, "supervisor-main.ts"), outDir: output, emptyOutDir: true, rollupOptions: { external: ["electron"], output: { format: "cjs", entryFileNames: "main.cjs" } } } });

const cases = [];
async function until(test, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await test()) return; await new Promise((resolve) => setTimeout(resolve, 200)); }
  throw new Error(message);
}
for (const kind of ["normal", "core", "host", "openlist", "guardian", "main"]) {
  const directory = await mkdtemp(join(tmpdir(), "marshal-supervisor-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let application, identities = [];
  try {
    application = await _electron.launch({ args: [join(output, "main.cjs"), `--fixture-root=${directory}`], env });
    await until(() => application.evaluate(() => Boolean(globalThis.marshalSupervisorFixture)), "正式监督器未就绪");
    const binding = { accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID(), implementationId: "fixture.not-registered" };
    await application.evaluate((_, value) => globalThis.marshalSupervisorFixture.start(value), binding);
    const pids = await application.evaluate(async () => (await globalThis.marshalSupervisorFixture.native()).map((identity) => identity.pid));
    if (pids.length !== 2) throw new Error("本次真实 Guardian/OpenList 未全部启动");
    identities = pids.map((pid) => identify(pid));
    if (identities.some((identity) => !identity)) throw new Error("真实原生进程过早退出");
    const previous = await application.evaluate(() => globalThis.marshalSupervisorFixture.status().generation);
    if (kind === "main") {
      const mainPid = await application.evaluate(() => process.pid), main = identify(mainPid);
      stopVerified(main, main.command);
    } else {
      if (kind !== "normal") await application.evaluate((_, value) => globalThis.marshalSupervisorFixture.kill(value), kind);
      await application.evaluate(() => globalThis.marshalSupervisorFixture.stop());
    }
    await until(() => identities.every((identity) => !matches(identity, identity.command)), "旧原生进程未确认全部停止");
    let recovered = false;
    if (kind !== "main") {
      await until(() => application.evaluate(() => globalThis.marshalSupervisorFixture.status().core === "ready"), "核心未在旧原生进程停止后恢复");
      await application.evaluate((_, value) => globalThis.marshalSupervisorFixture.start(value), binding);
      recovered = await application.evaluate((_, generation) => globalThis.marshalSupervisorFixture.status().generation !== generation, previous);
      if (!recovered) throw new Error("恢复未撤销旧宿主代际");
      await application.evaluate(() => globalThis.marshalSupervisorFixture.close());
    }
    cases.push({ case: kind, actualProductionSupervisors: true, oldProcessesStopped: true, recoveredWithNewGeneration: recovered });
    console.log(`${process.platform}-${process.arch} 正式进程监管：${kind} 通过`);
  } finally {
    await application?.close().catch(() => {});
    for (const identity of identities) if (identity) stopVerified(identity, identity.command);
    await rm(directory, { recursive: true, force: true });
  }
}
const report = join(root, "test-results/sidecars/supervisor-smoke.json"); await mkdir(resolve(report, ".."), { recursive: true });
await writeFile(report, JSON.stringify({ target: `${process.platform}-${process.arch}`, scope: "正式 Core/SidecarSupervisor/Utility Host/Guardian/OpenList 故障注入；Rclone 写入强杀由 process-smoke 覆盖", cases }, null, 2) + "\n");
