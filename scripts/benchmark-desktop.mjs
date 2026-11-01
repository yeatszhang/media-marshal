import {
  beginBenchmark,
  benchmarkLaunch,
  benchmarkClose,
  finishBenchmark,
  failBenchmark,
  benchmarkSamples,
  benchmarkStopped,
  benchmarkInstance,
} from "../tools/desktop-agent/benchmark-context.ts";
import { healthWithin } from "../tools/desktop-agent/health-budget.ts";
import { nativeHelperRecord } from "../tools/desktop-agent/native-fingerprint.ts";
import { ToolError, failure } from "../tools/desktop-agent/protocol.ts";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir, platform, arch, release, cpus, totalmem } from "node:os";
import { createInterface } from "node:readline";
import { existsSync, statfsSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
let benchmark;
try {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.some((value) => !["--json", "--background"].includes(value)))
    throw new ToolError(
      "BENCHMARK_INPUT",
      "测量参数不在允许清单内",
      "只使用 --json 和可选 --background",
      "blocked",
    );
  const json = argumentsList.includes("--json"),
    mode = argumentsList.includes("--background") ? "background" : "foreground";
  const progress = (message) => (json ? process.stderr : process.stdout).write(message + "\n");
  const { identify, matches, children } = createRequire(import.meta.url)(
    "../tools/desktop-sidecars/process-identity.cjs",
  );

  if (platform() !== "darwin")
    throw new ToolError(
      "BENCHMARK_PLATFORM_UNSUPPORTED",
      "当前测量仅在 macOS 验证",
      "在已适配平台测量，其他平台保持受阻",
      "blocked",
    );
  const appDirectory = resolve(
    `apps/desktop/release/${arch() === "arm64" ? "mac-arm64" : "mac"}/Media Marshal.app`,
  );
  const executable = join(appDirectory, "Contents/MacOS/Media Marshal");
  const parserDirectory = join(appDirectory, "Contents/Resources/parser");
  const parserExecutable = join(parserDirectory, "media-marshal-parser");
  if (!existsSync(executable) || !existsSync(parserExecutable))
    throw new ToolError(
      "BUILD_NOT_READY",
      "目录包或冻结解析器缺失",
      "先构建当前目录包，再运行测量",
      "blocked",
    );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (mode === "foreground") {
    const helper = await nativeHelperRecord(resolve("."));
    const capability = JSON.parse(
      execFileSync(helper.path, ["capabilities"], { encoding: "utf8", timeout: 5000 }),
    );
    if (capability.sessionLocked)
      throw new ToolError(
        "BENCHMARK_SESSION_LOCKED",
        "设备锁屏，不能测量前台窗口唤起",
        "解锁后重跑，或显式使用 --background 只测后台范围",
        "blocked",
      );
  }
  benchmark = await beginBenchmark(resolve("."), mode);
  const temporary = await mkdtemp(join(tmpdir(), "media-marshal-benchmark-"));
  const fresh = [],
    reused = [],
    freshStages = [],
    reusedStages = [];
  let metrics = [];
  let osMetrics, queueSample, runtimeVersions;
  function processSnapshot(mainPid) {
    const main = identify(mainPid);
    if (!main || !main.command.includes(temporary)) throw new Error("测量主进程归属未确认");
    const owned = new Map(),
      queue = [main];
    for (const entry of queue) {
      if (owned.has(entry.pid)) continue;
      if (owned.size >= 128 || !matches(entry, entry.command))
        throw new Error("测量进程树变化，请重试本次测量");
      owned.set(entry.pid, entry);
      queue.push(...children(entry.pid));
    }
    const rows = execFileSync(
      "/bin/ps",
      ["-p", [...owned.keys()].join(","), "-o", "pid=", "-o", "time=", "-o", "rss="],
      { encoding: "utf8", timeout: 3000 },
    )
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, time, rss] = line.trim().split(/\s+/),
          entry = owned.get(Number(pid));
        if (
          !entry ||
          !matches(entry, entry.command) ||
          !/^(?:\d+:){1,2}\d+(?:\.\d+)?$/.test(time) ||
          !/^\d+$/.test(rss)
        )
          throw new Error("测量进程指标无法核对");
        return {
          identity: entry,
          cpuMs: time.split(":").reduce((total, value) => total * 60 + Number(value), 0) * 1000,
          residentKiB: Number(rss),
        };
      });
    if (rows.length !== owned.size) throw new Error("测量期间进程树变化，请重试本次测量");
    return { at: performance.now(), rows };
  }
  function compareProcesses(before, after) {
    const elapsed = after.at - before.at;
    const rows = after.rows.map((row) => {
      const previous = before.rows.find(
        (old) =>
          old.identity.pid === row.identity.pid &&
          old.identity.created === row.identity.created &&
          old.identity.command === row.identity.command,
      );
      const metric = metrics.find((item) => item.pid === row.identity.pid);
      return {
        name:
          metric?.name ??
          (row.identity.command.includes(parserExecutable) ? "冻结解析器" : "其他自有子进程"),
        cpuPercent:
          previous && row.cpuMs >= previous.cpuMs
            ? Math.round(((row.cpuMs - previous.cpuMs) / elapsed) * 10000) / 100
            : null,
        residentKiB: row.residentKiB,
      };
    });
    if (!rows.some((row) => row.name === "冻结解析器"))
      throw new Error("当前 Core 的冻结解析器未进入进程树采样");
    return {
      intervalMs: Math.round(elapsed),
      processes: rows,
      totalCpuPercent: rows.every((row) => row.cpuPercent !== null)
        ? rows.reduce((sum, row) => sum + row.cpuPercent, 0)
        : null,
      totalResidentMiB:
        Math.round((rows.reduce((sum, row) => sum + row.residentKiB, 0) / 1024) * 100) / 100,
    };
  }
  function distribution(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (q) =>
      Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] * 100) / 100;
    return {
      samplesMs: values.map((value) => Math.round(value * 100) / 100),
      n: values.length,
      p50Ms: percentile(0.5),
      p75Ms: percentile(0.75),
      p95Ms: percentile(0.95),
    };
  }
  async function launch(dataDirectory, capture = false) {
    const application = await benchmarkLaunch(benchmark, dataDirectory);
    const start = benchmarkInstance(benchmark, application).spawnStartedAt;
    try {
      const page = await application.firstWindow(),
        windowReadyMs = performance.now() - start;
      await page.getByText("核心已连接", { exact: true }).waitFor();
      const coreReadyMs = performance.now() - start,
        navigationStart = performance.now();
      await page.getByRole("link", { name: "来源", exact: true }).click();
      await page.getByRole("heading", { name: "来源同步", exact: true }).waitFor();
      const duration = performance.now() - start,
        navigationMs = performance.now() - navigationStart;
      if (capture) {
        await application.evaluate(({ app }) => app.getAppMetrics());
        const mainPid = await application.evaluate(() => process.pid),
          before = processSnapshot(mainPid);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const after = processSnapshot(mainPid);
        metrics = await application.evaluate(({ app }) =>
          app.getAppMetrics().map((metric) => ({
            pid: metric.pid,
            type: metric.type,
            name: metric.name ?? metric.serviceName ?? metric.type,
            cpuPercent: metric.cpu.percentCPUUsage,
            workingSetKiB: metric.memory.workingSetSize,
          })),
        );
        osMetrics = compareProcesses(before, after);
        runtimeVersions = await application.evaluate(() => ({
          electron: process.versions.electron,
          node: process.versions.node,
          chrome: process.versions.chrome,
        }));
        queueSample = await healthWithin(application, 5000)
          .then((value) => {
            const complete = ["syncJobs", "mediaTasks", "cleanup", "corrections"].every(
              (key) =>
                value[key]?.status === "observed" &&
                value[key].value?.state === "observed" &&
                Number.isSafeInteger(value[key].value?.total),
            );
            return { status: complete ? "observed" : "partial", value };
          })
          .catch(() => ({ status: "unavailable", reason: "HEALTH_CAPTURE_FAILED" }));
      }
      return { totalMs: duration, windowReadyMs, coreReadyMs, navigationMs };
    } finally {
      await benchmarkClose(benchmark, application);
    }
  }
  function parserEnvironment() {
    return {
      ...Object.fromEntries(
        Object.entries(env).filter(([key]) =>
          ["LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"].includes(
            key,
          ),
        ),
      ),
      PATH: "",
      PYTHONHOME: "",
      PYTHONPATH: "",
    };
  }
  async function parserBenchmark() {
    const target = parserExecutable;
    const parserChild = spawn(target, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: parserEnvironment(),
    });
    const parserIdentity = identify(parserChild.pid);
    const closed = new Promise((resolve) => parserChild.once("close", resolve));
    const lines = createInterface({ input: parserChild.stdout });
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
    parserChild.once("exit", () => {
      for (const value of pending.values()) {
        clearTimeout(value.timer);
        value.reject(new Error("解析器提前退出"));
      }
      pending.clear();
    });
    parserChild.stderr.on("data", () => {});
    function request(action, filename) {
      return new Promise((resolve, reject) => {
        const requestId = `benchmark-${++sequence}`;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("解析器测量超时"));
        }, 10000);
        pending.set(requestId, { resolve, reject, timer });
        parserChild.stdin.write(
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
      parserChild.stdin.end();
      const deadline = setTimeout(() => {
        if (
          parserChild.exitCode === null &&
          parserChild.signalCode === null &&
          parserIdentity &&
          matches(parserIdentity, target)
        )
          parserChild.kill("SIGKILL");
      }, 1000);
      try {
        await closed;
      } finally {
        clearTimeout(deadline);
      }
    }
  }
  async function activationBenchmark() {
    const dataDirectory = join(temporary, "activation");
    const application = await benchmarkLaunch(benchmark, dataDirectory);
    const samples = [];
    try {
      const page = await application.firstWindow();
      await page.getByText("核心已连接", { exact: true }).waitFor();
      for (let index = 0; index < 5; index++) {
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
        const start = performance.now();
        const diagnostic = benchmarkInstance(benchmark, application);
        const secondary = spawn(executable, [`--user-data-dir=${dataDirectory}`], {
          env: {
            ...env,
            MARSHAL_E2E_MODE: mode,
            MARSHAL_AGENT_SESSION_ID: diagnostic.sessionId,
            MARSHAL_AGENT_RUN_ID: diagnostic.runId,
            MARSHAL_AGENT_BUILD_ID: diagnostic.buildId,
          },
          stdio: "ignore",
        });
        const secondaryIdentity = identify(secondary.pid);
        const stopSecondary = () => {
          if (secondaryIdentity && matches(secondaryIdentity, executable)) secondary.kill();
        };
        const exited = new Promise((resolve) => secondary.once("exit", resolve));
        const timer = setTimeout(stopSecondary, 5000);
        try {
          while (
            !(await application.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].isVisible(),
            ))
          ) {
            if (performance.now() - start > 5000) throw new Error("重复启动未唤起已有窗口");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await page.getByRole("link", { name: "来源", exact: true }).click();
          samples.push(performance.now() - start);
          await exited;
        } finally {
          clearTimeout(timer);
          stopSecondary();
        }
      }
      return distribution(samples);
    } finally {
      await benchmarkClose(benchmark, application);
    }
  }
  try {
    for (let index = 0; index < 3; index++) {
      const sample = await launch(join(temporary, `first-${index}`));
      fresh.push(sample.totalMs);
      freshStages.push(sample);
      progress(`首次数据目录样本 ${index + 1}/3 完成`);
    }
    await launch(join(temporary, "reused"));
    for (let index = 0; index < 5; index++) {
      const sample = await launch(join(temporary, "reused"), index === 4);
      reused.push(sample.totalMs);
      reusedStages.push(sample);
      progress(`复用数据目录样本 ${index + 1}/5 完成`);
    }
    const activation =
      mode === "foreground"
        ? { status: "measured", ...(await activationBenchmark()) }
        : { status: "not-run", reason: "BACKGROUND_SCOPE_SELECTED" };
    const parser = await parserBenchmark();
    const diskKiB = (path) =>
      Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split(/\s/)[0]);
    const report = {
      capturedAt: new Date().toISOString(),
      sampleRuns: benchmarkSamples(benchmark),
      runId: benchmark.run.runId,
      buildId: benchmark.build.buildId,
      mode,
      requestedScopes: [
        "startup",
        "navigation",
        "idle",
        "parser",
        ...(mode === "foreground" ? ["activation"] : []),
      ],
      thresholds: "not-defined",
      performanceRegression: "not-evaluated",
      nativeAcceptance: "not-run",
      startupStages: { fresh: freshStages, reused: reusedStages },
      queues: queueSample,
      environment: {
        platform: platform(),
        arch: arch(),
        osRelease: release(),
        macOS: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
        cpu: cpus()[0]?.model,
        memoryGiB: Math.round(totalmem() / 1024 ** 3),
        node: process.version,
        runtimeVersions,
        filesystemTypeCode: `0x${statfsSync(appDirectory).type.toString(16)}`,
      },
      build: "未正式签名的当前目录包，Core 与冻结解析器已接入",
      artifact: {
        asarSha256: createHash("sha256")
          .update(await readFile(join(appDirectory, "Contents/Resources/app.asar")))
          .digest("hex"),
        parserSha256: createHash("sha256")
          .update(await readFile(parserExecutable))
          .digest("hex"),
      },
      definition:
        "启动耗时从 SDK 启动调用开始，到观测到核心已连接且来源同步页可以点击打开；包含自动化连接及采集开销。首次/复用均为新进程，未清空 OS 磁盘缓存。复用目录先进行一次不计入结果的初始化。",
      firstLaunch: distribution(fresh),
      reusedLaunch: distribution(reused),
      hotActivation: {
        definition:
          "已有进程窗口隐藏后，重复启动同一数据目录实例，测至原窗口可见且来源导航可点击（通过 CDP，不代表原生焦点验收）；包含 10ms 轮询与自动化开销",
        ...activation,
      },
      idle: {
        definition:
          "隔离空资料目录、无账号或媒体作业。从本次 Main 递归核对自有 OS 子进程，包括 Core 与冻结解析器；CPU 为两次 ps 累计 CPU 时间之差除以实际采样间隔，RSS 为末次快照。Electron 指标单列，不能与 OS 快照重复相加。",
        ...osMetrics,
        electron: {
          processes: metrics.map(({ pid, ...value }) => value),
          totalCpuPercent: metrics.reduce((sum, item) => sum + item.cpuPercent, 0),
          totalWorkingSetMiB:
            Math.round((metrics.reduce((sum, item) => sum + item.workingSetKiB, 0) / 1024) * 100) /
            100,
        },
      },
      size: {
        definition: "du -sk 目录占用，非 DMG/NSIS 下载体积",
        appMiB: Math.round((diskKiB(appDirectory) / 1024) * 100) / 100,
        bundledParserMiB: Math.round((diskKiB(parserDirectory) / 1024) * 100) / 100,
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
    const result = await finishBenchmark(
      benchmark,
      report,
      queueSample?.status === "observed" ? "completed" : "partial",
    );
    process.stdout.write(JSON.stringify({ ...result, report }, null, json ? 0 : 2) + "\n");
    if (result.status !== "completed") process.exitCode = 2;
  } finally {
    if (benchmarkStopped(benchmark)) await rm(temporary, { recursive: true, force: true });
    else
      process.stderr.write(
        JSON.stringify({
          event: "benchmark.profile.retained",
          reason: "WRITER_STATE_UNKNOWN",
          directory: temporary,
        }) + "\n",
      );
  }
} catch (error) {
  if (benchmark)
    await failBenchmark(benchmark, error instanceof ToolError ? error.code : "BENCHMARK_FAILED");
  process.stdout.write(
    JSON.stringify({
      ...failure(error),
      ...(benchmark ? { runId: benchmark.run.runId, buildId: benchmark.build.buildId } : {}),
    }) + "\n",
  );
  process.exitCode = error instanceof ToolError && error.state !== "failed" ? 2 : 1;
}
