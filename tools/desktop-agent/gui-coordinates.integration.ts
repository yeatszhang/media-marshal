import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { guiRoot as root, setupGui, observeInput } from "./gui-test-support.ts";
import { GuiActions } from "./gui-actions.ts";
import { actionStatus } from "./action-store.ts";
import { saveSession, runHome } from "./session-store.ts";
import { parseRequest } from "./protocol.ts";
import type { AvailableImage } from "./gui-image.ts";
type Context = Awaited<ReturnType<typeof setupGui>>;
async function fixture(context: Context) {
  await context.page.evaluate(() => {
    const tile = document.createElement("div");
    tile.id = "visual-tile";
    tile.setAttribute("aria-hidden", "true");
    tile.style.cssText =
      "position:fixed;left:300px;top:100px;width:120px;height:60px;background:#375aca;color:white;z-index:10000;display:grid;place-items:center";
    tile.textContent = "视觉点击区域";
    const result = document.createElement("div");
    result.setAttribute("role", "status");
    result.setAttribute("aria-label", "视觉结果");
    result.textContent = "未触发";
    tile.addEventListener("click", () => {
      const count = Number(tile.dataset.clicks ?? 0) + 1;
      tile.dataset.clicks = String(count);
      result.textContent = `已触发${count}`;
    });
    document.body.append(tile, result);
  });
}
async function observe(context: Context, options: object = {}) {
  const observed = await context.gui.observe(observeInput({ image: true, ...options }));
  assert.ok("image" in observed && observed.image.status === "available", JSON.stringify(observed));
  return observed as { snapshotId: string; image: AvailableImage };
}
async function run(
  context: Context,
  actions: GuiActions,
  observed: { snapshotId: string; image: AvailableImage },
  extra: object = {},
) {
  const receipt = await actions.start(
    parseRequest({
      command: "act",
      sessionId: context.session.sessionId,
      payload: {
        snapshotId: observed.snapshotId,
        imageId: observed.image.imageId,
        position: { x: 360, y: 130 },
        action: "click",
        after: { target: { role: "status", name: "视觉结果" }, state: "text", value: "已触发" },
        ...extra,
      },
    }),
  );
  const deadline = Date.now() + 25000;
  while (actions.busy) {
    assert.ok(Date.now() < deadline);
    await new Promise((done) => setTimeout(done, 50));
  }
  return actionStatus(root, context.session.sessionId, receipt.jobId);
}
async function close(context: Context) {
  await context.app.close();
  context.session.status = "stopped";
  await saveSession(root, context.session);
}
async function nativeReady(context: Context, actions: GuiActions, test: TestContext) {
  const probe = spawnSync(
    join(root, "tools/desktop-agent/.build/native-helper"),
    ["capabilities"],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(probe.status, 0);
  if (JSON.parse(probe.stdout).sessionLocked !== true) return true;
  const before = await observe(context);
  const receipt = await run(context, actions, before);
  assert.equal(receipt.status, "blocked");
  assert.equal((receipt.error as { code: string }).code, "NATIVE_SESSION_LOCKED");
  assert.equal(receipt.inputStatus, "not-sent");
  assert.equal(await context.page.locator("#visual-tile").getAttribute("data-clicks"), null);
  await writeFile(
    join(runHome(root, context.session.runId), "native-validation.json"),
    JSON.stringify({
      status: "blocked",
      reason: "NATIVE_SESSION_LOCKED",
      positiveNativeAssertions: "not-run",
      receipt,
    }),
    { mode: 0o600 },
  );
  test.skip("macOS 当前锁屏；已验证拒绝输入，前台成功与真实遮挡断言未运行");
  return false;
}
test("后台图像坐标与裁剪／设备比例，动作前后图像及语义关联", { timeout: 90000 }, async () => {
  const context = await setupGui(),
    actions = new GuiActions(root, context.session, context.gui);
  try {
    await fixture(context);
    const first = await observe(context);
    const clicked = await run(context, actions, first);
    assert.equal(clicked.status, "completed", JSON.stringify(clicked));
    assert.equal(await context.page.locator("#visual-tile").getAttribute("data-clicks"), "1");
    const proof = clicked.result as {
      coordinate: {
        beforeImage: { path: string };
        point: { nativeInputSent: boolean; inputScope: string };
        visibility: { mode: string };
      };
      afterObservation: { snapshotId: string; image: AvailableImage };
    };
    assert.equal(proof.coordinate.point.inputScope, "renderer-viewport");
    assert.equal(proof.coordinate.point.nativeInputSent, false);
    assert.equal(proof.coordinate.visibility.mode, "background-virtual");
    assert.ok((await readFile(proof.coordinate.beforeImage.path)).length > 2000);
    assert.equal(proof.afterObservation.image.status, "available");
    assert.equal(proof.afterObservation.snapshotId, proof.afterObservation.image.snapshotId);
    const cropped = await observe(context, {
      clip: { x: 300, y: 100, width: 120, height: 60 },
      scale: "device",
    });
    const second = await run(context, actions, cropped, {
      position: { x: cropped.image.pixelWidth / 2, y: cropped.image.pixelHeight / 2 },
    });
    assert.equal(second.status, "completed", JSON.stringify(second));
    assert.equal(await context.page.locator("#visual-tile").getAttribute("data-clicks"), "2");
    console.log(
      JSON.stringify({
        runId: context.session.runId,
        before: first.image.path,
        after: proof.afterObservation.image.path,
      }),
    );
  } finally {
    await close(context);
  }
});
test(
  "越界、图像篡改、窗口移动／缩放／焦点与 DOM 遮挡拒绝，不发送点击",
  { timeout: 90000 },
  async () => {
    const context = await setupGui(),
      actions = new GuiActions(root, context.session, context.gui);
    try {
      await fixture(context);
      const first = await observe(context);
      const outside = await run(context, actions, first, {
        position: { x: first.image.pixelWidth, y: 0 },
      });
      assert.equal(outside.status, "blocked");
      assert.equal(outside.inputStatus, "not-sent");
      const mismatch = await observe(context);
      const wrongImage = await run(context, actions, mismatch, { imageId: first.image.imageId });
      assert.equal(wrongImage.status, "blocked");
      const changed = await observe(context);
      await writeFile(changed.image.path, "隔离图片已修改");
      const tampered = await run(context, actions, changed);
      assert.equal((tampered.error as { code: string }).code, "GUI_IMAGE_CHANGED");
      for (const mutate of [
        () =>
          context.app.evaluate(({ BrowserWindow }) => {
            const w = BrowserWindow.getAllWindows()[0]!;
            const [x, y] = w.getPosition();
            w.setPosition(x! + 10, y! + 10);
          }),
        () =>
          context.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.setSize(1000, 700),
          ),
        () => context.page.getByRole("link", { name: "设置", exact: true }).focus(),
        () =>
          context.page.evaluate(() => {
            const cover = document.createElement("div");
            cover.style.cssText = "position:fixed;inset:0;background:white;z-index:20000";
            document.body.append(cover);
          }),
      ]) {
        const before = await observe(context);
        await mutate();
        const result = await run(context, actions, before);
        assert.equal(result.status, "blocked", JSON.stringify(result));
        assert.equal(result.inputStatus, "not-sent");
      }
      assert.equal(await context.page.locator("#visual-tile").getAttribute("data-clicks"), null);
    } finally {
      await close(context);
    }
  },
);
test(
  "macOS 前台窗口次序与真实遮挡，只读原生元数据不采集其他应用画面",
  { timeout: 90000, skip: process.platform !== "darwin" },
  async (test) => {
    const context = await setupGui("foreground"),
      actions = new GuiActions(root, context.session, context.gui);
    try {
      await fixture(context);
      if (!(await nativeReady(context, actions, test))) return;
      await context.app.evaluate(({ app, BrowserWindow }) => {
        app.show();
        app.focus({ steal: true });
        const window = BrowserWindow.getAllWindows()[0]!;
        window.show();
        window.focus();
      });
      const visible = await observe(context);
      const success = await run(context, actions, visible);
      assert.equal(success.status, "completed", JSON.stringify(success));
      const proof = success.result as {
        coordinate: {
          visibility: {
            source: string;
            frontmost: boolean;
            occluded: boolean;
            pointOwned: boolean;
            hitTest: string;
          };
        };
      };
      assert.equal(proof.coordinate.visibility.source, "native-window-metadata");
      assert.equal(proof.coordinate.visibility.frontmost, true);
      assert.equal(proof.coordinate.visibility.occluded, false);
      assert.equal(proof.coordinate.visibility.pointOwned, true);
      assert.equal(proof.coordinate.visibility.hitTest, "accessibility-window-z-order");
      const identity = {
        pid: context.app.process().pid,
        executable: await context.app.evaluate(() => process.execPath),
        profile: join(runHome(root, context.session.profileRunId), "data"),
      };
      const invalidGeneration = spawnSync(
        join(root, "tools/desktop-agent/.build/native-helper"),
        [],
        {
          input: JSON.stringify({ ...identity, command: "window-state", generation: "0:0" }),
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.equal(invalidGeneration.status, 2);
      assert.equal(JSON.parse(invalidGeneration.stdout).error.code, "GENERATION_MISMATCH");
      const before = await observe(context);
      await context.app.evaluate(({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows()[0]!,
          bounds = main.getBounds();
        const cover = new BrowserWindow({
          x: bounds.x + 250,
          y: bounds.y + 80,
          width: 220,
          height: 160,
          frame: false,
          focusable: false,
          show: true,
          alwaysOnTop: true,
        });
        void cover.loadURL("about:blank");
      });
      const occluded = await run(context, actions, before);
      assert.equal(occluded.status, "blocked", JSON.stringify(occluded));
      assert.equal((occluded.error as { code: string }).code, "GUI_WINDOW_OCCLUDED");
      assert.equal(await context.page.locator("#visual-tile").getAttribute("data-clicks"), "1");
    } finally {
      await close(context);
    }
  },
);

test("窗口重建后的同位置与旧图片没有操作权，前后窗口身份明确区分", { timeout: 60000 }, async () => {
  const context = await setupGui(),
    actions = new GuiActions(root, context.session, context.gui);
  try {
    await fixture(context);
    const before = await observe(context);
    const original = (await context.gui.windows.list())[0]!.windowId;
    const opened = context.app.waitForEvent("window");
    await context.app.evaluate(({ BrowserWindow, app }) => {
      BrowserWindow.getAllWindows()[0]!.destroy();
      app.emit("activate");
    });
    context.page = await opened;
    await context.page.getByText("核心已连接", { exact: true }).waitFor();
    const result = await run(context, actions, before);
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(result.inputStatus, "not-sent");
    const after = result.result as { afterObservation: { status: string; windowId: string } };
    assert.equal(after.afterObservation.status, "available");
    assert.notEqual(after.afterObservation.windowId, original);
  } finally {
    await close(context);
  }
});
