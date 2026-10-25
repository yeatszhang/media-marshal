// 官方客户端磁盘行为的只读观察工具；记录留在显式指定的本机私有目录。
import { watch } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const [rootArgument, reportArgument] = process.argv.slice(2);
if (!rootArgument || !reportArgument || !isAbsolute(rootArgument) || !isAbsolute(reportArgument)) throw new Error("请指定下载目录和私有报告绝对路径");
const root = await realpath(rootArgument), original = new Set(await readdir(root)), report = resolve(reportArgument);
const outside = (path) => { const inside = relative(root, path); if (!inside || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(".." + sep))) throw new Error("私有报告必须放在观察目录之外，避免报告写入触发自身观察"); };
// 报告父目录可能尚不存在，创建前先解析最近的既有祖先，避免经软链接写入观察根。
let parent = dirname(report), resolvedParent; const missing = [];
for (;;) {
  try { resolvedParent = join(await realpath(parent), ...missing); break; }
  catch (error) { if (error.code !== "ENOENT" || dirname(parent) === parent) throw error; missing.unshift(basename(parent)); parent = dirname(parent); }
}
outside(resolvedParent); await mkdir(resolvedParent, { recursive: true, mode: 0o700 });
const reportParent = await realpath(resolvedParent); outside(reportParent);
const output = await open(join(reportParent, basename(report)), "wx", 0o600), candidates = new Set(), previous = new Map(), pending = new Map();
let writing = Promise.resolve(), closing = false, records = 0, writeFailed = false, stopFlight, deadline;
function record(value) {
  if (records++ >= 20000) return;
  writing = writing.then(async () => { if (!writeFailed) await output.write(JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n"); }).catch(() => { writeFailed = true; process.exitCode = 1; });
}
async function sample(relative, event) {
  try {
    const info = await lstat(join(root, relative));
    const state = { path: relative, exists: true, file: info.isFile(), directory: info.isDirectory(), symlink: info.isSymbolicLink(), size: info.size, blocks: info.blocks, inode: info.ino, modifiedMs: info.mtimeMs };
    const key = JSON.stringify(state); if (previous.get(relative) !== key) { previous.set(relative, key); record({ event, ...state }); }
  } catch (error) {
    if (error.code === "ENOENT") { if (previous.get(relative) !== "missing") { previous.set(relative, "missing"); record({ event, path: relative, exists: false }); } }
    else record({ event: "stat-error", code: error.code });
  }
}
function observe(relative, event) {
  if (closing || pending.has(relative)) return;
  const flight = sample(relative, event).finally(() => pending.delete(relative)); pending.set(relative, flight);
}
const watcher = watch(root, { recursive: true }, (event, filename) => {
  if (!filename || closing) return;
  const relative = normalize(filename.toString()), top = relative.split(sep)[0];
  if (isAbsolute(relative) || relative === ".." || relative.startsWith(".." + sep)) return;
  // 既有用户下载不进入报告；只看新目录／文件、指定样本和夸克临时命名空间。
  if (original.has(top) && top !== "01.mp4" && !/^\.?quark/i.test(top)) return;
  if (!candidates.has(relative)) { if (candidates.size >= 128) return; candidates.add(relative); }
  observe(relative, event);
});
const timer = setInterval(() => { for (const relative of candidates) observe(relative, "sample"); }, 100);
function stop() {
  return stopFlight ??= (async () => {
    closing = true; watcher.close(); clearInterval(timer); clearTimeout(deadline);
    // 先等待在途 stat，再做最终采样，不能关闭报告后收到迟到写入。
    await Promise.allSettled(pending.values());
    for (const relative of candidates) await sample(relative, "final");
    record({ event: "stop", candidates: candidates.size }); await writing; await output.close();
    if (writeFailed) console.error("私有观察报告写入失败，请检查报告目录空间与权限");
  })().catch(() => { process.exitCode = 1; console.error("观察结束时未能完整保存报告，请检查私有报告"); });
}
deadline = setTimeout(() => { void stop(); }, 15 * 60 * 1000);
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
watcher.once("error", (error) => { process.exitCode = 1; record({ event: "watch-error", code: error.code }); void stop(); });
record({ event: "start", samplingMs: 100 }); console.log(JSON.stringify({ ready: true, privateReport: report }));
