import { afterEach, describe, expect, it, vi } from "vitest";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, readFile, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ManagedRoot } from "@media-marshal/media-core/files";
import type { LocalFileEvidence } from "@media-marshal/contracts/internal";
import { probeManagedVolume } from "./volume-probe";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function claim(target: string, bytes: Buffer) {
  const child = fork(resolve("tools/desktop-sidecars/claim-commit-target.mjs"), [target, bytes.toString("base64")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  return new Promise<{ state: "CLAIMED" | "OCCUPIED"; inode?: string }>((resolveClaim, reject) => {
    let result: { state: "CLAIMED" | "OCCUPIED"; inode?: string } | undefined;
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); reject(new Error("目标占用测试子进程超时")); }, 5000);
    child.once("message", (value) => { result = value as typeof result; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); if (code !== 0 || !result) reject(new Error("目标占用测试子进程未完成")); else resolveClaim(result); });
  });
}
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "marshal-no-overwrite-"))); cleanup.push(() => rm(path, { recursive: true, force: true }));
  const root = await ManagedRoot.open(await probeManagedVolume(path), "direct"); cleanup.push(() => root.close()); await root.initialize(); await root.verifyCommitSupport();
  const attempt = randomUUID(), segments = ["中文 竞争目标.mp4"], bytes = Buffer.from("已校验但还未发布的完整内容");
  await root.prepareStage(attempt); const stage = await root.stageFilePath(attempt, segments); await writeFile(stage, bytes);
  const evidence = await root.verifyStage(attempt, segments, bytes.length), target = join(path, ...segments); await root.assertVacant(segments);
  return { root, attempt, segments, bytes, stage, evidence, target };
}
describe.runIf(process.platform === "darwin")("真实独立进程抢占正式目标", () => {
  it.each(["内容不同", "内容相同"])("提交已查无目标后，另一进程抢建且%s仍不能覆盖或认领", async (variant) => {
    const f = await fixture(), foreign = variant === "内容相同" ? f.bytes : Buffer.from("其他进程的数据"), hasher = f.root as unknown as { hash(path: string): Promise<LocalFileEvidence> }, hash = hasher.hash.bind(f.root);
    let raced: Awaited<ReturnType<typeof claim>> | undefined, armed = true;
    // commit 已经确认目标不存在，再核验 stage；在这段真实竞争窗口让另一个进程占位。
    vi.spyOn(hasher, "hash").mockImplementation(async (path) => {
      const proof = await hash(path);
      if (armed && path === f.stage) { armed = false; await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" }); raced = await claim(f.target, foreign); expect(raced.state).toBe("CLAIMED"); }
      return proof;
    });
    await expect(f.root.commit(f.attempt, f.segments, f.evidence)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(armed).toBe(false); expect(raced?.state).toBe("CLAIMED");
    expect(String((await lstat(f.target, { bigint: true })).ino)).toBe(raced!.inode); expect((await readFile(f.target)).equals(foreign)).toBe(true);
    expect((await readFile(f.stage)).equals(f.bytes)).toBe(true); await f.root.cleanupAttempt(f.attempt);
    expect((await readFile(f.target)).equals(foreign)).toBe(true);
  });
  it("应用先提交时，其他进程的 wx 抢占失败，清理 stage 不影响正式文件", async () => {
    const f = await fixture(), committed = await f.root.commit(f.attempt, f.segments, f.evidence), racer = await claim(f.target, Buffer.from("其他进程的数据"));
    expect(racer.state).toBe("OCCUPIED"); expect(committed.evidence.inode).toBe(f.evidence.inode);
    await f.root.cleanupAttempt(f.attempt); expect((await readFile(f.target)).equals(f.bytes)).toBe(true);
    expect(String((await lstat(f.target, { bigint: true })).ino)).toBe(f.evidence.inode);
  });
});
