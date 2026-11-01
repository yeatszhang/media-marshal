import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { dispatch } from "./cli.ts";
import { parseRequest, scenario } from "./protocol.ts";
import { readSession, runHome, type Session } from "./session-store.ts";
import { sameProcess } from "./process.ts";
import { sceneBytes } from "./scenarios.ts";

const root = resolve(import.meta.dirname, "../..");
const exec = promisify(execFile);
const electron = createRequire(import.meta.url)("electron") as string;
const send = (command: string, sessionId?: string, payload = {}, requestId = randomUUID()) =>
  dispatch(parseRequest({ command, sessionId, payload, requestId }));
async function waitStatus(id: string, expected: string): Promise<Session> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const state = (await send("status", id)) as Session;
    if (state.status === expected) return state;
    assert.equal(
      ["unknown", "failed", "blocked", "crashed"].includes(state.status),
      false,
      JSON.stringify({ status: state.status, error: state.error, runId: state.runId }),
    );
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`会话 ${id} 未进入 ${expected}`);
}
async function stop(id: string) {
  const before = await readSession(root, id);
  if (["failed", "blocked", "unknown"].includes(before.status)) return;
  await send("stop", id);
  await waitStatus(id, "stopped");
  if (before.application) assert.equal(sameProcess(before.application), false);
}
async function rejectLiveSeed(id: string) {
  try {
    await exec(
      electron,
      ["--experimental-strip-types", join(root, "tools/desktop-agent/seed-worker.ts"), id],
      { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15000 },
    );
    assert.fail("活跃数据库不应被直接准备");
  } catch (error) {
    const output = JSON.parse((error as { stdout: string }).stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.error.code, "SCENARIO_LIVE_WRITER");
  }
}

for (const name of scenario.options) {
  test(`${name} 同 seed 后置条件一致、隔离且拒绝活跃改库`, { timeout: 150000 }, async () => {
    const sessions: string[] = [];
    const observations: unknown[] = [];
    const profiles: string[] = [];
    try {
      for (let repetition = 0; repetition < 2; repetition++) {
        const requestId = randomUUID();
        const payload = { mode: "run", name, seed: "repeatable-中文" };
        const initial = (await send("scenario", undefined, payload, requestId)) as Session;
        sessions.push(initial.sessionId);
        assert.equal(
          ((await send("scenario", undefined, payload, requestId)) as Session).sessionId,
          initial.sessionId,
        );
        await assert.rejects(send("start", undefined, {}, requestId), /同一请求已用于不同/);
        const state = await waitStatus(initial.sessionId, "running");
        const directory = runHome(root, state.profileRunId);
        profiles.push(directory);
        const evidence = JSON.parse(
          await readFile(join(runHome(root, state.runId), "scenario-check.json"), "utf8"),
        );
        assert.equal(evidence.passed, true);
        assert.equal(evidence.buildId, state.buildId);
        observations.push(evidence.observed);
        if (name !== "empty") {
          const manifest = JSON.parse(await readFile(join(directory, "scenario.json"), "utf8"));
          for (const path of Object.values(manifest.paths) as string[]) {
            const part = relative(directory, path);
            assert.ok(part && !part.startsWith("..") && !part.startsWith("/"));
          }
          assert.deepEqual(
            await readFile(join(manifest.paths.input, "合成电影.2026.mp4")),
            sceneBytes(name, payload.seed),
          );
        }
        await rejectLiveSeed(state.sessionId);
        await assert.rejects(
          send("scenario", state.sessionId, payload),
          /不能向现有会话直接写入场景/,
        );
        assert.equal((await readSession(root, state.sessionId)).generation, 1);
        if (repetition === 0) {
          await writeFile(join(directory, "data/scenario-sentinel.json"), '{"preserved":true}');
          await send("restart", state.sessionId);
          const restarted = await waitStatus(state.sessionId, "running");
          assert.equal(restarted.generation, 2);
          assert.notEqual(restarted.runId, state.runId);
          assert.equal(restarted.profileRunId, state.profileRunId);
          assert.equal(
            await readFile(join(directory, "data/scenario-sentinel.json"), "utf8"),
            '{"preserved":true}',
          );
          const check = JSON.parse(
            await readFile(join(runHome(root, restarted.runId), "scenario-check.json"), "utf8"),
          );
          assert.equal(check.status, "not-run");
        }
        await stop(state.sessionId);
      }
      assert.notEqual(profiles[0], profiles[1]);
      assert.deepEqual(observations[0], observations[1]);
    } finally {
      for (const id of sessions) await stop(id);
    }
  });
}
