import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  actionPath,
  actionSignature,
  previousAction,
  reserveAction,
  saveAction,
  actionStatus,
  type ActionReceipt,
} from "./action-store.ts";
import { newSession, saveSession } from "./session-store.ts";
import { parseRequest, type Input } from "./protocol.ts";
import { identify } from "./process.ts";
import { validateInput } from "./gui-input.ts";
test("动作持久收据不保存输入，重复请求续查，跨参数冲突与代际中断不重放", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-action-store-"));
  try {
    const session = await newSession(root, {
      scenario: "empty",
      seed: "unit",
      mode: "background",
      target: "development",
    });
    session.owner = identify(process.pid);
    session.status = "running";
    await saveSession(root, session);
    const request = parseRequest({
      command: "act",
      sessionId: session.sessionId,
      payload: { snapshotId: randomUUID(), targetRef: "n1", action: "fill", value: "凭据不落盘" },
    });
    const signature = actionSignature(session, request),
      path = await actionPath(root, session, request.requestId);
    const receipt: ActionReceipt = {
      jobId: request.requestId,
      requestId: request.requestId,
      sessionId: session.sessionId,
      runId: session.runId,
      snapshotId: (request.payload as Input<"act">).snapshotId,
      action: "fill",
      inputStatus: "sending",
      status: "running",
      inputValueRecorded: false,
    };
    await reserveAction(path, signature, receipt);
    assert.equal((await previousAction(path, signature))!.jobId, request.requestId);
    await assert.rejects(previousAction(path, signature + "x"), /同一请求/);
    assert.equal((await readFile(path, "utf8")).includes("凭据不落盘"), false);
    assert.notEqual(signature, actionSignature({ ...session, token: "其他会话" }, request));
    session.runId = randomUUID();
    await saveSession(root, session);
    const interrupted = await actionStatus(root, session.sessionId, request.requestId);
    assert.equal(interrupted.status, "unknown");
    assert.equal(interrupted.inputStatus, "unknown");
    receipt.status = "completed";
    receipt.inputStatus = "sent";
    await saveAction(path, signature, receipt);
    assert.equal(
      (await actionStatus(root, session.sessionId, request.requestId)).status,
      "completed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("按键、动作值与尚未接入的坐标请求有明确准入", () => {
  const input = (payload: object) =>
    parseRequest({
      command: "act",
      payload: { snapshotId: randomUUID(), targetRef: "n1", ...payload },
    }).payload as Input<"act">;
  assert.throws(() => validateInput(input({ action: "fill" })), /缺少有效参数/);
  assert.throws(() => validateInput(input({ action: "check", value: "true" })), /缺少有效参数/);
  assert.throws(
    () => validateInput(input({ action: "key", value: "ControlOrMeta+Q" })),
    /按键不在受限/,
  );
  assert.throws(() => validateInput(input({ action: "scroll", value: "任意代码" })), /滚动方向/);
  assert.throws(
    () => validateInput(input({ action: "click", position: { x: 10, y: 20 } })),
    /坐标动作尚未接入/,
  );
  assert.doesNotThrow(() => validateInput(input({ action: "key", value: "Enter" })));
});
