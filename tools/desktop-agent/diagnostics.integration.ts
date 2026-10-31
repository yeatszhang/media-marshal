import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { launchDesktop } from "../../apps/desktop/tests/support/electron.ts";
import { assertBuild } from "./build.ts";
import { EventCollector } from "./collector.ts";
import { newSession, runHome, readSession, saveSession } from "./session-store.ts";
import { identify, sameProcess } from "./process.ts";
const root = resolve(import.meta.dirname, "../.."),
  execute = promisify(execFile);
async function cli(command: string, sessionId?: string, payload?: object) {
  const args = [
    "--disable-warning=ExperimentalWarning",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--experimental-strip-types",
    join(root, "tools/desktop-agent/cli.ts"),
    command,
    "--json",
  ];
  if (sessionId) args.push("--session", sessionId);
  let inputPath: string | undefined;
  if (payload) {
    const path = join(
      runHome(root, (await readSession(root, sessionId!)).runId),
      "request-" + randomUUID() + ".json",
    );
    inputPath = path;
    await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
    args.push("--input", path);
  }
  try {
    return JSON.parse((await execute(process.execPath, args, { cwd: root, timeout: 20000 })).stdout)
      .result;
  } finally {
    if (inputPath) await unlink(inputPath);
  }
}
async function until<T>(read: () => Promise<T>, accepted: (value: T) => boolean, message: string) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepted(value)) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(message);
}
test(
  "CLI 日志及只读诊断关联当前构建，停止后仍可查询且不创建业务作业",
  { timeout: 60000 },
  async () => {
    const started = await cli("start"),
      id = started.sessionId;
    try {
      await until(
        () => cli("status", id),
        (state) => state.status === "running",
        "会话未就绪",
      );
      const before = await cli("diagnose", id),
        after = await cli("diagnose", id);
      assert.equal(before.health.runtime.status, "observed");
      assert.equal(before.health.runtime.value.core, "ready");
      for (const field of ["syncJobs", "mediaTasks", "cleanup", "corrections"]) {
        assert.equal(before.health[field].status, "observed");
        assert.equal(before.health[field].value.total, 0);
        assert.deepEqual(before.health[field], after.health[field]);
      }
      assert.equal(after.collection.available, true);
      assert.equal(after.historyComplete, false);
      const logs = await cli("logs", id, { limit: 1 });
      assert.equal(logs.records.length, 1);
      assert.ok(logs.cursor);
      const next = await cli("logs", id, { cursor: logs.cursor, limit: 20 });
      assert.ok(next.records.length > 0);
      assert.equal(next.records[0].sessionId, id);
      assert.equal(next.records[0].buildId, started.buildId);
      await cli("stop", id);
      await until(
        () => cli("status", id),
        (state) => state.status === "stopped",
        "会话未停止",
      );
      const stopped = await cli("diagnose", id);
      assert.equal(stopped.collection.closed, true);
      assert.equal(stopped.health.status, "unavailable");
    } finally {
      if ((await cli("status", id)).status !== "stopped") await cli("stop", id);
      await until(
        () => cli("status", id),
        (state) => state.status === "stopped",
        "清理未确认",
      );
    }
  },
);
test(
  "真实页面异常、Core 退出与 Renderer 崩溃有自动证据，无原始敏感异常",
  { timeout: 60000 },
  async () => {
    const build = await assertBuild(root, "development");
    const session = await newSession(root, {
      scenario: "empty",
      seed: "default",
      mode: "background",
      target: "development",
    });
    session.buildId = build.buildId;
    const collector = await EventCollector.create(root, session);
    const app = await launchDesktop(root, {
      ...session.options,
      dataDir: join(runHome(root, session.runId), "data"),
      diagnostics: { sessionId: session.sessionId, runId: session.runId, buildId: build.buildId },
    });
    collector.attach(app);
    session.owner = identify(process.pid);
    session.application = identify(app.process().pid!);
    session.status = "running";
    await saveSession(root, session);
    const records = async () =>
      (await readFile(collector.snapshot().path, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    try {
      const page = await app.firstWindow();
      await page.getByText("核心已连接", { exact: true }).waitFor();
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error("Authorization: Bearer 原始秘密");
        }, 0);
      });
      await until(
        records,
        (rows) => rows.some((row) => row.event === "renderer.pageerror"),
        "页面异常未自动采集",
      );
      const pid = await app.evaluate(
        ({ app }) => app.getAppMetrics().find((row) => row.name === "Media Marshal Core")!.pid,
      );
      const core = identify(pid)!;
      assert.equal(core.parent, app.process().pid);
      assert.equal(sameProcess(core), true);
      process.kill(core.pid, "SIGKILL");
      await until(
        records,
        (rows) =>
          rows.some((row) => row.event === "component.event" && row.record.event === "core.exit"),
        "Core 退出未采集",
      );
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(),
      );
      await until(
        records,
        (rows) => rows.some((row) => row.event === "renderer.crashed"),
        "窗口崩溃未采集",
      );
    } finally {
      await app.close();
      await collector.close();
    }
    const output = await readFile(collector.snapshot().path, "utf8");
    assert.equal(output.includes("秘密"), false);
    assert.equal(collector.snapshot().available, true);
  },
);
