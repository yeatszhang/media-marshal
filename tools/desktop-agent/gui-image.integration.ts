import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { closeGui, guiRoot as root, observeInput as input, setupGui } from "./gui-test-support.ts";
import { captureImage } from "./gui-image.ts";
import { runHome } from "./session-store.ts";

test("真实常用／最小窗口截图、元素与矩形裁剪，缩放身份绑定", { timeout: 60000 }, async () => {
  const { app, page, session, gui, collector } = await setupGui();
  try {
    const common = await gui.capture();
    const image = await captureImage(root, session, gui, common, input({ image: true }));
    assert.equal(image.status, "available", JSON.stringify(image));
    if (!("path" in image)) assert.fail("截图缺失");
    const bytes = await readFile(image.path);
    assert.ok(bytes.length > 2000);
    assert.equal(image.snapshotId, common.snapshot.snapshotId);
    assert.equal(image.runId, common.snapshot.runId);
    assert.equal(image.pixelWidth, common.snapshot.document.viewport.width);
    const node = common.snapshot.nodes.find(
      (n) => n.role === "heading" && n.box && n.box.width > 0,
    )!;
    const element = await captureImage(
      root,
      session,
      gui,
      common,
      input({ image: true, regionRef: node.ref }),
    );
    assert.equal(element.status, "available", JSON.stringify(element));
    const rectangle = await captureImage(
      root,
      session,
      gui,
      common,
      input({ image: true, clip: { x: 0, y: 0, width: 320, height: 200 } }),
    );
    assert.equal(rectangle.status, "available");
    assert.ok("pixelWidth" in rectangle && rectangle.pixelWidth === 320);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640));
    await assert.rejects(gui.current(common.snapshot.snapshotId), /旧引用失效/);
    const minimum = await gui.observe(input({ image: true }));
    assert.ok("image" in minimum && minimum.image.status === "available", JSON.stringify(minimum));
    const beforeZoom = await gui.capture();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.25),
    );
    await assert.rejects(gui.current(beforeZoom.snapshot.snapshotId), /旧引用失效/);
    const zoomed = await gui.capture();
    const device = await captureImage(
      root,
      session,
      gui,
      zoomed,
      input({ image: true, scale: "device" }),
    );
    assert.equal(device.status, "available", JSON.stringify(device));
    assert.ok("zoomFactor" in device && Math.abs(device.zoomFactor - 1.25) < 0.01);
    assert.ok(
      "pixelsPerCss" in device &&
        Math.abs(
          device.pixelsPerCss.x -
            zoomed.snapshot.document.devicePixelRatio / zoomed.snapshot.window.zoomFactor,
        ) < 0.02,
    );
    console.log(
      JSON.stringify({
        runId: session.runId,
        common: image.path,
        minimum: "image" in minimum ? minimum.image : null,
      }),
    );
  } finally {
    await closeGui({ app, page, session, gui, collector });
  }
});

test("输入截图使用自有遮罩，工具遮罩不改变业务布局代际", { timeout: 60000 }, async () => {
  const { app, page, session, gui, collector } = await setupGui();
  try {
    await page.evaluate(() => {
      const section = document.createElement("div");
      section.style.cssText =
        "position:fixed;left:300px;top:100px;padding:20px;background:white;z-index:10000";
      section.innerHTML = '<label>截图隔离输入<input value="fixture-image-secret"></label>';
      document.body.append(section);
    });
    const before = await gui.capture();
    const result = await captureImage(root, session, gui, before, input({ image: true }));
    assert.equal(result.status, "available", JSON.stringify(result));
    assert.equal(
      (await gui.current(before.snapshot.snapshotId)).snapshot.snapshotId,
      before.snapshot.snapshotId,
    );
    assert.equal(await page.getByLabel("截图隔离输入").inputValue(), "fixture-image-secret");
    console.log(JSON.stringify({ maskedInput: result }));
  } finally {
    await closeGui({ app, page, session, gui, collector });
  }
});
test("截图期间布局变化或采集失败保存缺失，不写入无法匹配的图片", { timeout: 60000 }, async () => {
  const { app, page, session, gui, collector } = await setupGui();
  const screenshot = page.screenshot.bind(page);
  try {
    const handle = await gui.capture();
    page.screenshot = async (options) => {
      const bytes = await screenshot(options);
      await page.evaluate(() => {
        document.body.style.paddingTop = "11px";
      });
      return bytes;
    };
    const changed = await captureImage(root, session, gui, handle, input({ image: true }));
    assert.equal(changed.status, "missing");
    assert.ok("reason" in changed && changed.reason === "GUI_SNAPSHOT_STALE");
    const next = await gui.capture();
    page.screenshot = async () => {
      throw new Error("隔离采集失败");
    };
    const missing = await captureImage(root, session, gui, next, input({ image: true }));
    assert.equal(missing.status, "missing");
    assert.ok("reason" in missing && missing.reason === "GUI_IMAGE_FAILED");
    const files = await readdir(runHome(root, session.runId));
    assert.equal(
      files.some((file) => file.endsWith(".png")),
      false,
    );
    assert.equal(files.filter((file) => /^image-.*\.json$/.test(file)).length, 2);
    assert.equal(
      await page.evaluate(
        () =>
          (globalThis as unknown as { __marshalAgentDocument: { mask?: unknown } })
            .__marshalAgentDocument.mask === undefined,
      ),
      true,
    );
  } finally {
    page.screenshot = screenshot;
    await closeGui({ app, page, session, gui, collector });
  }
});
