import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CoreDatabase } from "../infrastructure/database.js";
import { DownloadCleanupJournal, type DownloadCleanupPlan } from "./download-cleanup-journal.js";

const close: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of close.splice(0).reverse()) await dispose();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "marshal-cleanup-journal-"));
  close.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite"),
    database = await CoreDatabase.open(path);
  close.push(() => database.close());
  const side = (name: string) => ({
    grant: {
      id: randomUUID(),
      path: join(directory, name),
      volume: {
        volumeId: randomUUID(),
        rootInode: "1",
        rootBirthtimeNs: "1",
        observedDevice: "1",
        fsTypeCode: "1",
        fsType: "isolated-test",
        caseSensitive: true,
        unicodeEquivalent: false,
        pathMaxBytes: 4096,
      },
    },
    segments: ["completed", "剧集.mp4"],
    evidence: {
      volumeId: "",
      inode: "2",
      birthtimeNs: "3",
      modifiedNs: "4",
      size: 123,
      sha256: "a".repeat(64),
    },
  });
  const source = side("下载"),
    target = side("媒体");
  source.evidence.volumeId = source.grant.volume.volumeId;
  target.evidence.volumeId = target.grant.volume.volumeId;
  const plan: DownloadCleanupPlan = {
    source,
    target,
    binding: "当前绑定快照",
    targetId: target.grant.id,
    connectionId: randomUUID(),
    connectionVersion: 1,
    authorization: "ORGANIZE",
  };
  const receiptId = randomUUID(),
    stamp = new Date().toISOString();
  database.connection
    .prepare(
      "INSERT INTO sync_receipt VALUES(?,'cloud','账户','对象','版本','{}',?,'槽位',?,?,?,?,'download-item',?,'版本')",
    )
    .run(
      receiptId,
      source.grant.id,
      JSON.stringify(source.segments.slice(1)),
      source.evidence.sha256,
      source.evidence.size,
      stamp,
      randomUUID(),
    );
  database.connection
    .prepare("INSERT INTO sync_receipt_evidence VALUES(?,?)")
    .run(receiptId, JSON.stringify(source.evidence));
  return { path, database, receiptId, plan, journal: new DownloadCleanupJournal(database) };
}

describe("受管下载清理持久日志", () => {
  it("相同计划幂等，拒绝换原件、换目标或不一致内容；成功收据不变", async () => {
    const f = await fixture(),
      before = f.database.connection.prepare("SELECT * FROM sync_receipt").get();
    const first = f.journal.create(f.receiptId, null, f.plan);
    expect(f.journal.create(f.receiptId, null, f.plan)).toEqual(first);
    expect(() =>
      f.journal.create(f.receiptId, null, {
        ...f.plan,
        target: { ...f.plan.target, segments: ["其他.mp4"] },
      }),
    ).toThrow();
    expect(() =>
      f.database.connection
        .prepare("UPDATE download_cleanup SET plan_json='{}' WHERE id=?")
        .run(first.id),
    ).toThrow(/不可修改/);
    expect(f.database.connection.prepare("SELECT * FROM sync_receipt").get()).toEqual(before);
    expect(f.database.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({
      n: 0,
    });
    expect(f.database.connection.prepare("SELECT count(*) AS n FROM emby_delivery").get()).toEqual({
      n: 0,
    });
  });
  it("每个不可逆阶段落库；失败重试恢复原阶段，已删除不会退回领取或重复计释放量", async () => {
    const f = await fixture(),
      row = f.journal.create(f.receiptId, null, f.plan);
    f.journal.advance(row.id, "PENDING", "WAITING_REFERENCES", "另一识别规则暂停，仍保留需求");
    f.journal.advance(row.id, "WAITING_REFERENCES", "CLAIMED");
    f.journal.advance(row.id, "CLAIMED", "QUARANTINED");
    f.journal.advance(row.id, "QUARANTINED", "REMOVING");
    f.journal.fail(row.id, "原目标卷失联；恢复原卷后重试");
    f.database.close();
    const reopened = await CoreDatabase.open(f.path);
    close.push(() => reopened.close());
    const journal = new DownloadCleanupJournal(reopened);
    expect(journal.get(row.id)).toMatchObject({
      phase: "NEEDS_ATTENTION",
      resume_phase: "REMOVING",
      claimed: 1,
      freed_bytes: 0,
    });
    journal.retry(row.id);
    journal.advance(row.id, "REMOVING", "SOURCE_REMOVED");
    journal.advance(row.id, "SOURCE_REMOVED", "CACHE_PENDING");
    journal.fail(row.id, "暂存回收失败，请重试");
    expect(journal.describe(journal.get(row.id))).toMatchObject({
      phase: "NEEDS_ATTENTION",
      freedBytes: 123,
    });
    journal.retry(row.id);
    journal.advance(row.id, "CACHE_PENDING", "DONE");
    expect(() => journal.advance(row.id, "REMOVING", "SOURCE_REMOVED")).toThrow();
    expect(() =>
      reopened.connection.prepare("UPDATE download_cleanup SET claimed=0 WHERE id=?").run(row.id),
    ).toThrow();
    expect(journal.get(row.id)).toMatchObject({ phase: "DONE", freed_bytes: 123 });
  });
  it("无同步所有权证据、同大小不同摘要及原卷身份错误均不创建清理记录", async () => {
    const f = await fixture();
    expect(() =>
      f.journal.create(f.receiptId, null, {
        ...f.plan,
        target: {
          ...f.plan.target,
          evidence: { ...f.plan.target.evidence, sha256: "b".repeat(64) },
        },
      }),
    ).toThrow();
    expect(() =>
      f.journal.create(f.receiptId, null, {
        ...f.plan,
        source: { ...f.plan.source, evidence: { ...f.plan.source.evidence, inode: "999" } },
      }),
    ).toThrow();
    f.database.connection.prepare("DELETE FROM sync_receipt_evidence").run();
    expect(() => f.journal.create(f.receiptId, null, f.plan)).toThrow();
    expect(f.journal.list()).toEqual([]);
  });
});
