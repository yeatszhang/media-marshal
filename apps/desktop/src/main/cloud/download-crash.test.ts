import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, readFile, rm, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoreDatabase } from "../../../../../packages/media-core/src/infrastructure/database";
import { CloudRoots } from "../../../../../packages/media-core/src/cloud/roots";
import { RemoteCatalog } from "../../../../../packages/media-core/src/cloud/catalog";
import { CloudDownloads } from "../../../../../packages/media-core/src/cloud/downloads";
import { probeManagedVolume } from "./volume-probe";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
describe.skipIf(process.platform !== "darwin")("Core 文件与记账边界真实 SIGKILL", () => {
  // 子进程执行发布用编译输出；避免拿已有 dist 当作当前源码的测试证据。
  beforeAll(async () => { await promisify(execFile)(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "packages/media-core/tsconfig.json"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000, shell: false }); });
  for (const point of ["planned", "writing", "verified", "intent", "linked", "recorded", "foreign-target"]) it(`${point} 强杀后按持久证据恢复`, async () => {
    const path = await realpath(await mkdtemp(join(tmpdir(), "marshal-file-crash-"))); cleanup.push(() => rm(path, { recursive: true, force: true }));
    const target = join(path, "download"); await mkdir(target); const grant = await probeManagedVolume(target);
    const child = fork(resolve("tools/desktop-sidecars/download-crash-fixture.mjs"), [], { execPath: process.execPath, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    child.stdout!.resume(); child.stderr!.resume(); cleanup.push(() => { if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL"); });
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) => child.once("exit", (code, signal) => done({ code, signal })));
    const reached = new Promise<{ itemId: string; attemptId: string; jobId: string; size: number; sha256: string }>((done, fail) => { const timer = setTimeout(() => fail(new Error("未到达崩溃边界")), 10000); child.once("message", (value: any) => { clearTimeout(timer); if (value.error) fail(new Error("崩溃夹具失败")); else done(value); }); child.once("error", fail); });
    child.send({ path, grant, point: point === "foreign-target" ? "linked" : point }); const receipt = await reached;
    child.kill("SIGKILL"); expect(await exited).toEqual({ code: null, signal: "SIGKILL" });
    if (point === "foreign-target") { await unlink(join(target, "completed", "sample.bin")); await writeFile(join(target, "completed", "sample.bin"), "foreign-file"); }
    const db = await CoreDatabase.open(join(path, "desktop.sqlite3")); cleanup.push(() => db.close()); const roots = new CloudRoots(db); cleanup.push(() => roots.close()); await roots.authorize(await probeManagedVolume(target, grant.id));
    let transfers = 0; const host = { context: (bindingGeneration: string, attemptId: string) => ({ coreGeneration: randomUUID(), hostGeneration: randomUUID(), bindingGeneration, attemptId }), request: async () => { transfers++; throw new Error("恢复不能重新下载已提交项"); } };
    const catalog = new RemoteCatalog(db, host, Date.now, () => false), downloads = new CloudDownloads(db, host, catalog, roots); cleanup.push(() => downloads.close());
    // 子进程是该夹具唯一写入者；上方 exit/SIGKILL 回执是实际停止证据。
    downloads.writersReaped(randomUUID()); downloads.start();
    const itemState = () => (db.connection.prepare("SELECT state FROM download_item WHERE id=?").get(receipt.itemId) as { state: string }).state;
    const published = ["intent", "linked", "recorded"].includes(point);
    await expect.poll(itemState, { timeout: 5000 }).toBe(published ? "COMPLETED" : point === "foreign-target" ? "RECONCILING" : "QUEUED");
    expect(transfers).toBe(0); expect(db.connection.prepare("SELECT count(*) AS n FROM download_attempt").get()).toEqual({ n: 1 });
    expect(db.connection.prepare("SELECT count(*) AS n FROM ingestion_outbox").get()).toEqual({ n: published ? 1 : 0 });
    if (published) {
      expect((await readFile(join(target, "completed", "sample.bin"))).length).toBe(receipt.size);
      await expect.poll(() => readdir(join(target, ".media-marshal", "staging"))).toEqual([]);
    } else if (point === "foreign-target") expect(await readFile(join(target, "completed", "sample.bin"), "utf8")).toBe("foreign-file");
    else expect(await readdir(join(target, "completed"))).toEqual([]);
  });
});
