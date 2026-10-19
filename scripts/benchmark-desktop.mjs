import { _electron } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir, platform, arch, release, cpus, totalmem } from "node:os";
import { createInterface } from "node:readline";
import { existsSync, statfsSync } from "node:fs";
import { performance } from "node:perf_hooks";

if (platform() !== "darwin")
  throw new Error("当前测量脚本仅在 macOS 验证，其他平台需先适配并记录环境");
const appDirectory = resolve(
  `apps/desktop/release/${arch() === "arm64" ? "mac-arm64" : "mac"}/Media Marshal.app`,
);
const executable = join(appDirectory, "Contents/MacOS/Media Marshal");
const parserExecutable = resolve(
  "tools/desktop-parser/dist/media-marshal-parser/media-marshal-parser",
);
if (!existsSync(executable) || !existsSync(parserExecutable))
  throw new Error("请先生成桌面目录包和本机冻结解析器，再运行测量");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const temporary = await mkdtemp(join(tmpdir(), "media-marshal-benchmark-"));
const fresh = [],
  reused = [];
let metrics = [];
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
    await page.getByRole("heading", { name: "来源", exact: true }).waitFor();
    const duration = performance.now() - start;
    if (capture) {
      await application.evaluate(({ app }) => app.getAppMetrics());
      await new Promise((resolve) => setTimeout(resolve, 2000));
      metrics = await application.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .map((metric) => ({
            type: metric.type,
            name: metric.name ?? metric.serviceName ?? metric.type,
            cpuPercent: metric.cpu.percentCPUUsage,
            workingSetKiB: metric.memory.workingSetSize,
          })),
      );
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
    process.kill();
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
    environment: {
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      cpu: cpus()[0]?.model,
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
      filesystemTypeCode: `0x${statfsSync(appDirectory).type.toString(16)}`,
    },
    build: "未正式签名的工作树目录包原型",
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
        "最后一次启动后等待 2 秒，通过 app.getAppMetrics 采样 Electron 管理的全部进程；未接入 Core 的独立 parser 不在此进程树内",
      processes: metrics,
      totalCpuPercent: metrics.reduce((sum, item) => sum + item.cpuPercent, 0),
      totalWorkingSetMiB:
        Math.round(
          (metrics.reduce((sum, item) => sum + item.workingSetKiB, 0) / 1024) *
            100,
        ) / 100,
    },
    size: {
      definition: "du -sk 目录占用，非 DMG/NSIS 下载体积",
      appMiB: Math.round((diskKiB(appDirectory) / 1024) * 100) / 100,
      standaloneParserMiB:
        Math.round(
          (diskKiB(resolve("tools/desktop-parser/dist/media-marshal-parser")) /
            1024) *
            100,
        ) / 100,
    },
    standaloneParser: parser,
    limitations: [
      "样本量较小，不代表最终业务版本性能",
      "仅测 macOS 当前机器，未测最低系统和其他架构",
      "工作集相加可能重复计算共享页，不代表系统独占内存",
      "parser 独立测量，未接入应用启动与媒体识别流水线",
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
