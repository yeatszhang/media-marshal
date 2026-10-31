import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { launchDesktop } from "./support/electron";
import { currentBuild } from "./support/current-build";

type Record = {
  event: string;
  action?: string;
  actionId?: string;
  requestId?: string;
  parentRequestId?: string;
  jobId?: string;
  operationId?: string;
  processGeneration?: string;
  [key: string]: unknown;
};
async function records(path: string): Promise<Record[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
async function seed(app: ElectronApplication, page: Page, input: string, target: string) {
  await app.evaluate(
    ({ dialog }, paths) => {
      let index = 0;
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [paths[index++]!],
      })) as typeof dialog.showOpenDialog;
    },
    [input, target],
  );
  return page.evaluate(async () => {
    const input = await window.desktopApi.chooseConfigurationDirectory("ordinary");
    const target = await window.desktopApi.chooseConfigurationDirectory("managed");
    await window.desktopApi.setDefaultDownloadDirectory({
      expectedVersion: 0,
      directoryId: target!.id,
      requestKey: crypto.randomUUID(),
    });
    return input!.id;
  });
}
async function confirmThroughUi(page: Page, inputId: string, target: string) {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: "来源", exact: true })
    .click();
  await page.getByRole("button", { name: "添加同步来源", exact: true }).click();
  await page.getByLabel("来源名称", { exact: true }).fill("日志因果链验证");
  await page.getByLabel("本地输入目录", { exact: true }).selectOption(inputId);
  await page.getByRole("button", { name: "保存草稿并预览", exact: true }).click();
  const preview = page.getByRole("region", { name: "同步预览", exact: true });
  await expect(preview.getByLabel("确认配置时执行一次", { exact: false })).toBeEnabled({
    timeout: 150000,
  });
  await preview.getByLabel("确认配置时执行一次", { exact: false }).check();
  await preview.getByLabel("我已确认本次本地文件完整，允许复制此精确清单", { exact: true }).check();
  // 完整稳定观察之后，模拟预览与提交之间出现的目标冲突；原内容必须保留。
  await mkdir(join(target, "completed"), { recursive: true });
  await writeFile(join(target, "completed/隔离原片.mp4"), "不得覆盖的原目标内容");
  await preview.getByRole("button", { name: "确认配置范围", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "同步任务详情", exact: true });
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  return (await page.evaluate(() => window.desktopApi.listSyncJobs({}))).items[0]!.id;
}
function assertGraph(rows: Record[], jobId: string) {
  const accepted = rows.find((row) => row.event === "sync.confirmed" && row.jobId === jobId)!;
  expect(accepted).toBeDefined();
  const forwarded = rows.find(
    (row) => row.event === "core.request.sent" && row.requestId === accepted.requestId,
  )!;
  expect(forwarded?.parentRequestId).toBeDefined();
  const ui = rows.find(
    (row) => row.event === "ui.request.started" && row.requestId === forwarded.parentRequestId,
  )!;
  expect(ui?.actionId).toMatch(/^[0-9a-f-]{36}$/);
  const response = rows.find(
    (row) => row.event === "ui.request.returned" && row.requestId === ui.requestId,
  )!;
  expect(response).toMatchObject({ jobId, actionId: ui.actionId });
  expect(rows.some((row) => row.event === "ipc.returned" && row.requestId === ui.requestId)).toBe(
    true,
  );
  return {
    actionId: ui.actionId,
    uiRequestId: ui.requestId,
    coreRequestId: accepted.requestId,
    jobId,
  };
}

test("UI 确认关联持久任务失败，Core 重启后按原业务身份续查", async ({}, info) => {
  test.setTimeout(210000);
  const root = resolve("."),
    build = await currentBuild(root);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-log-correlation-")));
  const input = join(directory, "输入"),
    target = join(directory, "目标"),
    log = join(directory, "data/logs/desktop.log");
  await Promise.all([mkdir(input), mkdir(target)]);
  const source = join(input, "隔离原片.mp4");
  await writeFile(source, "本地文件内容");
  const sessionId = randomUUID(),
    runId = randomUUID();
  const app = await launchDesktop(root, {
    dataDir: join(directory, "data"),
    mode: "background",
    target: "development",
    diagnostics: { sessionId, runId, buildId: build.buildId },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
    const inputId = await seed(app, page, input, target);
    const jobId = await confirmThroughUi(page, inputId, target);
    await expect
      .poll(() => page.evaluate((id) => window.desktopApi.getSyncJob(id), jobId))
      .toMatchObject({ id: jobId, state: "NEEDS_ATTENTION", failed: 1 });
    await expect
      .poll(async () => (await records(log)).some((row) => row.event === "sync.local.failed"))
      .toBe(true);
    const before = await records(log),
      graph = assertGraph(before, jobId);
    const failure = before.find((row) => row.event === "sync.local.failed")!;
    expect(failure).toMatchObject({
      process: "core",
      operationId: expect.any(String),
      error: { code: expect.any(String) },
      sessionId,
      runId,
      buildId: build.buildId,
    });
    expect(await readFile(join(target, "completed/隔离原片.mp4"), "utf8")).toBe(
      "不得覆盖的原目标内容",
    );
    const oldGeneration = before.find((row) => row.event === "core.ready")!.processGeneration;
    await page.evaluate(() => window.desktopApi.restartCore());
    await expect
      .poll(() => page.evaluate((id) => window.desktopApi.getSyncJob(id), jobId))
      .toMatchObject({ id: jobId, state: "NEEDS_ATTENTION", failed: 1 });
    await expect
      .poll(
        async () =>
          new Set(
            (await records(log))
              .filter((row) => row.event === "core.ready")
              .map((row) => row.processGeneration),
          ).size,
      )
      .toBe(2);
    const after = await records(log);
    expect(after.filter((row) => row.event === "core.ready").at(-1)!.processGeneration).not.toBe(
      oldGeneration,
    );
    expect(after.some((row) => row.event === "sync.job.state" && row.jobId === jobId)).toBe(true);
    expect(
      after.find((row) => row.event === "sync.job.state" && row.jobId === jobId)?.operationIds,
    ).toContain(failure.operationId);
    await writeFile(
      info.outputPath("log-correlation.json"),
      JSON.stringify(
        {
          ...graph,
          operationId: failure.operationId,
          sessionId,
          runId,
          buildId: build.buildId,
          persistentState: "NEEDS_ATTENTION",
          restartedCore: true,
          nativeDirectorySelection: "stub",
        },
        null,
        2,
      ),
    );
  } finally {
    const relevant = (await records(log)).filter(
      (row) =>
        row.event?.startsWith("sync.") ||
        row.event?.startsWith("ui.request") ||
        row.event?.startsWith("core.request") ||
        row.event === "core.ready",
    );
    await writeFile(info.outputPath("correlation-events.json"), JSON.stringify(relevant, null, 2));
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
