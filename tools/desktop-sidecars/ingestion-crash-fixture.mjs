// 仅由真实进程强杀测试加载，不注入产品或访问用户配置。
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
const load = (name) => import(pathToFileURL(resolve("packages/media-core/dist", name)).href);
const { CoreDatabase } = await load("infrastructure/database.js");
const { MediaConnections } = await load("application/media-connections.js");
const { IngestionPipeline } = await load("ingestion/pipeline.js");
const { normalizeParse } = await load("domain/media.js");
const { SourceRoot } = await load("files/source-root.js");
const { publicError } = await import("@media-marshal/contracts");
process.once("message", async (input) => {
  let stage = "初始化";
  try {
    const db = await CoreDatabase.open(join(input.path, "desktop.sqlite3"), undefined, { exclusiveOwner: true });
    const settings = { language: "zh-CN", embyUrl: "", tmdbProxy: "" };
    const connections = new MediaConnections(db, () => settings, { baseUrl: input.tmdbUrl }); connections.install({ tmdb: "fixture-private-tmdb", emby: null });
    let clock = Date.now(), monotonic = 0;
    const parser = { ready: true, parse: async (name) => normalizeParse({ title: "测试电影", year: 2026, type: "movie" }, name) };
    const pipeline = new IngestionPipeline(db, () => parser, connections, () => clock, () => monotonic);
    const sourceId = randomUUID(), sourceFile = join(input.source.path, "测试电影.2026.mp4");
    const bytes = Buffer.from("真实独立进程 COPY 与交付恢复。".repeat(50000)); await writeFile(sourceFile, bytes);
    db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'崩溃恢复','custom',?,?,'MOVIE','COPY',?)").run(sourceId, input.source.path, input.target.path, new Date(clock).toISOString());
    const authorization = { sourceId, sourceVersion: 1, mode: "local", downloadRootId: null, source: input.source, target: input.target };
    stage = "来源授权与首次扫描"; await pipeline.authorize(authorization); await pipeline.scan(sourceId);
    if (input.point === "content-review") {
      stage = "内容复核准备";
      await writeFile(join(input.source.path, "A.mp4"), "首项已复核，来源仍保留"); await pipeline.scan(sourceId);
      let reads = 0, review; const digest = SourceRoot.prototype.digest;
      SourceRoot.prototype.digest = async function (...args) {
        if (++reads === 3) {
          // 第一项两轮摘要及单项事务已完成，第二项保持读取中，由父进程按句柄强杀。
          process.send({ reviewId: review.id, authorization, sourceFile, size: bytes.length }); await new Promise(() => {});
        }
        return digest.apply(this, args);
      };
      stage = "登记内容复核"; review = pipeline.reviewContent({ sourceId, requestKey: randomUUID() }); stage = "等待内容复核边界"; await pipeline.contentReviews.idle(); return;
    }
    for (let index = 0; index < 12; index++) { clock += 10000; monotonic += 10000; await pipeline.scan(sourceId); }
    const candidate = pipeline.list({ sourceId }).items.find((row) => row.state === "READY");
    const task = await pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await pipeline.tick();
    const preview = await pipeline.preview({ taskId: task.taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" } });
    const receipt = () => ({ point: input.point, taskId: task.taskId, sourceId, sourceFile, targetPath: preview.targetPath, size: bytes.length, inode: existsSync(preview.targetPath) ? statSync(preview.targetPath).ino : null, authorization });
    const wait = async () => { process.send(receipt()); await new Promise(() => {}); };
    const target = pipeline.targets.get(input.target.id), commit = target.commit.bind(target);
    if (input.point === "linked") target.commit = async (...args) => { const result = await commit(...args); await wait(); return result; };
    if (input.point === "verified") target.commit = async () => { await wait(); };
    if (input.point === "writing") {
      const digest = SourceRoot.prototype.digest;
      SourceRoot.prototype.digest = function (handle, size, signal, consume) {
        return digest.call(this, handle, size, signal, consume && (async (buffer) => { await consume(buffer); await wait(); }));
      };
    }
    if (input.point === "file-committed") {
      const transaction = db.connection.transaction.bind(db.connection);
      db.connection.transaction = (fn) => {
        const execute = transaction(fn);
        return (...args) => {
          const row = db.connection.prepare("SELECT phase FROM ingestion_operation WHERE task_id=?").get(task.taskId);
          if (row?.phase === "FILE_COMMITTED") {
            // SQL 同步边界不能 await；小型 IPC 回执写入后阻塞到父测试发送 SIGKILL。
            process.send(receipt()); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          }
          return execute(...args);
        };
      };
    }
    if (input.point === "planned") pipeline.tick = async () => {};
    await pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await pipeline.tick();
    if (input.point === "missing-delivery") db.connection.prepare("DELETE FROM emby_delivery WHERE task_id=?").run(task.taskId);
    await wait();
  } catch (error) { process.send({ error: true, stage, failure: publicError(error) }); }
});
