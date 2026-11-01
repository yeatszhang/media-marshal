import { test, expect, launchDesktop } from "./support/test-electron";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const evidence = () => import("../../../tools/desktop-agent/evidence-store.ts");
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "marshal-context-smoke-"));
  const app = await launchDesktop(resolve("."), {
    dataDir: join(directory, "data"),
    mode: process.env.MARSHAL_E2E_MODE === "foreground" ? "foreground" : "background",
    target: process.env.MARSHAL_EXECUTABLE ? "packaged" : "development",
  });
  return { app, directory };
}
test("受管 Electron 的关闭证据完整关联，不把采集本身当业务断言", async ({}, info) => {
  const { app, directory } = await setup();
  try {
    const page = await app.firstWindow();
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    await app.close();
    const annotation = info.annotations.find((item) => item.type === "media-marshal.run")!;
    const run = JSON.parse(annotation.description!);
    const manifest = await (await evidence()).readEvidence(resolve("."), run.runId);
    expect(manifest.lifecycle).toBe("closed");
    expect(manifest.assertions).toBe("not-run");
    for (const kind of [
      "build",
      "scenario",
      "health",
      "aria",
      "image",
      "trace",
      "log",
      "observation",
    ])
      expect(
        manifest.artifacts.some((item) => item.kind === kind && item.status === "available"),
        kind,
      ).toBe(true);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("真实 Renderer 崩溃保留首个失败与窗口缺失，关闭继续收敛", async ({}, info) => {
  const { app, directory } = await setup();
  try {
    const page = await app.firstWindow();
    const crash = page.waitForEvent("crash");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(),
    );
    await crash;
    await app.close();
    const run = JSON.parse(
      info.annotations.find((item) => item.type === "media-marshal.run")!.description!,
    );
    const manifest = await (await evidence()).readEvidence(resolve("."), run.runId);
    expect(manifest.failures.find((item) => item.id === manifest.primaryFailureId)?.code).toBe(
      "RENDERER_CRASHED",
    );
    expect(
      manifest.artifacts.some((item) => item.kind === "image" && item.status === "missing"),
    ).toBe(true);
    expect(manifest.lifecycle).toBe("closed");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
