import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { guiRoot as root, setupGui } from "./gui-test-support.ts";
import { GuiActions } from "./gui-actions.ts";
import { actionPath, actionStatus, type ActionReceipt } from "./action-store.ts";
import { saveSession, type Session } from "./session-store.ts";
import { parseRequest, type Input } from "./protocol.ts";
import { dispatch } from "./cli.ts";

type Context = Awaited<ReturnType<typeof setupGui>>;
async function waitReceipt(context: Context, actions: GuiActions, jobId: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await actionStatus(root, context.session.sessionId, jobId);
    if (!actions.busy && result.status !== "running") return result;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("动作收据未收敛");
}
async function perform(
  context: Context,
  actions: GuiActions,
  payload: object,
  requestId = randomUUID(),
) {
  const handle = await context.gui.capture();
  const request = parseRequest({
    command: "act",
    requestId,
    sessionId: context.session.sessionId,
    payload: { snapshotId: handle.snapshot.snapshotId, ...payload },
  });
  const accepted = await actions.start(request);
  return { receipt: await waitReceipt(context, actions, accepted.jobId), request };
}
async function close(context: Context) {
  await context.app.close();
  context.session.status = "stopped";
  await saveSession(root, context.session);
}
test("真实导航与受限表单操作，独立条件等待及无明文收据", { timeout: 90000 }, async () => {
  const context = await setupGui(),
    actions = new GuiActions(root, context.session, context.gui);
  const { page } = context;
  try {
    const navigation = await perform(context, actions, {
      action: "click",
      target: { role: "link", name: "设置" },
      after: { target: { role: "heading", name: "设置" }, state: "visible" },
    });
    assert.equal(navigation.receipt.status, "completed", JSON.stringify(navigation.receipt));
    await page.evaluate(() => {
      const section = document.createElement("div");
      section.style.cssText =
        "position:fixed;left:300px;top:80px;background:white;padding:10px;z-index:10000";
      section.innerHTML = `<label>合成输入<input></label><label>合成选择<select><option value="a">甲</option><option value="b">乙</option></select></label><label>合成勾选<input type="checkbox"></label><button>合成提交</button><button disabled>等待就绪</button><div role="region" aria-label="滚动区域" style="height:80px;overflow:auto"><div style="height:800px">滚动内容</div></div>`;
      document.body.append(section);
    });
    const fill = await perform(context, actions, {
      action: "fill",
      target: { role: "textbox", name: "合成输入" },
      value: "fixture-action-secret",
      after: {
        target: { role: "textbox", name: "合成输入" },
        state: "value",
        value: "fixture-action-secret",
      },
    });
    assert.equal(fill.receipt.status, "completed", JSON.stringify(fill.receipt));
    const stored = await readFile(
      await actionPath(root, context.session, fill.receipt.requestId),
      "utf8",
    );
    assert.equal(stored.includes("fixture-action-secret"), false);
    for (const payload of [
      {
        action: "select",
        target: { role: "combobox", name: "合成选择" },
        value: "b",
        after: { target: { role: "combobox", name: "合成选择" }, state: "value", value: "b" },
      },
      {
        action: "check",
        target: { role: "checkbox", name: "合成勾选" },
        value: true,
        after: { target: { role: "checkbox", name: "合成勾选" }, state: "checked", value: true },
      },
      { action: "key", target: { role: "textbox", name: "合成输入" }, value: "Enter" },
      { action: "scroll", target: { role: "region", name: "滚动区域" }, value: "down" },
    ]) {
      const result = await perform(context, actions, payload);
      assert.equal(result.receipt.status, "completed", JSON.stringify(result.receipt));
    }
    assert.ok(
      (await page
        .getByRole("region", { name: "滚动区域" })
        .evaluate((element) => element.scrollTop)) > 0,
    );
    const handle = await context.gui.capture();
    await page.evaluate(() => {
      setTimeout(() => {
        const button = [...document.querySelectorAll("button")].find(
          (b) => b.textContent === "等待就绪",
        )!;
        button.disabled = false;
      }, 300);
    });
    const waited = await actions.wait(
      parseRequest({
        command: "wait",
        payload: {
          snapshotId: handle.snapshot.snapshotId,
          target: { role: "button", name: "等待就绪" },
          state: "enabled",
        },
      }).payload as Input<"wait">,
    );
    assert.equal(waited.status, "passed");
  } finally {
    await close(context);
  }
});

async function until<T>(read: () => Promise<T>, accepted: (value: T) => boolean) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepted(value)) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("控制器状态未收敛");
}
test("统一命令可查询动作作业，重启和停止后原收据不重放", { timeout: 90000 }, async () => {
  const session = (await dispatch(parseRequest({ command: "start" }))) as Session;
  const send = (command: string, payload = {}, requestId = randomUUID()) =>
    dispatch(parseRequest({ command, sessionId: session.sessionId, payload, requestId }));
  try {
    await until(
      () => send("status") as Promise<Session>,
      (state) => state.status === "running",
    );
    const observed = (await send("observe")) as { snapshotId: string };
    const requestId = randomUUID(),
      payload = {
        snapshotId: observed.snapshotId,
        action: "click",
        target: { role: "link", name: "设置" },
        after: { target: { role: "heading", name: "设置" }, state: "visible" },
      };
    const accepted = (await send("act", payload, requestId)) as ActionReceipt;
    const result = await until(
      () => send("status", { jobId: accepted.jobId }) as Promise<ActionReceipt>,
      (receipt) => receipt.status !== "running",
    );
    assert.equal(result.status, "completed", JSON.stringify(result));
    await send("restart");
    const restarted = await until(
      () => send("status") as Promise<Session>,
      (state) => state.status === "running",
    );
    assert.notEqual(restarted.runId, result.runId);
    const before = await send("observe");
    assert.equal(((await send("act", payload, requestId)) as ActionReceipt).status, "completed");
    const after = await send("observe");
    assert.deepEqual((before as { nodes: unknown[] }).nodes, (after as { nodes: unknown[] }).nodes);
    await send("stop");
    await until(
      () => send("status") as Promise<Session>,
      (state) => state.status === "stopped",
    );
    assert.equal(
      ((await send("status", { jobId: accepted.jobId })) as ActionReceipt).status,
      "completed",
    );
  } finally {
    if (((await send("status")) as Session).status !== "stopped") await send("stop");
    await until(
      () => send("status") as Promise<Session>,
      (state) => state.status === "stopped",
    );
  }
});
test(
  "歧义、禁用与重载引用拒绝；超时结果未知，原请求查询绝不再次确认",
  { timeout: 90000 },
  async () => {
    const context = await setupGui(),
      actions = new GuiActions(root, context.session, context.gui);
    const { page } = context;
    try {
      await page.evaluate(() => {
        const section = document.createElement("div");
        section.style.cssText =
          "position:fixed;left:300px;top:100px;background:white;z-index:10000";
        section.innerHTML =
          '<button>重复动作</button><button>重复动作</button><button disabled>禁用动作</button><button id="once">只确认一次</button><div role="status" aria-label="结果">仍在等待</div>';
        document.body.append(section);
        section.querySelector("#once")!.addEventListener("click", () => {
          const button = section.querySelector("#once")!;
          button.setAttribute(
            "data-clicks",
            String(Number(button.getAttribute("data-clicks") ?? 0) + 1),
          );
        });
      });
      for (const [name, code] of [
        ["重复动作", "GUI_TARGET_AMBIGUOUS"],
        ["禁用动作", "GUI_TARGET_DISABLED"],
      ]) {
        const result = await perform(context, actions, {
          action: "click",
          target: { role: "button", name },
        });
        assert.equal(result.receipt.status, "blocked");
        assert.equal((result.receipt.error as { code: string }).code, code);
        assert.equal(result.receipt.inputStatus, "not-sent");
      }
      const timeout = await perform(context, actions, {
        action: "click",
        target: { role: "button", name: "只确认一次" },
        timeoutMs: 300,
        after: { target: { role: "status", name: "结果" }, state: "text", value: "完成" },
      });
      assert.equal(timeout.receipt.status, "unknown", JSON.stringify(timeout.receipt));
      assert.equal(timeout.receipt.inputStatus, "sent");
      assert.equal((await actions.start(timeout.request)).status, "unknown");
      assert.equal(await page.locator("#once").getAttribute("data-clicks"), "1");
      const actualBuild = context.session.buildId;
      context.session.buildId = "old-build-fixture";
      const oldBuild = await perform(context, actions, {
        action: "click",
        target: { role: "button", name: "只确认一次" },
      });
      context.session.buildId = actualBuild;
      assert.equal(oldBuild.receipt.status, "blocked");
      assert.equal((oldBuild.receipt.error as { code: string }).code, "SESSION_BUILD_STALE");
      assert.equal(await page.locator("#once").getAttribute("data-clicks"), "1");
      await assert.rejects(
        actions.start({
          ...timeout.request,
          payload: { ...timeout.request.payload, action: "fill" },
        } as typeof timeout.request),
        /同一请求/,
      );
      const old = await context.gui.capture();
      await page.reload();
      await page.getByText("核心已连接", { exact: true }).waitFor();
      const accepted = await actions.start(
        parseRequest({
          command: "act",
          sessionId: context.session.sessionId,
          payload: {
            snapshotId: old.snapshot.snapshotId,
            target: { role: "link", name: "设置" },
            action: "click",
          },
        }),
      );
      const stale = await waitReceipt(context, actions, accepted.jobId);
      assert.equal(stale.status, "blocked");
      assert.equal(stale.inputStatus, "not-sent");
      assert.equal((stale.error as { code: string }).code, "GUI_SNAPSHOT_STALE");
    } finally {
      await close(context);
    }
  },
);
