import { _electron } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir, platform, arch, release, cpus, totalmem } from "node:os";
import { createInterface } from "node:readline";
import { existsSync, statfsSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const { identify, matches, children } = createRequire(import.meta.url)("../tools/desktop-sidecars/process-identity.cjs");
import { performance } from "node:perf_hooks";

if (platform() !== "darwin")
  throw new Error("当前测量脚本仅在 macOS 验证，其他平台需先适配并记录环境");
const appDirectory = resolve(
  `apps/desktop/release/${arch() === "arm64" ? "mac-arm64" : "mac"}/Media Marshal.app`,
);
const executable = join(appDirectory, "Contents/MacOS/Media Marshal");
const parserDirectory = join(appDirectory, "Contents/Resources/parser");
const parserExecutable = join(parserDirectory, "media-marshal-parser");
if (!existsSync(executable) || !existsSync(parserExecutable))
  throw new Error("请先生成桌面目录包和本机冻结解析器，再运行测量");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const temporary = await mkdtemp(join(tmpdir(), "media-marshal-benchmark-"));
const fresh = [],
  reused = [];
let metrics = [];
let osMetrics;
function processSnapshot(mainPid) {
  const main = identify(mainPid);
  if (!main || !main.command.includes(temporary)) throw new Error("测量主进程归属未确认");
  const owned = new Map(), queue = [main];
  for (const entry of queue) {
    if (owned.has(entry.pid)) continue;
    if (owned.size >= 128 || !matches(entry, entry.command)) throw new Error("测量进程树变化，请重试本次测量");
    owned.set(entry.pid, entry); queue.push(...children(entry.pid));
  }
  const rows = execFileSync("/bin/ps", ["-p", [...owned.keys()].join(","), "-o", "pid=", "-o", "time=", "-o", "rss="], { encoding: "utf8", timeout: 3000 }).trim().split("\n").map(line => {
    const [pid, time, rss] = line.trim().split(/\s+/), entry = owned.get(Number(pid));
    if (!entry || !matches(entry, entry.command) || !/^(?:\d+:){1,2}\d+(?:\.\d+)?$/.test(time) || !/^\d+$/.test(rss)) throw new Error("测量进程指标无法核对");
    return { identity: entry, cpuMs: time.split(":").reduce((total, value) => total * 60 + Number(value), 0) * 1000, residentKiB: Number(rss) };
  });
  if (rows.length !== owned.size) throw new Error("测量期间进程树变化，请重试本次测量");
  return { at: performance.now(), rows };
}
function compareProcesses(before, after) {
  const elapsed = after.at - before.at;
  const rows = after.rows.map(row => {
    const previous = before.rows.find(old => old.identity.pid === row.identity.pid && old.identity.created === row.identity.created && old.identity.command === row.identity.command);
    const metric = metrics.find(item => item.pid === row.identity.pid);
    return { name: metric?.name ?? (row.identity.command.includes(parserExecutable) ? "冻结解析器" : "其他自有子进程"), cpuPercent: previous && row.cpuMs >= previous.cpuMs ? Math.round((row.cpuMs - previous.cpuMs) / elapsed * 10000) / 100 : null, residentKiB: row.residentKiB };
  });
  if (!rows.some(row => row.name === "冻结解析器")) throw new Error("当前 Core 的冻结解析器未进入进程树采样");
  return { intervalMs: Math.round(elapsed), processes: rows, totalCpuPercent: rows.every(row => row.cpuPercent !== null) ? rows.reduce((sum, row) => sum + row.cpuPercent, 0) : null, totalResidentMiB: Math.round(rows.reduce((sum, row) => sum + row.residentKiB, 0) / 1024 * 100) / 100 };
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (q) =>
    Math.round(
      sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] *
        100,
    ) / 100;
  return {
    samplesMs: values.map((value) => Math.round(value * 100) / 100),
    n: values.length,
    p50Ms: percentile(0.5),
    p75Ms: percentile(0.75),
    p95Ms: percentile(0.95),
  };
}
async function launch(dataDirectory, capture = false) {
  const start = performance.now();
  const application = await _electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${dataDirectory}`],
    env,
  });
  try {
    const page = await application.firstWindow();
    await page.getByText("核心已连接", { exact: true }).waitFor();
    await page.getByRole("link", { name: "来源", exact: true }).click();
    await page.getByRole("heading", { name: "来源配置", exact: true }).waitFor();
    const duration = performance.now() - start;
    if (capture) {
      await application.evaluate(({ app }) => app.getAppMetrics());
      const mainPid = await application.evaluate(() => process.pid), before = processSnapshot(mainPid);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const after = processSnapshot(mainPid);
      metrics = await application.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .map((metric) => ({
            pid: metric.pid,
            type: metric.type,
            name: metric.name ?? metric.serviceName ?? metric.type,
            cpuPercent: metric.cpu.percentCPUUsage,
            workingSetKiB: metric.memory.workingSetSize,
          })),
      );
      osMetrics = compareProcesses(before, after);
    }
    return duration;
  } finally {
    await application.close();
  }
}
async function parserBenchmark() {
  const target = parserExecutable;
  const process = spawn(target, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, PATH: "", PYTHONHOME: "", PYTHONPATH: "" },
  });
  const closed = new Promise(resolve => process.once("close", resolve));
  const lines = createInterface({ input: process.stdout });
  let sequence = 0;
  const pending = new Map();
  lines.on("line", (line) => {
    const reply = JSON.parse(line);
    const item = pending.get(reply.requestId);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(reply.requestId);
    if (reply.ok) item.resolve(reply.result);
    else item.reject(new Error("解析器测量请求失败"));
  });
  process.once("exit", () => {
    for (const value of pending.values()) {
      clearTimeout(value.timer);
      value.reject(new Error("解析器提前退出"));
    }
    pending.clear();
  });
  process.stderr.on("data", () => {});
  function request(action, filename) {
    return new Promise((resolve, reject) => {
      const requestId = `benchmark-${++sequence}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("解析器测量超时"));
      }, 10000);
      pending.set(requestId, { resolve, reject, timer });
      process.stdin.write(
        JSON.stringify({
          protocolVersion: 1,
          requestId,
          action,
          ...(filename ? { filename } : {}),
        }) + "\n",
      );
    });
  }
  try {
    const start = performance.now();
    const health = await request("health");
    const startupMs = performance.now() - start;
    const samples = [];
    for (let index = 0; index < 20; index++) {
      const start = performance.now();
      await request(
        "parse",
        index % 2
          ? "Breaking.Bad.S03E07.1080p.mkv"
          : "The.Dark.Knight.2008.1080p.BluRay.x264.mkv",
      );
      samples.push(performance.now() - start);
    }
    return {
      guessitVersion: health.guessitVersion,
      startupToHealthMs: Math.round(startupMs * 100) / 100,
      parse: distribution(samples),
    };
  } finally {
    lines.close();
    process.stdin.end();
    const deadline = setTimeout(() => { if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); }, 1000);
    try { await closed; } finally { clearTimeout(deadline); }
  }
}
async function activationBenchmark() {
  const dataDirectory = join(temporary, "activation");
  const application = await _electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${dataDirectory}`],
    env,
  });
  const samples = [];
  try {
    const page = await application.firstWindow();
    await page.getByText("核心已连接", { exact: true }).waitFor();
    for (let index = 0; index < 5; index++) {
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].hide(),
      );
      const start = performance.now();
      const secondary = spawn(
        executable,
        [`--user-data-dir=${dataDirectory}`],
        { env, stdio: "ignore" },
      );
      const exited = new Promise((resolve) => secondary.once("exit", resolve));
      const timer = setTimeout(() => secondary.kill(), 5000);
      try {
        while (
          !(await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].isVisible(),
          ))
        ) {
          if (performance.now() - start > 5000)
            throw new Error("重复启动未唤起已有窗口");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await page.getByRole("link", { name: "来源", exact: true }).click();
        samples.push(performance.now() - start);
        await exited;
      } finally {
        clearTimeout(timer);
        secondary.kill();
      }
    }
    return distribution(samples);
  } finally {
    await application.close();
  }
}
try {
  for (let index = 0; index < 3; index++) {
    fresh.push(await launch(join(temporary, `first-${index}`)));
    console.log(`首次数据目录样本 ${index + 1}/3 完成`);
  }
  await launch(join(temporary, "reused"));
  for (let index = 0; index < 5; index++) {
    reused.push(await launch(join(temporary, "reused"), index === 4));
    console.log(`复用数据目录样本 ${index + 1}/5 完成`);
  }
  const activation = await activationBenchmark();
  const parser = await parserBenchmark();
  const diskKiB = (path) =>
    Number(
      execFileSync("du", ["-sk", path], { encoding: "utf8" }).split(/\s/)[0],
    );
  const report = {
    capturedAt: new Date().toISOString(),
    environment: {
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      macOS: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
      cpu: cpus()[0]?.model,
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
      filesystemTypeCode: `0x${statfsSync(appDirectory).type.toString(16)}`,
    },
    build: "未正式签名的当前目录包，Core 与冻结解析器已接入",
    artifact: {
      asarSha256: createHash("sha256").update(await readFile(join(appDirectory, "Contents/Resources/app.asar"))).digest("hex"),
      parserSha256: createHash("sha256").update(await readFile(parserExecutable)).digest("hex"),
    },
    definition:
      "启动耗时从创建进程开始，到核心已连接且来源页可以点击打开；首次/复用均为新进程，未清空 OS 磁盘缓存。复用目录先进行一次不计入结果的初始化。",
    firstLaunch: distribution(fresh),
    reusedLaunch: distribution(reused),
    hotActivation: {
      definition:
        "已有进程窗口隐藏后，重复启动同一数据目录实例，测至原窗口可见且来源导航可点击；包含 10ms 轮询与自动化开销",
      ...activation,
    },
    idle: {
      definition:
        "隔离空资料目录、无账号或媒体作业。从本次 Main 递归核对自有 OS 子进程，包括 Core 与冻结解析器；CPU 为两次 ps 累计 CPU 时间之差除以实际采样间隔，RSS 为末次快照。Electron 指标单列，不能与 OS 快照重复相加。",
      ...osMetrics,
      electron: { processes: metrics.map(({ pid, ...value }) => value), totalCpuPercent: metrics.reduce((sum, item) => sum + item.cpuPercent, 0), totalWorkingSetMiB: Math.round(metrics.reduce((sum, item) => sum + item.workingSetKiB, 0) / 1024 * 100) / 100 },
    },
    size: {
      definition: "du -sk 目录占用，非 DMG/NSIS 下载体积",
      appMiB: Math.round((diskKiB(appDirectory) / 1024) * 100) / 100,
      bundledParserMiB:
        Math.round(
          (diskKiB(parserDirectory) /
            1024) *
            100,
        ) / 100,
    },
    bundledParser: parser,
    limitations: [
      "样本量较小，未登录账号的空队列不代表真实下载、识别或 COPY 负载",
      "仅测 macOS 当前机器，未测最低系统和其他架构",
      "工作集相加可能重复计算共享页，不代表系统独占内存",
      "解析耗时由同一随包程序独立进程测量，不等于完整识别或入库耗时",
      "未测签名、公证和正式安装包",
    ],
  };
  await mkdir("test-results/desktop", { recursive: true });
  await writeFile(
    "test-results/desktop/benchmark.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
