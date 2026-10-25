import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, lstat, unlink, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrivateCoreInput } from "@media-marshal/contracts/internal/core";
import { CoreDatabase } from "../../../../../packages/media-core/src/infrastructure/database";
import { MediaConnections } from "../../../../../packages/media-core/src/application/media-connections";
import { IngestionPipeline } from "../../../../../packages/media-core/src/ingestion/pipeline";
import { EmbyDelivery } from "../../../../../packages/media-core/src/ingestion/emby-delivery";
import { SourceRoot } from "../../../../../packages/media-core/src/files/source-root";
import { probeManagedVolume, probeReadOnlyVolume } from "./volume-probe";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
describe.skipIf(process.platform !== "darwin")("整理与交付记账真实 SIGKILL", () => {
  beforeAll(async () => { await promisify(execFile)(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "packages/media-core/tsconfig.json"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000, shell: false }); });
  it.each(["planned", "writing", "verified", "linked", "file-committed", "recorded", "missing-delivery", "foreign-target"])("%s 边界强杀后按持久证据恢复或保留冲突", async (point) => {
    const path = await realpath(await mkdtemp(join(tmpdir(), "marshal-ingestion-crash-"))); cleanup.push(() => rm(path, { recursive: true, force: true }));
    const sourcePath = join(path, "来源"), targetPath = join(path, "媒体库"); await mkdir(sourcePath); await mkdir(targetPath);
    const source = await probeReadOnlyVolume(sourcePath), target = await probeManagedVolume(targetPath);
    const server = createServer((req, res) => { const url = new URL(req.url!, "http://localhost"); const movie = { id: 1, title: "测试电影", original_title: "Test Movie", release_date: "2026-01-01" }; res.end(JSON.stringify(url.pathname.startsWith("/search/") ? { results: [movie] } : movie)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const child = fork(resolve("tools/desktop-sidecars/ingestion-crash-fixture.mjs"), [], { execPath: process.execPath, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    child.stdout!.resume(); child.stderr!.resume();
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) => child.once("exit", (code, signal) => done({ code, signal })));
    cleanup.push(async () => { if (child.exitCode === null && !child.signalCode) { child.kill("SIGKILL"); await exited; } });
    const reached = new Promise<{ taskId: string; targetPath: string; sourceFile: string; inode: number | null; size: number; authorization: PrivateCoreInput<"media.sources.authorize"> }>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("整理未到达预定崩溃边界")), 10000);
      child.once("message", (value: any) => { clearTimeout(timer); if (value.error) fail(new Error("整理崩溃夹具失败")); else done(value); });
      child.once("error", (error) => { clearTimeout(timer); fail(error); });
    });
    child.send({ path, source, target, point: point === "foreign-target" ? "linked" : point, tmdbUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` });
    const receipt = await reached; child.kill("SIGKILL"); expect(await exited).toEqual({ code: null, signal: "SIGKILL" });
    const db = await CoreDatabase.open(join(path, "desktop.sqlite3"), undefined, { exclusiveOwner: true }); cleanup.push(() => db.close());
    const phase = db.connection.prepare("SELECT phase FROM ingestion_operation").get();
    expect(phase).toEqual({ phase: point === "planned" ? "PLANNED" : point === "writing" ? "COPYING" : ["verified", "linked", "foreign-target"].includes(point) ? "VERIFIED" : point === "file-committed" ? "FILE_COMMITTED" : "RECORDED" });
    if (point === "foreign-target") { await unlink(receipt.targetPath); await writeFile(receipt.targetPath, "foreign-target", { flag: "wx" }); }
    const foreignStage = join(targetPath, ".media-marshal", "staging", "foreign-operation"); await mkdir(foreignStage); await writeFile(join(foreignStage, "retained.bin"), "foreign-stage");
    const connections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" })); connections.install({ tmdb: null, emby: null }); cleanup.push(() => connections.close());
    let clock = Date.now(), monotonic = 0;
    const pipeline = new IngestionPipeline(db, () => undefined, connections, () => clock, () => monotonic); cleanup.push(() => pipeline.close()); await pipeline.authorize(receipt.authorization);
    const reads = vi.spyOn(SourceRoot.prototype, "digest");
    if (!["planned", "writing"].includes(point)) reads.mockRejectedValue(new Error("已校验恢复不能再次读取来源"));
    const delivery = new EmbyDelivery(db, connections, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" }), pipeline); cleanup.push(() => delivery.close());
    await pipeline.tick(); await pipeline.tick();
    if (["planned", "writing"].includes(point)) {
      await expect(lstat(receipt.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      for (let index = 0; index < 12; index++) { clock += 10000; monotonic += 10000; await pipeline.scan(receipt.authorization.sourceId); }
      await pipeline.tick(); expect(reads).toHaveBeenCalled();
    } else expect(reads).not.toHaveBeenCalled();
    expect(await readFile(join(foreignStage, "retained.bin"), "utf8")).toBe("foreign-stage");
    if (point === "foreign-target") {
      expect(await readFile(receipt.targetPath, "utf8")).toBe("foreign-target");
      expect(db.connection.prepare("SELECT phase FROM ingestion_operation").get()).toEqual({ phase: "NEEDS_ATTENTION" });
      expect(db.connection.prepare("SELECT count(*) AS n FROM emby_delivery").get()).toEqual({ n: 0 });
      expect((await readFile(receipt.sourceFile)).length).toBe(receipt.size); return;
    }
    if (receipt.inode !== null) expect((await lstat(receipt.targetPath)).ino).toBe(receipt.inode);
    expect(await readFile(receipt.targetPath)).toEqual(await readFile(receipt.sourceFile));
    expect(db.connection.prepare("SELECT status,delivery_status FROM media_task").get()).toEqual({ status: "DONE", delivery_status: "REFRESH_PENDING" });
    expect(db.connection.prepare("SELECT phase FROM ingestion_operation").all()).toEqual([{ phase: "RECORDED" }]);
    expect(db.connection.prepare("SELECT task_id,state FROM emby_delivery").all()).toEqual([{ task_id: receipt.taskId, state: "REFRESH_PENDING" }]);
    expect(await readdir(join(targetPath, ".media-marshal", "staging"))).toEqual(["foreign-operation"]);
  });
});
