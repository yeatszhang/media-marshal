// 构建机使用固定 Python 环境；安装后的 App 不执行这个脚本。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
export async function prepareParser(target = `${process.platform}-${process.arch}`) {
  const root = resolve(import.meta.dirname, "../.."), local = join(root, "tools/desktop-parser/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const python = process.env.MARSHAL_PARSER_PYTHON ?? (existsSync(local) ? local : process.platform === "win32" ? "python" : "python3");
  const result = await promisify(execFile)(python, [join(root, "tools/desktop-parser/prepare.py"), "--target", target], { cwd: root, timeout: 240000, maxBuffer: 1024 * 1024, shell: false });
  process.stdout.write(result.stdout);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await prepareParser(process.argv[2]);
