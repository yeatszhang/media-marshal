import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export function debugPort(value = "9222") {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("调试端口必须是 1～65535 的整数；例如 --port 9222");
  }
  return Number(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { port: { type: "string" }, help: { type: "boolean" } } });
    if (values.help) {
      console.log("用法：npm run desktop:dev:debug -- [--port 9222]\n仅开发态开启 CDP；日志读取：npm run desktop:logs -- --list");
    } else {
      const port = debugPort(values.port ?? process.env.REMOTE_DEBUGGING_PORT);
      if (!process.env.npm_execpath) throw new Error("请通过 npm run desktop:dev:debug 启动，以复用当前 npm 和已有开发命令。");
      console.log(`开发态 CDP：127.0.0.1:${port}；更改启动参数后需重启开发进程。`);
      const env = { ...process.env, REMOTE_DEBUGGING_PORT: String(port) };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(process.execPath, [process.env.npm_execpath, "run", "desktop:dev"], {
        cwd: new URL("..", import.meta.url),
        env,
        stdio: "inherit",
      });
      const handlers = ["SIGINT", "SIGTERM"].map(signal => [signal, () => child.kill(signal)]);
      for (const [signal, handler] of handlers) process.on(signal, handler);
      child.once("error", () => { console.error("开发进程启动失败，请通过 npm run desktop:dev:debug 启动并检查 Node/npm 安装。"); process.exitCode = 1; });
      child.once("exit", (code, signal) => {
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
      });
    }
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
