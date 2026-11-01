import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { launchDesktop } from "../../apps/desktop/tests/support/electron.ts";
import { GuiObserver } from "./gui-observe.ts";
import { assertBuild } from "./build.ts";
import { newSession, runHome, saveSession, type Session } from "./session-store.ts";
import { identify } from "./process.ts";
import { parseRequest, type Input } from "./protocol.ts";
import { dispatch } from "./cli.ts";

const root = resolve(import.meta.dirname, "../..");
const input = (payload: object = {}) =>
  parseRequest({ command: "observe", payload }).payload as Input<"observe">;
async function setup() {
  const build = await assertBuild(root, "development");
  const session = await newSession(root, {
    scenario: "empty",
    seed: "gui",
    mode: "background",
    target: "development",
  });
  session.buildId = build.buildId;
  const app = await launchDesktop(root, {
    ...session.options,
    dataDir: join(runHome(root, session.runId), "data"),
    diagnostics: { sessionId: session.sessionId, runId: session.runId, buildId: build.buildId },
  });
  session.application = identify(app.process().pid!);
  session.owner = identify(process.pid);
  session.status = "running";
  await saveSession(root, session);
  const page = await app.firstWindow();
  await page.getByText("核心已连接", { exact: true }).waitFor();
  return { app, page, session, gui: new GuiObserver(root, app, session) };
}
test(
  "真实主导航、表单语义与分页，输入遮罩、焦点、重复名称和错误弹层",
  { timeout: 60000 },
  async () => {
    const { app, page, session, gui } = await setup();
    try {
      const windows = await gui.windows.list();
      assert.equal(windows.length, 1);
      assert.equal(windows[0]!.observable, true);
      const first = await gui.capture();
      assert.ok(first.snapshot.nodes.some((n) => n.role === "link" && n.name?.includes("设置")));
      await page.getByRole("link", { name: "设置", exact: true }).click();
      await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
      await assert.rejects(gui.current(first.snapshot.snapshotId), /旧引用失效/);
      await page.evaluate(() => {
        const section = document.createElement("section");
        section.id = "agent-fixture";
        section.innerHTML = `<div role="dialog" aria-label="隔离错误核对">
        <label>私密输入<input value="fixture-secret-value"></label>
        <button disabled>重复保存</button><button>重复保存</button><button></button>
        <div role="alert">必须选择目录</div></div>`;
        document.body.append(section);
      });
      await page.getByLabel("私密输入", { exact: true }).focus();
      const snapshot = await gui.capture();
      const body = snapshot.snapshot;
      assert.equal(JSON.stringify(body).includes("fixture-secret-value"), false);
      const text = body.nodes.find((n) => n.name === "私密输入")!;
      assert.equal(text.valueMasked, true);
      assert.equal(text.state.active, true);
      const duplicates = body.nodes.filter((n) => n.name === "重复保存");
      assert.equal(duplicates.length, 2);
      assert.ok(duplicates.every((n) => n.duplicateName));
      assert.equal(duplicates[0]!.state.disabled, true);
      for (const node of duplicates) {
        const target = snapshot.targets.get(node.ref)!;
        const locator = page.locator(`aria-ref=${target}`);
        assert.equal(await locator.count(), 1);
        assert.equal(await locator.textContent(), node.name);
      }
      assert.ok(body.nodes.some((n) => n.role === "button" && !n.name && !n.actionable));
      const pageOne = await gui.observe(input({ snapshotId: body.snapshotId, limit: 5 }));
      assert.equal("nodes" in pageOne && pageOne.nodes.length, 5);
      const pageTwo = await gui.observe(
        input({ snapshotId: body.snapshotId, cursor: 5, limit: 5 }),
      );
      assert.equal("nodes" in pageTwo && pageTwo.nodes[0]!.ref, body.nodes[5]!.ref);
      assert.ok("dialogs" in pageOne && pageOne.dialogs.length > 0);
      assert.ok("alerts" in pageOne && pageOne.alerts.length > 0);
      const region = body.nodes.find((n) => n.name === "隔离错误核对")!;
      const area = await gui.observe(input({ snapshotId: body.snapshotId, regionRef: region.ref }));
      assert.ok("nodes" in area && area.nodes.every((n) => n.depth >= region.depth));
      await assert.rejects(gui.observe(input({ cursor: 5 })), /需要原 snapshotId/);
      const saved = await readFile(
        join(runHome(root, session.runId), `aria-${body.snapshotId}.json`),
        "utf8",
      );
      assert.equal(saved.includes("fixture-secret-value"), false);
      await page.reload();
      await page.getByText("核心已连接", { exact: true }).waitFor();
      await assert.rejects(gui.current(body.snapshotId), /旧引用失效/);
      const reloaded = await gui.capture();
      assert.notEqual(reloaded.snapshot.document.documentId, body.document.documentId);
      assert.equal(reloaded.snapshot.window.windowId, body.window.windowId);
      assert.ok(reloaded.snapshot.window.generation > body.window.generation);
    } finally {
      await app.close();
      session.status = "stopped";
      await saveSession(root, session);
    }
  },
);
test("布局、跨窗口身份与敏感上下文拒绝，CLI 只观察自有会话", { timeout: 60000 }, async () => {
  const { app, page, session, gui } = await setup();
  try {
    const first = await gui.capture();
    await assert.rejects(gui.current(first.snapshot.snapshotId, "其他窗口"), /旧引用失效/);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640));
    await assert.rejects(gui.current(first.snapshot.snapshotId), /旧引用失效/);
    await page.evaluate(() => document.body.setAttribute("data-agent-sensitive", "true"));
    await assert.rejects(gui.capture(), /敏感上下文禁止采集/);
    await page.evaluate(() => document.body.removeAttribute("data-agent-sensitive"));
    const iframe = await page.evaluateHandle(() => {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      return frame;
    });
    await assert.rejects(gui.capture(), /嵌入页面/);
    await iframe.evaluate((element) => element.remove());
  } finally {
    await app.close();
    session.status = "stopped";
    await saveSession(root, session);
  }
  const state = (await dispatch(parseRequest({ command: "start" }))) as Session;
  try {
    const deadline = Date.now() + 30000;
    while (
      ((await dispatch(parseRequest({ command: "status", sessionId: state.sessionId }))) as Session)
        .status !== "running"
    ) {
      assert.ok(Date.now() < deadline);
      await new Promise((done) => setTimeout(done, 100));
    }
    const observed = await dispatch(
      parseRequest({ command: "observe", sessionId: state.sessionId }),
    );
    assert.equal((observed as { sessionId: string }).sessionId, state.sessionId);
    assert.ok((observed as { nodes: unknown[] }).nodes.length > 0);
  } finally {
    await dispatch(parseRequest({ command: "stop", sessionId: state.sessionId }));
    const deadline = Date.now() + 30000;
    while (
      ((await dispatch(parseRequest({ command: "status", sessionId: state.sessionId }))) as Session)
        .status !== "stopped"
    ) {
      assert.ok(Date.now() < deadline);
      await new Promise((done) => setTimeout(done, 100));
    }
  }
});
