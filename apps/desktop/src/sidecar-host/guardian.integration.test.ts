import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ManagedGuardian } from "./guardian";
import { NativeProcessOwnership, SystemProcessInspector } from "../main/cloud/process-ownership";
import { SidecarBinaryResolver, lockedDefinitions, sidecarTarget } from "./binary-resolver";
import { guardianManifestSchema } from "./protocol";
import { ensurePrivateDirectory } from "../main/cloud/private-files";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "marshal-runtime-writer-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const target = sidecarTarget(process.platform, process.arch), resources = resolve("apps/desktop/resources/sidecars", target);
  const manifest = guardianManifestSchema.parse(JSON.parse(await readFile(join(resources, "guardian.json"), "utf8")));
  const binaries = await new SidecarBinaryResolver(resources, target, lockedDefinitions(target, manifest.binary)).resolve();
  const session = join(directory, "sessions", randomUUID()); await ensurePrivateDirectory(session);
  const guardian = new ManagedGuardian(session, binaries);
  const owner = new NativeProcessOwnership(directory, binaries);
  cleanup.push(async () => { await guardian.shutdown().catch(() => {}); await owner.reap(); });
  const source = join(directory, "source"), staging = join(directory, "staging"); await mkdir(source); await mkdir(staging);
  const file = await open(join(source, "fixture.bin"), "wx"); await file.truncate(64 * 1024 * 1024); await file.close();
  const config = join(session, "rclone.conf"); await writeFile(config, "", { mode: 0o600 });
  const execution = await guardian.start("rclone", randomUUID(), ["copy", source, staging, "--config", config, "--bwlimit", "4M", "--local-no-clone", "--transfers", "1", "--use-json-log", "--stats", "100ms"]);
  const deadline = Date.now() + 15000;
  let writing = false;
  while (Date.now() < deadline) {
    for (const name of await readdir(staging)) if ((await stat(join(staging, name))).size > 0) writing = true;
    if (writing) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(writing).toBe(true); return { guardian, owner, execution, directory, session };
}
describe.runIf(process.env.MARSHAL_NATIVE_TESTS === "1")("正式 Guardian 的真实写入者回收", () => {
  it("Rclone 被强杀是异常退出，不能当作用户暂停或文件完成", async () => {
    const { execution, owner } = await fixture();
    const inspector = new SystemProcessInspector(), identity = await inspector.identify(execution.pid!);
    expect(identity).toBeTruthy(); await inspector.kill(identity!);
    const exit = await execution.exited; expect(exit.stopped).toBe(false); expect(exit.code).not.toBe(0);
    await owner.reap();
  }, 60000);
  it("Guardian 被强杀后由 OS 身份回收残留写入者，再允许清理配置", async () => {
    const { owner, session } = await fixture();
    const inspector = new SystemProcessInspector();
    const processes = await inspector.candidates(session);
    const guardian = processes.find((identity) => identity.command.includes("--runtime-root="));
    expect(guardian).toBeTruthy(); await inspector.kill(guardian!);
    await owner.reap(); expect(await inspector.candidates(session)).toHaveLength(0);
  }, 60000);
});
