import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { sanitizeLogValue } from "../apps/desktop/src/logging/shared.ts";
import { debugPort } from "./desktop-debug.mjs";

const help = `用法：npm run desktop:logs -- [--port 9222] [--list | --target ID] [--duration 秒]
先启动：npm run desktop:dev:debug
--list       列出 page／webview 目标；多窗口时用 --target 消歧
--target ID  连接指定目标（含真正的 webview）；否则仅自动选择唯一 page
--duration   采集指定秒数后断开；默认持续到 Ctrl+C
输出为脱敏 JSONL，可重定向保存。历史完整性未知，对象属性是读取时的值。
文档：docs/development/desktop-cdp-logs.md`;

export function options(args) {
  const { values } = parseArgs({ args, options: {
    port: { type: "string" }, target: { type: "string" }, list: { type: "boolean" },
    duration: { type: "string" }, help: { type: "boolean" },
  } });
  const port = debugPort(values.port);
  const duration = values.duration === undefined ? undefined : Number(values.duration);
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || duration > 86400)) {
    throw new Error("采集时长必须大于 0 且不超过 86400 秒；例如 --duration 10");
  }
  if (values.list && (values.target || duration !== undefined)) throw new Error("--list 不能与 --target 或 --duration 一起使用");
  return { ...values, port, duration };
}

function safeURL(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "file:", "marshal:", "about:"].includes(url.protocol)) return `[${url.protocol}地址已省略]`;
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.href;
  } catch { return "[地址不可用]"; }
}

export function selectTarget(targets, id) {
  const candidates = targets.filter(item => ["page", "webview"].includes(item.type));
  const matches = id ? candidates.filter(item => item.id === id) : candidates.filter(item => item.type === "page");
  if (matches.length !== 1) throw new Error(id
    ? "指定目标不存在或已关闭；请重新运行 --list 并选择目标 ID。"
    : "未找到唯一主页面；请运行 --list，再用 --target ID 选择目标。");
  return matches[0];
}

function stackTrace(stack) {
  if (!stack) return undefined;
  return { callFrames: (stack.callFrames ?? []).slice(0, 16).map(frame => ({
    functionName: frame.functionName, url: safeURL(frame.url), lineNumber: frame.lineNumber, columnNumber: frame.columnNumber,
  })) };
}

async function writeRecord(record) {
  if (!process.stdout.write(JSON.stringify(record) + "\n")) await once(process.stdout, "drain");
}

export async function collect(config, write = writeRecord, signal) {
  const emit = record => write(sanitizeLogValue({ receivedAt: new Date().toISOString(), ...record }));
  let targets;
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/json/list`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error();
    targets = await response.json();
    if (!Array.isArray(targets)) throw new Error();
  } catch {
    throw new Error(`无法读取 127.0.0.1:${config.port} 的调试目标；请先运行 npm run desktop:dev:debug -- --port ${config.port}，已启动的普通开发进程需要退出重启。`);
  }
  if (config.list) {
    await emit({ event: "targets", targets: targets.filter(item => ["page", "webview"].includes(item.type)).map(item => ({
      id: item.id, type: item.type, title: item.title, url: safeURL(item.url),
    })) });
    return;
  }
  const target = selectTarget(targets, config.target);
  const address = new URL(target.webSocketDebuggerUrl);
  if (address.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname) ||
      address.port !== String(config.port) || address.username || address.password) {
    throw new Error("目标调试地址不是指定端口的本机 WebSocket；请核对 --port 和目标应用。");
  }
  const socket = new WebSocket(address);
  let nextId = 0, dropped = 0, queued = 0, stopping = false, failure;
  const pending = new Map();
  let chain = Promise.resolve();
  const stop = () => { stopping = true; socket.close(); };
  const rejectPending = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("调试连接已关闭")); }
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN || stopping) return reject(new Error("调试连接已关闭"));
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("调试命令超时")); }, 1500);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  async function argument(value, depth = 0) {
    if (Object.hasOwn(value, "value")) return value.value;
    if (value.unserializableValue) return value.unserializableValue;
    if (value.subtype === "error") return { type: value.className ?? "Error" };
    if (!value.objectId || value.type !== "object") return { type: value.type, className: value.className };
    if (depth >= 2) return "[深层对象已省略]";
    try {
      const { result } = await send("Runtime.getProperties", { objectId: value.objectId, ownProperties: true });
      const fields = await Promise.all(result.filter(item => item.enumerable).slice(0, 30).map(async item => [
        item.name,
        /cookie|authorization|password|passwd|secret|token|api[-_]?key|credential/i.test(item.name) ? "[已脱敏]"
          : item.value ? await argument(item.value, depth + 1) : "[访问器未读取]",
      ]));
      return { type: value.className ?? value.subtype ?? "Object", properties: Object.fromEntries(fields), truncated: result.length > 30 };
    } catch { return { type: value.className ?? "Object", unavailable: true }; }
  }
  async function receive(method, params) {
    const base = { targetId: target.id, method, timestamp: params.timestamp };
    if (method === "Runtime.consoleAPICalled") {
      await emit({ ...base, event: "console", level: params.type, args: await Promise.all(params.args.slice(0, 10).map(value => argument(value))),
        truncated: params.args.length > 10, stackTrace: stackTrace(params.stackTrace) });
    } else if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails;
      await emit({ ...base, event: "exception", type: details.exception?.className ?? "Error", message: "页面存在未捕获异常",
        url: safeURL(details.url), lineNumber: details.lineNumber, columnNumber: details.columnNumber, stackTrace: stackTrace(details.stackTrace) });
    } else if (method === "Log.entryAdded") {
      const entry = params.entry;
      await emit({ ...base, event: "browser", level: entry.level, source: entry.source, text: entry.text,
        timestamp: entry.timestamp, url: safeURL(entry.url), lineNumber: entry.lineNumber, stackTrace: stackTrace(entry.stackTrace) });
    } else await emit({ ...base, event: "context.cleared", historyComplete: false });
  }
  socket.addEventListener("message", event => {
    if (event.data.length > 256 * 1024) { dropped++; return; }
    let message;
    try { message = JSON.parse(event.data); } catch { dropped++; return; }
    if (message.id) {
      const request = pending.get(message.id);
      if (request) {
        clearTimeout(request.timer); pending.delete(message.id);
        if (message.error) request.reject(new Error("调试命令被拒绝")); else request.resolve(message.result);
      }
    } else if (["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded", "Runtime.executionContextsCleared"].includes(message.method)) {
      if (stopping || queued >= 100) { dropped++; return; }
      queued++;
      chain = chain.then(() => receive(message.method, message.params)).catch(() => { dropped++; }).finally(() => { queued--; });
    }
  });
  const closed = new Promise(resolve => socket.addEventListener("close", () => {
    if (!stopping) failure = "目标页面或调试连接已关闭；请重新运行 --list 并连接当前目标。";
    stopping = true; rejectPending(); resolve();
  }, { once: true }));
  socket.addEventListener("error", () => { failure = "本机调试连接失败；请检查目标是否已关闭及端口是否正确。"; stop(); });
  let durationTimer;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error("连接本机调试目标超时，请检查 --port 并重新 --list。")); }, 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("无法连接本机调试目标，请重新 --list。")); }, { once: true });
    });
    await emit({ event: "connected", targetId: target.id, type: target.type, url: safeURL(target.url), historyComplete: false });
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    else {
      await send("Runtime.enable");
      await send("Log.enable");
      if (config.duration) durationTimer = setTimeout(stop, config.duration * 1000);
    }
    await closed;
    await chain;
    await emit({ event: "disconnected", targetId: target.id, dropped, historyComplete: false, reason: failure ?? "采集已停止，目标应用继续运行" });
    if (failure) throw new Error(failure);
  } finally {
    clearTimeout(durationTimer); signal?.removeEventListener("abort", stop); stop(); rejectPending();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const config = options(process.argv.slice(2));
    if (config.help) console.log(help);
    else await collect(config, undefined, controller.signal);
  } catch (error) {
    process.stderr.write(JSON.stringify({ event: "error", message: sanitizeLogValue(error.message) }) + "\n"); process.exitCode = 1;
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
