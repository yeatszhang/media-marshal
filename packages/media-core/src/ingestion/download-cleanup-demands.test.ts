import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanupFixture } from "./download-cleanup-fixture.js";
import { DownloadCleanupDemands } from "./download-cleanup-demands.js";

const disposals: (() => unknown | Promise<unknown>)[] = [],
  folders: string[] = [];
afterEach(async () => {
  for (const close of disposals.splice(0).reverse()) await close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function fixture(withTask = false) {
  const f = await cleanupFixture((close) => disposals.push(close));
  folders.push(f.folder);
  const operation = withTask ? f.organized() : null;
  const plan = await f.verification.prepare(
      f.receiptId,
      operation?.taskId ?? null,
      "HISTORICAL_PREVIEW",
    ),
    journal = f.verification.journal,
    row = journal.create(f.receiptId, operation?.taskId ?? null, plan),
    demands = new DownloadCleanupDemands(journal),
    db = f.database.connection;
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO configuration_directory VALUES(?,1,?,?,'managed',NULL,?)").run(
    f.sourceGrant.id,
    f.sourceGrant.path,
    JSON.stringify(f.sourceGrant),
    stamp,
  );
  function consumer(paused: boolean) {
    const source = randomUUID(),
      rule = randomUUID();
    db.prepare(
      "INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'隔离输入','custom',?,?,'AUTO','COPY',?)",
    ).run(source, source, f.targetGrant.path, stamp);
    db.prepare("INSERT INTO ingestion_source VALUES(?,'local',NULL,?,NULL,1,1)").run(
      source,
      JSON.stringify(f.sourceGrant),
    );
    db.prepare("INSERT INTO recognition_rule VALUES(?,1,1,0,'{}',?,NULL,'[]',?,?)").run(
      rule,
      Number(paused),
      stamp,
      stamp,
    );
    db.prepare("INSERT INTO recognition_input VALUES(?,?,?,'managed-completed',1)").run(
      source,
      rule,
      f.sourceGrant.id,
    );
    function candidate(state: string) {
      const id = randomUUID(),
        evidence = plan.source.evidence;
      db.prepare(
        "INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,snapshot_json,state,is_current,created_at,updated_at) VALUES(?,?,?,'v1',?,?,1,?,?)",
      ).run(
        id,
        source,
        JSON.stringify(f.sourceSegments),
        JSON.stringify({ inode: evidence.inode, birthtimeNs: evidence.birthtimeNs }),
        state,
        stamp,
        stamp,
      );
      return id;
    }
    return { source, rule, candidate };
  }
  return { ...f, plan, row, demands, journal, db, consumer, operation };
}
describe("清理领取与共享需求边界", () => {
  it("暂停规则和同一原件的其他规则仍保留需求，最后一个消费者完成才允许领取", async () => {
    const f = await fixture(),
      a = f.consumer(false),
      b = f.consumer(true),
      first = a.candidate("PROCESSED"),
      second = b.candidate("READY");
    expect(f.demands.claim(f.row.id)).toMatchObject({ phase: "WAITING_REFERENCES", claimed: 0 });
    expect(await readFile(join(f.sourceGrant.path, ...f.sourceSegments))).toEqual(f.bytes);
    f.db.prepare("UPDATE ingestion_candidate SET state='PROCESSED' WHERE id=?").run(second);
    expect(f.demands.claim(f.row.id)).toMatchObject({ phase: "CLAIMED", claimed: 1 });
    expect(() =>
      f.db.prepare("UPDATE ingestion_candidate SET state='READY' WHERE id=?").run(first),
    ).toThrow(/领取清理/);
    expect(() => a.candidate("READY")).toThrow(/领取清理/);
  });
  it("尚未产生候选的暂停输入阻止清理；显式停用输入释放需求", async () => {
    const f = await fixture(),
      consumer = f.consumer(true);
    expect(f.demands.claim(f.row.id)).toMatchObject({
      phase: "WAITING_REFERENCES",
      waiting_reason: expect.stringContaining("尚未处理"),
    });
    consumer.candidate("READY");
    f.db.prepare("UPDATE recognition_input SET active=0 WHERE source_id=?").run(consumer.source);
    expect(f.demands.claim(f.row.id)).toMatchObject({ phase: "CLAIMED" });
  });
  it("同一物理下载的多个同步作业，暂停作业仍保留需求，全部完成后才领取", async () => {
    const f = await fixture(),
      db = f.db,
      account = randomUUID(),
      remote = randomUUID(),
      preview = randomUUID(),
      stamp = new Date().toISOString(),
      item = (
        db.prepare("SELECT result_id FROM sync_receipt WHERE id=?").get(f.receiptId) as {
          result_id: string;
        }
      ).result_id;
    db.prepare(
      "INSERT INTO cloud_account(id,name,provider_kind,status,created_at,updated_at) VALUES(?,'隔离账号','quark','DISCONNECTED',?,?)",
    ).run(account, stamp, stamp);
    db.prepare(
      "INSERT INTO remote_entry(id,account_id,name,type,size,observed_at) VALUES(?,?,'01.mp4','file',?,?)",
    ).run(remote, account, f.bytes.length, stamp);
    db.prepare(
      "INSERT INTO cloud_preview(id,account_id,remote_root_ref,target_root_id,request_key,snapshot_json,state,configuration_version,created_at,expires_at) VALUES(?,?,?,?,?,'{}','CONFIRMED',1,?,?)",
    ).run(preview, account, remote, f.sourceGrant.id, randomUUID(), stamp, stamp);
    db.prepare(
      "INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,target_root_id,target_path_key,target_segments_json,expected_size,state,local_sha256,completed_size,created_at,updated_at) VALUES(?,?,?,?,'{}',?,'slot',?,?,'COMPLETED',?,?,?,?)",
    ).run(
      item,
      account,
      remote,
      "a".repeat(64),
      f.sourceGrant.id,
      JSON.stringify(f.sourceSegments.slice(1)),
      f.bytes.length,
      f.plan.source.evidence.sha256,
      f.bytes.length,
      stamp,
      stamp,
    );
    const jobs = [randomUUID(), randomUUID()];
    for (let i = 0; i < jobs.length; i++) {
      db.prepare(
        "INSERT INTO download_job(id,account_id,preview_id,request_key,state,configuration_version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)",
      ).run(jobs[i], account, preview, randomUUID(), i ? "PAUSED" : "COMPLETED", stamp, stamp);
      db.prepare("INSERT INTO download_job_item VALUES(?,?,?,'ACTIVE')").run(
        jobs[i],
        item,
        account,
      );
    }
    expect(f.demands.claim(f.row.id)).toMatchObject({
      phase: "WAITING_REFERENCES",
      waiting_reason: expect.stringContaining("暂停作业"),
    });
    expect(await readFile(join(f.sourceGrant.path, ...f.sourceSegments))).toEqual(f.bytes);
    db.prepare("UPDATE download_job SET state='COMPLETED' WHERE id=?").run(jobs[1]);
    expect(f.demands.claim(f.row.id).phase).toBe("CLAIMED");
  });
  it("修正核验持久需求先于清理领取，领取之后阻断新修正消费者", async () => {
    const f = await fixture(true),
      preparation = randomUUID(),
      stamp = new Date().toISOString();
    const currentTask = randomUUID();
    f.db
      .prepare(
        "INSERT INTO media_task(id,source_id,source_path,status,target_path,created_at,updated_at) VALUES(?,?,?,'DONE',?,?,?)",
      )
      .run(
        currentTask,
        f.operation!.sourceId,
        "隔离修正历史",
        join(f.targetGrant.path, ...f.targetSegments),
        stamp,
        stamp,
      );
    const insert = f.db.prepare(
      "INSERT INTO media_correction_preparation(id,task_id,kind,input_hash,input_json,state,created_at,updated_at) VALUES(?,?,'PREVIEW','隔离摘要','{}','PENDING',?,?)",
    );
    insert.run(preparation, currentTask, stamp, stamp);
    expect(f.demands.claim(f.row.id)).toMatchObject({
      phase: "WAITING_REFERENCES",
      waiting_reason: expect.stringContaining("修正仍在核验"),
    });
    f.db
      .prepare("UPDATE media_correction_preparation SET state='CANCELED' WHERE id=?")
      .run(preparation);
    expect(f.demands.claim(f.row.id).phase).toBe("CLAIMED");
    expect(() => insert.run(randomUUID(), currentTask, stamp, stamp)).toThrow(/正在核验并清理/);
  });
});
