import { afterEach, describe, expect, it } from "vitest";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupFixture } from "./download-cleanup-fixture.js";

const disposals: (() => unknown | Promise<unknown>)[] = [], folders: string[] = [];
afterEach(async () => { for (const close of disposals.splice(0).reverse()) await close(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const fixture = async () => { const f = await cleanupFixture((close) => disposals.push(close)); folders.push(f.folder); return f; };
describe("下载原件清理的完整内容证据", () => {
  it("独立识别逻辑目标复用设置目录的 Emby 绑定，仍核验物理原卷与内容", async () => {
    const f = await fixture(), db = f.database.connection, rule = randomUUID(), logical = randomUUID(), stamp = new Date().toISOString();
    db.prepare("INSERT INTO configuration_directory VALUES(?,1,?,?,'media',NULL,?)").run(f.targetGrant.id, f.targetGrant.path, JSON.stringify(f.targetGrant), stamp);
    db.prepare("INSERT INTO recognition_rule VALUES(?,1,1,0,'{}',0,NULL,'[]',?,?)").run(rule, stamp, stamp);
    db.prepare("INSERT INTO recognition_target_identity VALUES(?,?,?,'TV_SHOW','隔离目标')").run(logical, rule, f.targetGrant.id);
    const plan = await f.verification.prepare(f.receiptId, null, "ORGANIZE", { id: logical, segments: f.targetSegments }); expect(plan.targetId).toBe(logical); await expect(f.verification.verifyTarget(plan)).resolves.toBeUndefined();
  });
  it("从整理目标或已有媒体库副本逐项建立相同内容证明，不依赖文件名或 Emby 索引确认", async () => {
    const f = await fixture();
    const known = await f.verification.prepare(f.receiptId, null, "ORGANIZE", { id: f.targetGrant.id, segments: f.targetSegments });
    const found = await f.verification.prepare(f.receiptId, null, "HISTORICAL_PREVIEW");
    expect(found.target).toEqual(known.target); expect(found.source.evidence.sha256).toBe(found.target.evidence.sha256);
    expect(f.verification.journal.list()).toEqual([]); expect(await readFile(join(f.sourceGrant.path, ...f.sourceSegments))).toEqual(f.bytes);
  });
  it("同字节大小的不同内容不能产生清理证据，人工确认或名字匹配不能替代完整摘要", async () => {
    const f = await fixture(); await writeFile(join(f.targetGrant.path, ...f.targetSegments), Buffer.alloc(f.bytes.length, 42));
    await expect(f.verification.prepare(f.receiptId, null, "HISTORICAL_PREVIEW")).rejects.toThrow();
    await expect(f.verification.prepare(f.receiptId, null, "ORGANIZE", { id: f.targetGrant.id, segments: f.targetSegments })).rejects.toThrow();
    expect(await readFile(join(f.sourceGrant.path, ...f.sourceSegments))).toEqual(f.bytes);
  });
  it("绑定或连接版本改变、原目标卷失联均阻止后续核验，保留原件", async () => {
    const f = await fixture(), plan = await f.verification.prepare(f.receiptId, null, "HISTORICAL_PREVIEW");
    f.database.connection.prepare("UPDATE emby_connection SET version=2").run(); await expect(f.verification.verifyTarget(plan)).rejects.toThrow();
    f.database.connection.prepare("UPDATE emby_connection SET version=1").run();
    await rename(f.targetGrant.path, f.targetGrant.path + "-离线"); await expect(f.verification.verifyTarget(plan)).rejects.toThrow();
    expect(await readFile(join(f.sourceGrant.path, ...f.sourceSegments))).toEqual(f.bytes);
  });
  it("相同内容替换文件、同名替代原卷也不能继承成功收据所有权", async () => {
    const f = await fixture(); await rename(join(f.sourceGrant.path, ...f.sourceSegments), join(f.sourceGrant.path, "保留原件")); await writeFile(join(f.sourceGrant.path, ...f.sourceSegments), f.bytes);
    await expect(f.verification.prepare(f.receiptId, null, "HISTORICAL_PREVIEW")).rejects.toThrow();
    expect(f.verification.journal.list()).toEqual([]);
  });
});
