import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { newSession } from "./session-store.ts";
import { EventCollector } from "./collector.ts";

test("观察采集区分可信页面与敏感窗口，保留崩溃、组件退出及明确丢弃数", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-agent-collector-"));
  const session = await newSession(root, {
    scenario: "empty",
    seed: "default",
    mode: "background",
    target: "development",
  });
  const collector = await EventCollector.create(root, session);
  const page = Object.assign(new EventEmitter(), {
    url: () => "marshal://app/index.html",
    mainFrame: () => null,
  });
  const remote = Object.assign(new EventEmitter(), {
    url: () => "https://login.example.invalid/?token=秘密",
    mainFrame: () => null,
  });
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
  const app = Object.assign(new EventEmitter(), {
    windows: () => [page, remote] as unknown as Page[],
    process: () => child,
  });
  try {
    collector.attach(app as unknown as ElectronApplication);
    page.emit("pageerror", new Error("原始异常秘密"));
    remote.emit("pageerror", new Error("登录秘密"));
    page.emit("crash");
    child.stdout.write(
      JSON.stringify({
        level: 50,
        msg: "安全提示",
        event: "core.exit",
        token: "令牌秘密",
        sessionId: session.sessionId,
      }) + "\n",
    );
    child.stdout.write("普通控制台秘密\n");
    child.emit("exit", 1, null);
    for (let count = 0; count < 1000; count++) collector.record("synthetic.progress", { count });
    await collector.close();
    const state = collector.snapshot(),
      output = await readFile(state.path, "utf8");
    assert.equal(state.historyComplete, false);
    assert.ok(state.dropped > 0);
    assert.equal(output.includes("秘密"), false);
    const rows = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.event === "renderer.pageerror"));
    assert.ok(rows.some((row) => row.event === "sensitive-context.unobserved"));
    assert.ok(rows.some((row) => row.event === "renderer.crashed"));
    assert.ok(rows.some((row) => row.event === "main.exited"));
    assert.ok(
      rows.some((row) => row.event === "component.event" && row.record.event === "core.exit"),
    );
  } finally {
    await collector.close();
    await rm(root, { recursive: true, force: true });
  }
});
