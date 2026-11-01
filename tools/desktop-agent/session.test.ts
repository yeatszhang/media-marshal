import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  newSession,
  publicSession,
  inspectSession,
  readSession,
  saveSession,
} from "./session-store.ts";
import { serveController, callController } from "./transport.ts";
import { parseRequest } from "./protocol.ts";
import { sessionCommand } from "./session.ts";
import { identify } from "./process.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marshal-agent-session-"));
  const session = await newSession(root, {
    scenario: "empty",
    seed: "default",
    mode: "background",
    target: "development",
  });
  return { root, session, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test("会话身份与输出不暴露控制凭证，PID 复用和过期启动不算存活", async () => {
  const f = await fixture();
  try {
    assert.equal(Object.hasOwn(publicSession(f.session), "token"), false);
    assert.equal(Buffer.byteLength(f.session.socket) < 104, true);
    f.session.createdAt = "2000-01-01T00:00:00.000Z";
    assert.equal(inspectSession(f.session).status, "unknown");
    f.session.owner = { pid: 123, parent: 1, created: "旧时间", command: "旧命令" };
    f.session.status = "running";
    assert.equal(inspectSession(f.session, () => false).status, "unknown");
    f.session.application = { ...f.session.owner, pid: 456 };
    assert.equal(inspectSession(f.session, (value) => value.pid === 123).status, "crashed");
    f.session.status = "stopped";
    assert.equal(
      inspectSession(f.session, () => {
        throw new Error("停止记录不探测其他进程");
      }).status,
      "stopped",
    );
    await saveSession(f.root, f.session);
    assert.equal((await readSession(f.root, f.session.sessionId)).status, "stopped");
  } finally {
    await f.cleanup();
  }
});
test("崩溃恢复拒绝未知控制进程、仍存活的应用 PID 和不完整身份，不接管或重放", async () => {
  const f = await fixture();
  const own = identify(process.pid)!;
  const restart = parseRequest({ command: "restart", sessionId: f.session.sessionId });
  try {
    f.session.status = "crashed";
    f.session.owner = { ...own, created: "旧代际" };
    f.session.application = own;
    await saveSession(f.root, f.session);
    await assert.rejects(sessionCommand(f.root, restart), { code: "SESSION_UNAVAILABLE" });
    f.session.owner = own;
    await saveSession(f.root, f.session);
    await assert.rejects(sessionCommand(f.root, restart), { code: "APPLICATION_EXIT_UNCONFIRMED" });
    delete f.session.application;
    await saveSession(f.root, f.session);
    await assert.rejects(sessionCommand(f.root, restart), { code: "APPLICATION_EXIT_UNCONFIRMED" });
  } finally {
    await f.cleanup();
  }
});
test("控制连接限定当前会话及令牌，客户端断开后仍可查询", async () => {
  const f = await fixture();
  let calls = 0;
  const server = await serveController(f.session, async (request) => {
    calls++;
    return { requestId: request.requestId };
  });
  try {
    const request = parseRequest({ command: "status", sessionId: f.session.sessionId });
    const first = await callController(f.session, request);
    assert.equal((first as { requestId: string }).requestId, request.requestId);
    await callController(f.session, request);
    assert.equal(calls, 2);
    await assert.rejects(callController({ ...f.session, token: "invalid" }, request), /身份不符/);
    await assert.rejects(
      callController(f.session, { ...request, sessionId: randomUUID() }),
      /不属于/,
    );
    assert.equal(calls, 2);
    if (process.platform !== "win32")
      assert.equal((await stat(f.session.socket)).mode & 0o777, 0o600);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await f.cleanup();
  }
});
