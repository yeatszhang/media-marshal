import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { launchDesktop } from "../../apps/desktop/tests/support/electron.ts";
import { identify, sameProcess } from "./process.ts";
import { readSession, runHome, type Session } from "./session-store.ts";
import { readEvidence } from "./evidence-store.ts";
const root = resolve(import.meta.dirname, "../..");
const exec = promisify(execFile);
async function cli(command: string, sessionId?: string, requestId?: string) {
  const args = [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    join(root, "tools/desktop-agent/cli.ts"),
    command,
    "--json",
  ];
  if (sessionId) args.push("--session", sessionId);
  if (requestId) args.push("--request", requestId);
  const result = await exec(process.execPath, args, { cwd: root, timeout: 20000 });
  return JSON.parse(result.stdout).result;
}
async function waitStatus(id: string, expected: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await cli("status", id);
    if (state.status === expected) return state as Session;
    assert.equal(["unknown", "failed"].includes(state.status), false, JSON.stringify(state));
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`会话未进入 ${expected}`);
}
async function waitProcessGone(identity: NonNullable<Session["owner"]>) {
  const deadline = Date.now() + 5000;
  while (sameProcess(identity)) {
    assert.ok(Date.now() < deadline, "原控制进程未退出");
    await new Promise((done) => setTimeout(done, 100));
  }
}
async function ensureStopped(id?: string) {
  if (!id) return;
  const state = await cli("status", id);
  if (state.status !== "stopped") await cli("stop", id);
  await waitStatus(id, "stopped");
}

test("独立客户端续用会话，重启保留数据且代际变化，不影响外部实例", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "marshal-agent-independent-"));
  const independent = await launchDesktop(root, {
    dataDir: join(directory, "data"),
    target: "development",
    mode: "background",
  });
  const page = await independent.firstWindow();
  await page.getByText("核心已连接", { exact: true }).waitFor();
  const independentIdentity = identify(independent.process().pid!)!;
  let id: string | undefined;
  try {
    const requestId = randomUUID();
    const first = await cli("start", undefined, requestId);
    id = first.sessionId;
    assert.equal((await cli("start", undefined, requestId)).sessionId, id);
    const running = await waitStatus(id!, "running");
    assert.equal(running.options.mode, "background");
    const profile = join(runHome(root, running.profileRunId), "data");
    await writeFile(join(profile, "session-sentinel.json"), '{"preserved":true}');
    const restartId = randomUUID();
    await cli("restart", id, restartId);
    const restarted = await waitStatus(id!, "running");
    assert.equal(restarted.generation, running.generation + 1);
    assert.notEqual(restarted.runId, running.runId);
    assert.equal(restarted.profileRunId, running.profileRunId);
    const oldEvidence = await readEvidence(root, running.runId);
    assert.equal(oldEvidence.lifecycle, "closed");
    assert.equal(oldEvidence.assertions, "not-run");
    for (const kind of ["build", "scenario", "log", "health", "observation", "reproduction"])
      assert.ok(
        oldEvidence.artifacts.some((item) => item.kind === kind && item.status === "available"),
        kind,
      );
    const oldBytes = await readFile(join(runHome(root, running.runId), "manifest.json"), "utf8");
    assert.equal(
      await readFile(join(profile, "session-sentinel.json"), "utf8"),
      '{"preserved":true}',
    );
    assert.equal((await cli("restart", id, restartId)).status, "completed");
    assert.equal((await cli("status", id)).generation, restarted.generation);
    await ensureStopped(id);
    assert.equal(sameProcess(independentIdentity), true);
    assert.equal(sameProcess(restarted.application!), false);
    await waitProcessGone(restarted.owner!);
    assert.equal((await page.title()).length > 0, true);
    const saved = await readSession(root, id!);
    assert.equal((await readEvidence(root, restarted.runId)).lifecycle, "closed");
    assert.equal(
      await readFile(join(runHome(root, running.runId), "manifest.json"), "utf8"),
      oldBytes,
    );
    assert.equal(saved.status, "stopped");
    assert.equal(
      await readFile(join(profile, "session-sentinel.json"), "utf8"),
      '{"preserved":true}',
    );
  } finally {
    await ensureStopped(id);
    await independent.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("自有应用异常退出明确记录崩溃，停止只回收原控制进程", { timeout: 60000 }, async () => {
  let id: string | undefined;
  try {
    id = (await cli("start")).sessionId;
    const running = await waitStatus(id!, "running");
    assert.equal(sameProcess(running.application!), true);
    process.kill(running.application!.pid, "SIGKILL");
    await waitStatus(id!, "crashed");
    await ensureStopped(id);
    const evidence = await readEvidence(root, running.runId);
    assert.ok(evidence.primaryFailureId);
    assert.equal(
      evidence.failures.find((item) => item.id === evidence.primaryFailureId)?.kind,
      "crash",
    );
    await waitProcessGone(running.owner!);
  } finally {
    await ensureStopped(id);
  }
});
