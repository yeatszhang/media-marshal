// 共享隔离夹具：只接收已由调用者取得独占锁的测试库及实际授权根，不安装真实凭据。
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OwnedAttemptCleanup } from "../../../../packages/media-core/dist/files/owned-attempt-cleanup.js";
import { DownloadCommits } from "../../../../packages/media-core/dist/cloud/commits.js";
import { downloadFailureColumns } from "../../../../packages/media-core/dist/cloud/download-failures.js";
import { CloudAccounts } from "../../../../packages/media-core/dist/cloud/accounts.js";
export function seedDownloadPlan(
  db,
  roots,
  grant,
  content,
  { blockedTarget = false, filename = "sample.bin" } = {},
) {
  const accounts = new CloudAccounts(db),
    prepared = accounts.dispatch("cloud.authorization.begin", {
      name: "崩溃夹具",
      requestKey: randomUUID(),
      implementationId: "test.crash",
    });
  const capabilities = {
    authorizationMethods: ["cookie"],
    accountIdentity: "unavailable",
    objectIdentity: "path",
    reliableRevision: false,
    hashAlgorithms: ["sha256"],
    rangeRead: "unknown",
    sourceKinds: ["webdav"],
  };
  accounts.dispatch("cloud.authorization.finish", {
    jobId: prepared.job.id,
    failure: null,
    capabilities,
    identityKey: null,
  });
  const binding = prepared.candidate.binding,
    remoteRef = randomUUID(),
    itemId = randomUUID(),
    attemptId = randomUUID(),
    previewId = randomUUID(),
    jobId = randomUUID(),
    now = new Date().toISOString();
  const evidence = {
      kind: "hash",
      algorithm: "sha256",
      value: createHash("sha256").update(content).digest("hex"),
    },
    key = createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    root = roots.files.get(grant.id);
  const item = {
    itemId,
    source: {
      binding: {
        accountId: binding.accountId,
        bindingId: binding.bindingId,
        generation: binding.generation,
      },
      remoteRef,
      locator: { kind: "path", segments: [filename] },
      expectedVersion: evidence,
    },
    expectedSize: content.length,
    targetSegments: [filename],
  };
  const plan = { attemptId, targetGrantId: grant.id, items: [item] },
    snapshot = {
      name: filename,
      complete: true,
      failure: null,
      binding: item.source.binding,
      items: [{ ...item, versionKey: key, targetPathKey: root.slotKey(item.targetSegments) }],
      policy: { maxAttempts: 3, retryBaseMs: 1000 },
    };
  db.connection.transaction(() => {
    db.connection
      .prepare(
        "INSERT INTO remote_entry(id,account_id,name,type,size,version_json,observed_at) VALUES(?,?,?,'file',?,?,?)",
      )
      .run(remoteRef, binding.accountId, filename, content.length, JSON.stringify(evidence), now);
    db.connection
      .prepare(
        "INSERT INTO cloud_preview(id,account_id,remote_root_ref,target_root_id,request_key,snapshot_json,state,configuration_version,created_at,expires_at) VALUES(?,?,?,?,?,?,'CONFIRMED',1,?,?)",
      )
      .run(
        previewId,
        binding.accountId,
        remoteRef,
        grant.id,
        randomUUID(),
        JSON.stringify(snapshot),
        now,
        now,
      );
    db.connection
      .prepare(
        "INSERT INTO download_job(id,account_id,preview_id,request_key,state,configuration_version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)",
      )
      .run(
        jobId,
        binding.accountId,
        previewId,
        randomUUID(),
        blockedTarget ? "BLOCKED_LOCAL" : "RUNNING",
        now,
        now,
      );
    db.connection
      .prepare(
        "INSERT INTO download_item(id,account_id,remote_ref,version_key,version_json,target_root_id,target_path_key,target_segments_json,expected_size,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        itemId,
        binding.accountId,
        remoteRef,
        key,
        JSON.stringify(evidence),
        grant.id,
        root.slotKey(item.targetSegments),
        JSON.stringify(item.targetSegments),
        content.length,
        blockedTarget ? "BLOCKED_LOCAL" : "RUNNING",
        now,
        now,
      );
    db.connection
      .prepare("INSERT INTO download_item_runtime(item_id,attempt_count) VALUES(?,?)")
      .run(itemId, blockedTarget ? 0 : 1);
    db.connection
      .prepare(
        "INSERT INTO download_job_item(job_id,item_id,account_id,demand_state) VALUES(?,?,?,'ACTIVE')",
      )
      .run(jobId, itemId, binding.accountId);
    if (!blockedTarget) {
      db.connection
        .prepare(
          "INSERT INTO download_attempt(id,account_id,binding_id,core_generation,binding_generation,host_generation,idempotency_key,staging_key,state,plan_json,created_at) VALUES(?,?,?,?,?,?,?,?,'CLAIMED',?,?)",
        )
        .run(
          attemptId,
          binding.accountId,
          binding.bindingId,
          randomUUID(),
          binding.generation,
          randomUUID(),
          randomUUID(),
          attemptId,
          JSON.stringify({ plan, policy: snapshot.policy }),
          now,
        );
      db.connection
        .prepare(
          "INSERT INTO download_claim(item_id,attempt_id,account_id,target_root_id,target_path_key,ordinal) VALUES(?,?,?,?,?,0)",
        )
        .run(itemId, attemptId, binding.accountId, grant.id, root.slotKey(item.targetSegments));
      db.connection.prepare("INSERT INTO download_attempt_item VALUES(?,?)").run(attemptId, itemId);
    }
    if (blockedTarget)
      db.connection
        .prepare("UPDATE download_item SET failure_code=?,failure_detail_code=? WHERE id=?")
        .run(...downloadFailureColumns("TARGET_OCCUPIED"), itemId);
  })();
  return {
    binding,
    remoteRef,
    itemId,
    attemptId,
    previewId,
    jobId,
    evidence,
    key,
    root,
    item,
    plan,
    snapshot,
    now,
  };
}

/** 使用生产提交能力生成正式收据；远端 stat 是明确的本地替身。 */
export async function publishDownloadPlan(database, roots, fixture, content) {
  const { root, attemptId, itemId, item, binding, remoteRef, evidence } = fixture;
  const name = item.targetSegments.at(-1),
    stage = await root.prepareStage(attemptId);
  await writeFile(join(stage, name), content, { flag: "wx", mode: 0o600 });
  database.connection
    .prepare(
      "UPDATE download_attempt SET state='EXITED',exit_code=0,stopped_at=?,stop_evidence_json=? WHERE id=?",
    )
    .run(
      new Date().toISOString(),
      JSON.stringify({ kind: "fixture-write-finished", processId: process.pid }),
      attemptId,
    );
  database.connection.prepare("UPDATE download_item SET state='VERIFYING' WHERE id=?").run(itemId);
  const catalog = {
    source: () => item.source,
    stat: async () => ({
      accountId: binding.accountId,
      ref: remoteRef,
      parentRef: null,
      name,
      type: "file",
      size: content.length,
      modifiedAt: null,
      version: evidence,
    }),
  };
  await new DownloadCommits(database, roots, catalog).verifyAndCommit(
    attemptId,
    fixture.plan.targetGrantId,
    item,
  );
  await new OwnedAttemptCleanup(database).run("download_attempt", attemptId, root);
}
