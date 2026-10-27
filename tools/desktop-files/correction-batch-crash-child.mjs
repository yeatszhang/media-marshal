// 仅供隔离验收：批次已经确认，子进程不读取下载来源或重新生成用户确认。
import { readFile } from "node:fs/promises";
import { CoreDatabase } from "../../packages/media-core/dist/infrastructure/database.js";
import { MediaConnections } from "../../packages/media-core/dist/application/media-connections.js";
import { IngestionPipeline } from "../../packages/media-core/dist/ingestion/pipeline.js";
import { Corrections } from "../../packages/media-core/dist/ingestion/corrections.js";
import { loadNativeRename } from "../../packages/media-core/dist/files/native-rename.js";
const config = JSON.parse(await readFile(process.argv[2], "utf8")), database = await CoreDatabase.open(config.database, undefined, { exclusiveOwner: true });
const connections = new MediaConnections(database, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" }));
const pipeline = new IngestionPipeline(database, () => undefined, connections); let corrections;
async function checkpoint(point) {
  if (point !== config.checkpoint) return;
  const keepAlive = setInterval(() => {}, 1000); process.stdout.write("CHECKPOINT:" + point + "\n");
  try { await new Promise(() => {}); } finally { clearInterval(keepAlive); }
}
try {
  for (const row of database.connection.prepare("SELECT grant_json FROM media_target_root").all()) await pipeline.authorizeTarget(JSON.parse(row.grant_json));
  corrections = new Corrections(database, pipeline, connections, await loadNativeRename(config.native));
  let recorded = 0; const record = corrections.record;
  corrections.record = async function (row) {
    if (recorded === 1) await checkpoint("before-second-history");
    await record.call(this, row); recorded++;
    if (recorded === 1) await checkpoint("after-first-history");
  };
  for (let round = 0; round < 100; round++) {
    await corrections.tick(); const current = corrections.batches.get(config.id);
    if (current.state === "PARTIAL_FAILED") throw new Error("批次出现待处理文件，未到达指定检查点");
    if (current.state === "DONE") break;
  }
  throw new Error("未到达指定检查点");
} finally { await corrections?.close(); await pipeline.close(); connections.close(); database.close(); }
