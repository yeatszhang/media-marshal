import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import electron from "electron";
const require = createRequire(import.meta.url);
const { matches, stopVerified } = require("./process-identity.cjs");
const root = resolve(import.meta.dirname, "../..");
const target = `${process.platform}-${process.arch}`;
const lock = JSON.parse(await readFile(join(import.meta.dirname, "sidecars.lock.json"), "utf8"));
const native = {};
for (const name of ["openlist", "rclone"]) {
  const asset = lock.components[name].assets[target].binary;
  native[name] = join(root, "apps/desktop/resources/sidecars", target, "bin", asset.name);
  if (createHash("sha256").update(await readFile(native[name])).digest("hex") !== asset.sha256)
    throw new Error("测试程序摘要不匹配");
}
const guardianDirectory = join(root, "build-artifacts/desktop-sidecars/guardian", target);
await mkdir(guardianDirectory, { recursive: true });
native.guardian = join(guardianDirectory, process.platform === "win32" ? "guardian.exe" : "guardian");
const build = spawnSync("go", ["build", "-trimpath", "-o", native.guardian, "."], { cwd: join(import.meta.dirname, "guardian"), env: { ...process.env, CGO_ENABLED: "0" }, stdio: "inherit" });
if (build.status !== 0) throw new Error("无法构建平台守护验证程序");

const report = { target, electron: (await import("electron/package.json", { with: { type: "json" } })).default.version, scope: "开发态最小 Main/Utility Host/两个 Go 进程；不证明正式安装包或完整下载业务", cases: [] };
for (const scenario of ["graceful", "kill-main", "kill-host", "kill-openlist", "kill-rclone", "kill-guardian"]) {
  const directory = await mkdtemp(join(tmpdir(), "marshal-sidecar-process-"));
  const controlPath = process.platform === "win32" ? `\\\\.\\pipe\\marshal-m0-${randomUUID()}` : join(tmpdir(), `mm-${randomUUID().slice(0, 12)}.sock`);
  let child, ready, control, input, controller, readyTimer;
  try {
    await Promise.all(["openlist", "source", "electron"].map((name) => mkdir(join(directory, name), { mode: 0o700 })));
    await writeFile(join(directory, "source/fixture.bin"), Buffer.alloc(32 * 1024 * 1024, 37));
    await writeFile(join(directory, "rclone.conf"), "", { mode: 0o600 });
    await writeFile(join(directory, "native.json"), JSON.stringify(native), { mode: 0o600 });
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    await writeFile(join(directory, "openlist/config.json"), JSON.stringify({ force: true, jwt_secret: randomUUID(), scheme: { address: "127.0.0.1", http_port: port, https_port: -1 }, log: { enable: false }, s3: { enable: false }, ftp: { enable: false }, sftp: { enable: false }, mcp: { enable: false } }), { mode: 0o600 });
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    let acceptReady, rejectReady;
    const readiness = new Promise((resolve, reject) => { acceptReady = resolve; rejectReady = reject; });
    controller = createServer((socket) => {
      if (control) { socket.destroy(); return; }
      control = socket;
      input = createInterface({ input: socket });
      input.on("line", (line) => {
        try {
          const data = JSON.parse(line);
          if (data.kind === "failure") rejectReady(new Error(data.reason || "组件失败"));
          if (data.kind === "ready") acceptReady(data);
        } catch {}
      });
      socket.on("error", () => rejectReady(new Error("测试控制通道失败")));
    });
    await new Promise((resolve, reject) => { controller.once("error", reject); controller.listen(controlPath, resolve); });
    if (process.platform !== "win32") await chmod(controlPath, 0o600);
    child = spawn(electron, [join(import.meta.dirname, "process-fixture.cjs"), `--fixture-root=${directory}`, `--fixture-control=${controlPath}`], { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-4000); });
    child.stdout.resume();
    readyTimer = setTimeout(() => rejectReady(new Error("进程树就绪超时")), 30000);
    child.once("error", rejectReady);
    child.once("close", (code) => rejectReady(new Error(`进程树启动中退出：${code} ${errors.replaceAll(directory, "<临时目录>")}`)));
    ready = await readiness;
    clearTimeout(readyTimer);
    // 不只验证成功 spawn：两个 Go 必须实际提供服务和开始写入暂存区。
    const activeDeadline = Date.now() + 15000;
    while (true) {
      const ping = await fetch(`http://127.0.0.1:${port}/ping`).then((response) => response.text()).catch(() => "");
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(join(directory, "staging")).catch(() => []);
      if (ping === "pong" && files.length) break;
      if (Date.now() > activeDeadline) throw new Error("组件没有进入服务/传输状态");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (scenario === "kill-main") child.kill("SIGKILL");
    else if (scenario === "kill-host") control.write(JSON.stringify({ action: "kill-host" }) + "\n");
    else if (scenario.startsWith("kill-")) control.write(JSON.stringify({ action: "kill-native", name: scenario.slice(5) }) + "\n");
    else control.write(JSON.stringify({ action: "stop" }) + "\n");
    const deadline = Date.now() + 15000;
    while (Object.values(ready.native).some((identity) => matches(identity, directory))) {
      if (Date.now() > deadline) throw new Error(`出现孤儿 Go 进程：${scenario}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const record = { scenario, passed: true, identityChecked: true, native: ready.native };
    report.cases.push(JSON.parse(JSON.stringify(record)
      .replaceAll(directory.replaceAll("\\", "\\\\"), "<临时目录>")
      .replaceAll(root.replaceAll("\\", "\\\\"), "<仓库>")));
    console.log(`${target} ${scenario}：自有 Go 进程已全部停止`);
    input.close();
  } finally {
    clearTimeout(readyTimer);
    if (ready) for (const identity of Object.values(ready.native)) stopVerified(identity, directory);
    child?.kill("SIGKILL");
    input?.close();
    control?.destroy();
    if (controller?.listening) await new Promise((resolve) => controller.close(resolve));
    if (process.platform !== "win32") await rm(controlPath, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}
const output = join(root, "test-results/sidecars/process-smoke.json");
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
