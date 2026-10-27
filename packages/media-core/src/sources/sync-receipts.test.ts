import { afterEach, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase } from "../infrastructure/database.js";
import { ManagedRoot } from "../files/index.js";
import { SyncReceipts } from "./sync-receipts.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture() {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "marshal-sync-receipts-"))); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const rootPath = join(folder, "下载目录"); await mkdir(rootPath); await mkdir(join(rootPath, "completed")); const file = join(rootPath, "completed/文件.mkv"); await writeFile(file, "first");
  const info = await lstat(rootPath, { bigint: true }), fs = await statfs(rootPath, { bigint: true });
  const root = await ManagedRoot.open({ id: randomUUID(), path: rootPath, volume: { volumeId: randomUUID(), rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "isolated-test", caseSensitive: false, unicodeEquivalent: true, pathMaxBytes: 4096 } }); cleanup.push(() => root.close());
  const db = await CoreDatabase.open(join(folder, "desktop.sqlite3")); cleanup.push(() => db.close()); const receipts = new SyncReceipts(db), evidence = await root.inspectCompleted(["文件.mkv"]);
  const version = { kind: "weak" as const, size: 5, modifiedAt: null };
  const input = { source_kind: "local" as const, source_namespace: randomUUID(), source_object_key: "文件.mkv", source_version_key: hash(version), version_json: JSON.stringify(version), target_directory_id: root.grant.id, target_slot: root.slotKey(["文件.mkv"]), target_segments_json: '["文件.mkv"]', result_kind: "local-sync" as const, result_id: randomUUID(), request_variant: "", completed_at: new Date().toISOString() };
  return { folder, db, root, rootPath, file, receipts, input, evidence, version };
}
describe("成功同步事实与本地现状分离", () => {
  it("同一完成结果只记一次，文件删除只更新观测，不删除或改写成功记录", async () => {
    const f = await fixture(), receipt = f.receipts.record(f.input, f.evidence); expect(f.receipts.record(f.input, f.evidence).id).toBe(receipt.id);
    expect(await f.receipts.observe(receipt, f.root)).toBe("PRESENT"); await rm(f.file); expect(await f.receipts.observe(receipt, f.root)).toBe("REMOVED");
    expect(f.receipts.get(receipt.id)).toEqual(receipt); expect(f.db.connection.prepare("SELECT count(*) AS n FROM sync_receipt").get()).toEqual({ n: 1 });
    expect(() => f.db.connection.prepare("UPDATE sync_receipt SET size=1").run()).toThrow(/不可修改/);
  });
  it("共享需求不包含来源配置身份，弱时间变化仍复用，强版本变化及其他目标不会复用", async () => {
    const f = await fixture(), receipt = f.receipts.record(f.input, f.evidence);
    const lookup = (version = f.version, slot = f.input.target_slot) => f.receipts.find("local", f.input.source_namespace, f.input.source_object_key, version, f.root.grant.id, slot);
    expect(lookup()?.id).toBe(receipt.id); expect(lookup({ ...f.version, modifiedAt: "2026-10-27T00:00:00.000Z" } as typeof f.version)?.id).toBe(receipt.id);
    expect(lookup({ ...f.version, size: 6 })).toBeUndefined(); expect(lookup(f.version, "另一个槽位")).toBeUndefined();
    expect(f.receipts.find("local", f.input.source_namespace, f.input.source_object_key, { kind: "revision", revisionKey: "new-version" }, f.root.grant.id, f.input.target_slot)).toBeUndefined();
  });
  it("原根暂时离线不记删除，恢复原根后重新核对，本地改动或同内容替换均冲突", async () => {
    const f = await fixture(), receipt = f.receipts.record(f.input, f.evidence); await rename(f.rootPath, f.rootPath + "-offline");
    expect(await f.receipts.observe(receipt, f.root)).toBe("UNAVAILABLE"); await rename(f.rootPath + "-offline", f.rootPath); expect(await f.receipts.observe(receipt, f.root)).toBe("PRESENT");
    await writeFile(f.file, "other"); expect(await f.receipts.observe(receipt, f.root)).toBe("CONFLICT");
    await rm(f.file); await writeFile(f.file, "first"); expect(await f.receipts.observe(receipt, f.root)).toBe("CONFLICT");
    await expect(lstat(f.file)).resolves.toBeDefined();
  });
  it("成功收据及文件证据在同一事务中提交，故障不留下半条记录；同结果不能换目标或文件身份", async () => {
    const f = await fixture(); f.db.connection.exec("CREATE TRIGGER receipt_fault BEFORE INSERT ON sync_receipt_evidence BEGIN SELECT RAISE(ABORT,'收据故障'); END");
    expect(() => f.receipts.record(f.input, f.evidence)).toThrow("收据故障"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM sync_receipt").get()).toEqual({ n: 0 });
    f.db.connection.exec("DROP TRIGGER receipt_fault"); f.receipts.record(f.input, f.evidence);
    expect(() => f.receipts.record({ ...f.input, target_slot: "其他目标" }, f.evidence)).toThrow(); expect(() => f.receipts.record(f.input, { ...f.evidence, inode: "999999" })).toThrow();
  });
});
