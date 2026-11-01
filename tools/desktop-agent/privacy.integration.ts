import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { setupGui, closeGui, guiRoot as root } from "./gui-test-support.ts";
import { TraceSession } from "./trace-session.ts";
import { exportBundle } from "./export-bundle.ts";
import { runHome } from "./session-store.ts";
test(
  "同源扫码页面禁采 DOM／图片并丢弃已启动 trace；动态恢复后新段可以正常录制",
  { timeout: 60000 },
  async () => {
    const context = await setupGui();
    const trace = new TraceSession(root, context.session, context.app.context());
    const recovered = new TraceSession(root, context.session, context.app.context());
    try {
      assert.equal((await trace.start("safe-synthetic")).status, "recording");
      await context.page.evaluate(() => {
        const qr = document.createElement("section");
        qr.id = "sensitive-qr-fixture";
        qr.setAttribute("aria-label", "账号扫码二维码");
        qr.textContent = "privacy-qr-token-not-for-export";
        document.body.append(qr);
      });
      await assert.rejects(context.gui.capture(), { code: "GUI_SENSITIVE_CONTEXT" });
      assert.equal((await trace.stop()).status, "blocked");
      assert.equal(trace.summary().reason, "SENSITIVE_CONTEXT");
      const home = runHome(root, context.session.runId);
      assert.equal(
        (await readdir(home)).some((name) => name.endsWith(".zip") || name.endsWith(".png")),
        false,
      );
      const exported = await exportBundle(root, context.session.runId, {
        kinds: ["trace", "aria", "image"],
      });
      assert.equal(exported.status, "partial");
      const files = unzipSync(await readFile(exported.path));
      assert.deepEqual(Object.keys(files), ["manifest.json"]);
      assert.equal(
        strFromU8(files["manifest.json"]!).includes("privacy-qr-token-not-for-export"),
        false,
      );
      await context.page.locator("#sensitive-qr-fixture").evaluate((node) => node.remove());
      assert.equal((await recovered.start("safe-synthetic")).status, "recording");
      await context.gui.capture();
      assert.equal((await recovered.stop()).status, "stopped");
      assert.equal((await readdir(home)).filter((name) => name.endsWith(".zip")).length, 1);
      console.log(
        JSON.stringify({
          runId: context.session.runId,
          sensitive: trace.summary(),
          recovered: recovered.summary(),
          exported: exported.path,
        }),
      );
    } finally {
      await recovered.stop();
      await trace.stop();
      await closeGui(context);
    }
  },
);
