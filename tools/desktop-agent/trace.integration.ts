import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { TraceSession } from "./trace-session.ts";
import { guiRoot as root, setupGui, closeGui, observeInput } from "./gui-test-support.ts";
import { readEvidence } from "./evidence-store.ts";
import { runHome } from "./session-store.ts";
import { exportBundle } from "./export-bundle.ts";
import { unzipSync, strFromU8 } from "fflate";
async function checkExport(runId: string) {
  const exported = await exportBundle(root, runId, { kinds: ["trace", "image", "aria"] });
  const files = unzipSync(await readFile(exported.path));
  const index = JSON.parse(strFromU8(files["manifest.json"]!));
  assert.equal(index.rawUserDataIncluded, false);
  assert.equal(index.historyComplete, false);
  assert.ok(
    index.artifacts.some(
      (item: { kind: string; status: string }) =>
        item.kind === "trace" && ["available", "partial"].includes(item.status),
    ),
    JSON.stringify(index),
  );
  assert.ok(Object.keys(files).some((name) => name.endsWith(".png")));
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".zip")) continue;
    const trace = unzipSync(bytes);
    for (const [key, value] of Object.entries(trace))
      if (/\.(trace|network|stacks)$/.test(key))
        assert.equal(strFromU8(value).includes(root), false);
  }
  console.log(JSON.stringify({ runId, exported }));
}

test(
  "手动 Electron context 显式生成真实 trace，敏感窗口转场整段丢弃",
  { timeout: 60000 },
  async () => {
    const context = await setupGui();
    const trace = new TraceSession(root, context.session, context.app.context());
    const sensitive = new TraceSession(root, context.session, context.app.context());
    const embedded = new TraceSession(root, context.session, context.app.context());
    try {
      assert.equal((await trace.start("safe-synthetic")).status, "recording");
      await context.page.getByRole("link", { name: "设置", exact: true }).click();
      await context.page.getByRole("heading", { name: "设置", exact: true }).waitFor();
      const observation = await context.gui.observe(observeInput({ image: true }));
      assert.ok("image" in observation && observation.image.status === "available");
      assert.equal((await trace.stop()).status, "stopped");
      const manifest = await readEvidence(root, context.session.runId);
      const artifact = manifest.artifacts.find(
        (item) => item.kind === "trace" && item.status === "available",
      )!;
      assert.ok(artifact.name && artifact.sha256);
      const directory = runHome(root, context.session.runId);
      const bytes = await readFile(join(directory, artifact.name));
      assert.equal(bytes.subarray(0, 4).toString("hex"), "504b0304");
      assert.ok(bytes.length > 1000);
      await checkExport(context.session.runId);
      assert.equal((await sensitive.start("safe-synthetic")).status, "recording");
      const opened = context.app.waitForEvent("window");
      await context.app.evaluate(({ BrowserWindow }) => {
        const window = new BrowserWindow({ show: false, focusable: false });
        void window.loadURL("about:blank");
      });
      const foreign = await opened;
      await sensitive.stop();
      assert.equal(sensitive.summary().status, "blocked");
      const closed = foreign.waitForEvent("close");
      await (await context.app.browserWindow(foreign)).evaluate((window) => window.destroy());
      await closed;
      assert.equal((await embedded.start("safe-synthetic")).status, "recording");
      await context.page.evaluate(() => {
        const frame = document.createElement("iframe");
        frame.srcdoc = "<p>合成子页面，不采集其内容</p>";
        document.body.append(frame);
      });
      await embedded.stop();
      assert.equal(embedded.summary().status, "blocked");
      const after = await readEvidence(root, context.session.runId);
      assert.ok(
        after.artifacts.some(
          (item) => item.kind === "trace" && item.reason === "SENSITIVE_CONTEXT",
        ),
      );
      assert.equal((await readdir(directory)).filter((name) => name.endsWith(".zip")).length, 1);
      assert.equal(after.assertions, "not-run");
      console.log(
        JSON.stringify({
          runId: context.session.runId,
          trace: join(directory, artifact.name),
          sensitiveTrace: "blocked",
          image: "image" in observation ? observation.image.status : "missing",
        }),
      );
    } finally {
      await embedded.stop();
      await sensitive.stop();
      await trace.stop();
      await closeGui(context);
    }
  },
);
