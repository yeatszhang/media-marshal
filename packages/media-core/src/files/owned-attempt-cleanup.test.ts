import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupFixture } from "../ingestion/download-cleanup-fixture.js";
import { ManagedRoot } from "./index.js";
import { OwnedAttemptCleanup } from "./owned-attempt-cleanup.js";

const disposals: (() => unknown | Promise<unknown>)[] = [], folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of disposals.splice(0).reverse()) await close(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture() {
  const f = await cleanupFixture((close) => disposals.push(close)); folders.push(f.folder); const operation = f.organized(), root = await ManagedRoot.open(f.targetGrant, "direct"); disposals.push(() => root.close());
  const path = await root.prepareStage(operation.attemptId); await writeFile(join(path, "本次暂存"), "恢复锚点"); const owner = new OwnedAttemptCleanup(f.database); return { ...f, operation, root, path, owner };
}
it("整理恢复证据未落库不回收；暂存失败持久可查，重试只删除所属 attempt", async () => {
  const f = await fixture(), db = f.database.connection;
  db.prepare("UPDATE ingestion_operation SET phase='FILE_COMMITTED' WHERE id=?").run(f.operation.operationId);
  expect(() => f.owner.record("ingestion_operation", f.operation.operationId, f.operation.attemptId, f.targetGrant)).toThrow(/恢复证据/);
  expect(await readFile(join(f.path, "本次暂存"), "utf8")).toBe("恢复锚点");
  db.prepare("UPDATE ingestion_operation SET phase='RECORDED' WHERE id=?").run(f.operation.operationId);
  f.owner.record("ingestion_operation", f.operation.operationId, f.operation.attemptId, f.targetGrant);
  vi.spyOn(f.root, "cleanupAttempt").mockRejectedValueOnce(Object.assign(new Error("隔离权限故障"), { code: "EACCES" })); await f.owner.run("ingestion_operation", f.operation.operationId, f.root);
  expect(db.prepare("SELECT state,failure FROM owned_attempt_cleanup").get()).toMatchObject({ state: "NEEDS_ATTENTION", failure: expect.stringContaining(f.operation.attemptId) });
  expect(db.prepare("SELECT status FROM media_task").get()).toEqual({ status: "DONE" });
  await f.owner.run("ingestion_operation", f.operation.operationId, f.root); expect(db.prepare("SELECT state FROM owned_attempt_cleanup").get()).toEqual({ state: "DONE" });
  await expect(readFile(join(f.path, "本次暂存"))).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(join(f.sourceGrant.path, ...f.sourceSegments))).toEqual(f.bytes);
});
it("缺盘和所有权标记丢失时保留暂存，不把未知目录当垃圾", async () => {
  const f = await fixture(); f.owner.record("ingestion_operation", f.operation.operationId, f.operation.attemptId, f.targetGrant);
  f.database.connection.prepare("UPDATE media_target_root SET available=0 WHERE id=?").run(f.targetGrant.id); await f.owner.run("ingestion_operation", f.operation.operationId, f.root); expect(f.database.connection.prepare("SELECT state FROM owned_attempt_cleanup").get()).toEqual({ state: "PENDING" }); expect(await readFile(join(f.path, "本次暂存"), "utf8")).toBe("恢复锚点");
  f.database.connection.prepare("UPDATE media_target_root SET available=1 WHERE id=?").run(f.targetGrant.id);
  await rename(f.targetGrant.path, f.targetGrant.path + "-离线"); await f.owner.run("ingestion_operation", f.operation.operationId, f.root); expect(f.database.connection.prepare("SELECT state FROM owned_attempt_cleanup").get()).toEqual({ state: "PENDING" });
  await rename(f.targetGrant.path + "-离线", f.targetGrant.path);
  await rm(join(f.targetGrant.path, ".media-marshal", "attempts", f.operation.attemptId + ".json")); await f.owner.run("ingestion_operation", f.operation.operationId, f.root);
  expect(f.database.connection.prepare("SELECT state,failure FROM owned_attempt_cleanup").get()).toMatchObject({ state: "NEEDS_ATTENTION", failure: expect.stringContaining("缺少可靠所有权标记") });
  expect(await readFile(join(f.path, "本次暂存"), "utf8")).toBe("恢复锚点");
});
it("未知或尚未停止的下载写入者不能回收暂存，即使持有一个清理业务记录", async () => {
  const f = await fixture(), attemptId = randomUUID(), stage = await f.source.prepareStage(attemptId); await writeFile(join(stage, "原下载暂存"), "仍被写入者持有");
  f.owner.recordDownload(attemptId, f.sourceGrant.id); await f.owner.run("download_attempt", attemptId, f.source);
  expect(f.database.connection.prepare("SELECT state,failure FROM owned_attempt_cleanup").get()).toMatchObject({ state: "NEEDS_ATTENTION", failure: expect.stringContaining("写入者或恢复消费者尚未释放") });
  expect(await readFile(join(stage, "原下载暂存"), "utf8")).toBe("仍被写入者持有");
});
