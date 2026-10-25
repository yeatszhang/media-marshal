// 开发验收用独立写入者，只以 wx 抢占指定目标，不覆盖或清理既有文件。
import { open, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";

const [path, encoded] = process.argv.slice(2);
const reply = (value) => { if (process.send) process.send(value, () => process.disconnect()); else console.log(JSON.stringify(value)); };
if (!path || !isAbsolute(path) || !encoded || encoded.length > 65536 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)) throw new Error("目标占用测试需要绝对路径与有界测试内容");
const bytes = Buffer.from(encoded, "base64");
try {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const info = await lstat(path, { bigint: true });
  reply({ state: "CLAIMED", inode: String(info.ino), size: Number(info.size), sha256: createHash("sha256").update(bytes).digest("hex") });
} catch (error) {
  if (error.code === "EEXIST") reply({ state: "OCCUPIED" });
  else { process.exitCode = 1; reply({ state: "FAILED", code: error.code ?? "UNKNOWN" }); }
}
