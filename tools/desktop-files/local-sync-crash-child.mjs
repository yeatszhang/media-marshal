// 隔离文件和 SQLite 的进程崩溃验收；注入时钟仅用于 Core 检查点准备，不代表客户端完成规则。
import { readFile } from "node:fs/promises";
import { CoreDatabase } from "../../packages/media-core/dist/infrastructure/database.js";
import { CloudRoots } from "../../packages/media-core/dist/cloud/roots.js";
import { ConfigurationDirectories } from "../../packages/media-core/dist/sources/configuration-directories.js";
import { LocalSync } from "../../packages/media-core/dist/sources/local-sync.js";
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
if (!/marshal-local-sync-/.test(config.database)) throw new Error("仅支持隔离同步验收目录");
const database = await CoreDatabase.open(config.database, undefined, { exclusiveOwner: true }), roots = new CloudRoots(database), directories = new ConfigurationDirectories(database, roots);
await directories.authorize(config.input, "ordinary"); await directories.authorize(config.target, "managed");
let clock = 0;
const local = new LocalSync(database, directories, roots, () => Date.UTC(2026, 9, 28) + clock, () => clock);
const hold = async () => { process.stdout.write("CHECKPOINT:" + config.checkpoint + "\n"); await new Promise(() => { setInterval(() => {}, 1000); }); };
const target = roots.files.get(config.target.id), source = directories.reader(config.input.id);
if (config.checkpoint === "planned") await hold();
if (config.checkpoint === "copying") {
  const original = source.digest.bind(source); source.digest = async (handle, size, signal, sink) => original(handle, size, signal, sink ? async (bytes) => { await sink(bytes); await hold(); } : undefined);
}
const commit = target.commit.bind(target);
target.commit = async (...args) => { if (config.checkpoint === "verified") await hold(); const result = await commit(...args); if (config.checkpoint === "published") await hold(); return result; };
const cleanup = target.cleanupAttempt.bind(target);
target.cleanupAttempt = async (...args) => { if (config.checkpoint === "recorded" && database.connection.prepare("SELECT 1 FROM local_sync_operation WHERE phase='RECORDED'").get()) await hold(); return cleanup(...args); };
for (let index = 0; index < 15; index++) { clock += 10000; await local.tick(); }
throw new Error("未到达指定同步检查点");
