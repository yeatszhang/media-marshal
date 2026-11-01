import { seedDownloadPlan } from "../../apps/desktop/tests/support/download-plan.mjs";
// 真实独立进程的 SQL/文件崩溃边界；不注册到产品、不连接云账号。
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const load = (name) => import(pathToFileURL(resolve("packages/media-core/dist", name)).href);
const { CoreDatabase } = await load("infrastructure/database.js"), { CloudRoots } = await load("cloud/roots.js"), { DownloadCommits } = await load("cloud/commits.js");
const content = Buffer.from("独立进程真实文件：下载、校验、提交与崩溃记账。".repeat(100));
process.once("message", async (input) => {
  try {
    const db = await CoreDatabase.open(join(input.path, "desktop.sqlite3"), undefined, { exclusiveOwner: true }), roots = new CloudRoots(db); await roots.authorize(input.grant);
    const { binding, remoteRef, itemId, attemptId, previewId, jobId, evidence, key, root, item, plan, snapshot, now } = seedDownloadPlan(db, roots, input.grant, content);
    const checkpoint = async (point) => { if (point === input.point) { process.send({ point, itemId, attemptId, jobId, size: content.length, sha256: evidence.value }); await new Promise(() => {}); } };
    await checkpoint("planned");
    const stage = await root.prepareStage(attemptId); await writeFile(join(stage, "sample.bin"), content.subarray(0, 10));
    db.connection.prepare("UPDATE download_attempt SET state='RUNNING' WHERE id=?").run(attemptId); await checkpoint("writing");
    await writeFile(join(stage, "sample.bin"), content);
    db.connection.prepare("UPDATE download_attempt SET state='EXITED',exit_code=0,stopped_at=?,stop_evidence_json=? WHERE id=?").run(now, JSON.stringify({ kind: "fixture-write-finished", processId: process.pid }), attemptId);
    db.connection.prepare("UPDATE download_item SET state='VERIFYING' WHERE id=?").run(itemId);
    const catalog = { source: () => item.source, stat: async () => ({ accountId: binding.accountId, ref: remoteRef, parentRef: null, name: "sample.bin", type: "file", size: content.length, modifiedAt: null, version: evidence }) };
    await new DownloadCommits(db, roots, catalog, checkpoint).verifyAndCommit(attemptId, input.grant.id, item);
    process.send({ error: true });
  } catch { process.send({ error: true }); }
});
