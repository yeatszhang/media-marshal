// 仅供隔离测试：检查点在真实文件 IO 完成后、对应日志更新前等待父进程 SIGKILL。
import { readFile } from "node:fs/promises";
import { CoreDatabase } from "../../packages/media-core/dist/infrastructure/database.js";
import { ManagedRoot, ManagedRoots } from "../../packages/media-core/dist/files/index.js";
import { FileRelocations } from "../../packages/media-core/dist/files/relocations.js";
import { SourceRoot } from "../../packages/media-core/dist/files/source-root.js";
import { loadNativeRename } from "../../packages/media-core/dist/files/native-rename.js";
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const database = await CoreDatabase.open(config.database, undefined, { exclusiveOwner: true }), roots = new ManagedRoots("direct");
let engine;
async function checkpoint(point) {
  if (point !== config.checkpoint) return;
  const keepAlive = setInterval(() => {}, 1000);
  process.stdout.write("CHECKPOINT:" + point + "\n");
  try { await new Promise(() => {}); } finally { clearInterval(keepAlive); }
}
try {
  for (const row of database.connection.prepare("SELECT grant_json FROM media_target_root").all()) await roots.install(JSON.parse(row.grant_json));
  const native = await loadNativeRename(config.native);
  const api = {
    renameBeneath: async (...args) => { const result = await native.renameBeneath(...args); if (result.moved) await checkpoint(args[3][0] === ".media-marshal" ? "isolated" : "moved"); return result; },
    linkBeneath: async (...args) => { const result = await native.linkBeneath(...args); if (result.published) await checkpoint("published"); return result; },
  };
  const digest = SourceRoot.prototype.digest;
  SourceRoot.prototype.digest = function (handle, size, signal, consume) { return digest.call(this, handle, size, signal, async (bytes) => { await consume?.(bytes); await checkpoint("copying"); }); };
  const remove = ManagedRoot.prototype.removeRelocation;
  ManagedRoot.prototype.removeRelocation = async function (...args) { await remove.apply(this, args); await checkpoint("removed"); };
  engine = new FileRelocations(database, roots, api);
  const result = await engine.run(config.id);
  if (result.phase !== "DONE") throw new Error("文件步骤未完成：" + result.phase + "/" + result.failure_code);
  await checkpoint("done");
  throw new Error("未到达指定检查点");
} finally { await engine?.close(); await roots.close(); database.close(); }
