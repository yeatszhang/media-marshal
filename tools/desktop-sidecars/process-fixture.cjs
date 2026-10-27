// M0 最小进程树：真实 Electron Main → Utility Host → 固定版本 OpenList/Rclone。
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const { identify, matches, stopVerified } = require("./process-identity.cjs");

if (process.parentPort) {
  let guardian;
  let stopping;
  let heartbeat = Date.now();
  let check;
  const send = (data) => { try { process.parentPort.postMessage(data); } catch {} };
  const stop = () => stopping ??= (async () => {
    clearInterval(check);
    if (guardian && guardian.exitCode === null && guardian.signalCode === null) await new Promise((resolve) => {
      const force = setTimeout(() => {
        if (process.platform !== "win32") {
          try { process.kill(-guardian.pid, "SIGKILL"); } catch {}
        } else guardian.kill("SIGKILL");
      }, 5000);
      guardian.once("exit", () => { clearTimeout(force); resolve(); });
      guardian.stdin.end();
    });
    process.exit(0);
  })();
  process.parentPort.on("message", async ({ data }) => {
    if (data.kind === "heartbeat") { heartbeat = Date.now(); return; }
    if (data.kind === "stop") { void stop(); return; }
    if (data.kind !== "initialize" || guardian) return;
    const root = data.root;
    const native = data.native;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"].includes(key.toUpperCase())));
    guardian = spawn(native.guardian, [`--fixture-root=${root}`], { env, cwd: root, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"] });
    guardian.once("spawn", () => {
      send({ kind: "native-started", name: "guardian", pid: guardian.pid });
      guardian.stdin.write(JSON.stringify({ root, native }) + "\n");
    });
    require("node:readline").createInterface({ input: guardian.stdout }).on("line", (line) => {
      try { send(JSON.parse(line)); } catch { send({ kind: "failure", component: "guardian" }); void stop(); }
    });
    guardian.once("exit", (code, signal) => {
      clearInterval(check);
      if (!stopping) send({ kind: "failure", reason: `守护提前退出：code=${code} signal=${signal}` });
      process.exit(0);
    });
    guardian.once("error", () => { send({ kind: "failure", component: "guardian" }); void stop(); });
    check = setInterval(() => { if (Date.now() - heartbeat > 10000) void stop(); }, 100);
    send({ kind: "host-started", pid: process.pid });
  });
  process.parentPort.on("close", () => { void stop(); });
} else {
  const { app, utilityProcess } = require("electron");
  const { createInterface } = require("node:readline");
  const root = process.argv.find((value) => value.startsWith("--fixture-root="))?.slice("--fixture-root=".length);
  const controlPath = process.argv.find((value) => value.startsWith("--fixture-control="))?.slice("--fixture-control=".length);
  if (!root || !controlPath) throw new Error("缺少测试目录或控制通道");
  // Windows 的 Electron GUI 进程不依赖控制台 stdin/stdout 传递测试协议。
  const control = require("node:net").createConnection(controlPath);
  app.setPath("userData", join(root, "electron"));
  const native = JSON.parse(readFileSync(join(root, "native.json"), "utf8"));
  const owned = new Map();
  let host, timer, stopping;
  const emit = (value) => control.write(JSON.stringify(value) + "\n");
  const exit = (code) => control.end(() => app.exit(code));
  const stop = () => stopping ??= (async () => {
    clearInterval(timer);
    try { host?.postMessage({ kind: "stop" }); } catch {}
    const deadline = Date.now() + 7000;
    while ([...owned.values()].some((identity) => matches(identity, root)) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    for (const identity of owned.values()) stopVerified(identity, root);
    try { host?.kill(); } catch {}
    exit(0);
  })();
  app.whenReady().then(() => {
    host = utilityProcess.fork(__filename, [], { stdio: "pipe", serviceName: "Sidecar M0 Host" });
    host.stdout?.on("data", () => {});
    host.stderr?.on("data", () => {});
    host.once("spawn", () => {
      host.postMessage({ kind: "initialize", root, native });
      timer = setInterval(() => host.postMessage({ kind: "heartbeat" }), 200);
    });
    host.on("message", (data) => {
      if (data.kind === "native-started") {
        const identity = identify(data.pid);
        const parent = data.name === "guardian" ? host.pid : owned.get("guardian")?.pid;
        if (!identity || identity.parent !== parent || !identity.command.includes(root)) {
          emit({ kind: "failure", reason: "进程身份或父子关系无效" });
          void stop();
          return;
        }
        owned.set(data.name, identity);
        if (owned.size === 3) emit({ kind: "ready", main: process.pid, host: host.pid, native: Object.fromEntries(owned) });
      }
      if (data.kind === "failure") { emit(data); void stop(); }
      if (data.kind === "native-exited" && !stopping) {
        emit({ kind: "failure", reason: `组件提前退出：${data.name} code=${data.code}` });
        void stop();
      }
    });
    host.once("exit", (code) => {
      clearInterval(timer);
      if (!stopping && owned.size < 3) emit({ kind: "failure", reason: `宿主在就绪前退出：code=${code}` });
      // Host 崩溃后仍须核对本次已登记身份，不能按进程名或 PID 文件清理。
      void stop();
    });
    const input = createInterface({ input: control });
    input.on("line", (line) => {
      try {
        const command = JSON.parse(line);
        if (command.action === "stop") void stop();
        if (command.action === "kill-host") host.kill();
        if (command.action === "kill-native" && owned.has(command.name)) stopVerified(owned.get(command.name), root);
      } catch { emit({ kind: "failure", reason: "测试命令无效" }); }
    });
  }).catch(() => { emit({ kind: "failure", reason: "Electron 宿主初始化失败" }); exit(1); });
  control.on("close", () => { void stop(); });
  control.on("error", () => { void stop(); });
}
