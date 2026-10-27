// 仅用于测试：不恢复下载来源或安装凭据，确认后的修正只能沿媒体目标计划推进。
import { readFile } from "node:fs/promises";
import { CoreDatabase } from "../../packages/media-core/dist/infrastructure/database.js";
import { MediaConnections } from "../../packages/media-core/dist/application/media-connections.js";
import { IngestionPipeline } from "../../packages/media-core/dist/ingestion/pipeline.js";
import { Corrections } from "../../packages/media-core/dist/ingestion/corrections.js";
import { loadNativeRename } from "../../packages/media-core/dist/files/native-rename.js";
const config = JSON.parse(await readFile(process.argv[2], "utf8")), database = await CoreDatabase.open(config.database, undefined, { exclusiveOwner: true });
const connections = new MediaConnections(database, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" }));
const pipeline = new IngestionPipeline(database, () => undefined, connections); let corrections;
async function checkpoint(point) { if (point !== config.checkpoint) return; const keepAlive = setInterval(() => {}, 1000); process.stdout.write("CHECKPOINT:" + point + "\n"); try { await new Promise(() => {}); } finally { clearInterval(keepAlive); } }
try {
  for (const row of database.connection.prepare("SELECT grant_json FROM media_target_root").all()) await pipeline.authorizeTarget(JSON.parse(row.grant_json));
  corrections = new Corrections(database, pipeline, connections, await loadNativeRename(config.native));
  const record = corrections.record;
  corrections.record = async function (row) { await checkpoint("before-history"); await record.call(this, row); await checkpoint("after-history"); };
  for (let round = 0; round < 100; round++) { await corrections.tick(); const current = corrections.details({ id: config.id }).operation; if (current.state === "NEEDS_ATTENTION") throw new Error("修正作业需要核对，未到达指定检查点"); if (current.state === "RECORDED") break; }
  throw new Error("未到达指定检查点");
} finally { await corrections?.close(); await pipeline.close(); connections.close(); database.close(); }
