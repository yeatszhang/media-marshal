import type { ElectronApplication } from "@playwright/test";
import type { DesktopApi } from "@media-marshal/contracts";
import { join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { runHome, type Session } from "./session-store.ts";
import { atomicJson } from "./build.ts";
import { trustedPage } from "./collector.ts";
import { agentFile } from "./paths.ts";
import { ToolError } from "./protocol.ts";
export async function checkScenario(
  root: string,
  app: ElectronApplication,
  session: Session,
  fixture: unknown,
) {
  const pages = app.windows().filter(trustedPage);
  if (pages.length !== 1)
    throw new ToolError(
      "SCENARIO_TARGET_UNKNOWN",
      "无法唯一确认场景主窗口",
      "查询启动与窗口证据",
      "blocked",
    );
  const name = session.options.scenario;
  const observed = await pages[0]!.evaluate(async (name) => {
    const api = (globalThis as unknown as { desktopApi: DesktopApi }).desktopApi;
    const [sync, rules, tasks, downloads] = await Promise.all([
      api.listSyncSources({}),
      api.listRecognitionRules({}),
      api.listTasks({ page: 1, pageSize: 25 }),
      api.listDownloads({ page: 1, pageSize: 25 }),
    ]);
    const issues = downloads.items.length
      ? await api.listDownloadIssues({ jobId: downloads.items[0]!.id, page: 1, pageSize: 25 })
      : null;
    return {
      name,
      sync: sync.map((row) => ({ version: row.version, paused: row.paused })),
      recognitionRules: rules.length,
      tasks: tasks.items.map((row) => ({ status: row.status })),
      downloads: downloads.total,
      itemStates: issues?.items.map((row) => row.state) ?? [],
    };
  }, name);
  const valid =
    name === "empty"
      ? observed.sync.length === 0 &&
        observed.recognitionRules === 0 &&
        observed.tasks.length === 0 &&
        observed.downloads === 0
      : name === "local-sync-ready"
        ? observed.sync.length === 1 && observed.sync[0]!.version === 1 && observed.downloads === 0
        : name === "recognition-review"
          ? observed.recognitionRules === 1 &&
            observed.tasks.length === 1 &&
            observed.tasks[0]!.status === "AWAITING_CONFIRMATION"
          : observed.downloads === 1 &&
            observed.itemStates.includes(
              name === "download-conflict" ? "BLOCKED_LOCAL" : "RECONCILING",
            );
  const path = join(runHome(root, session.runId), "scenario-check.json");
  const result = {
    fixture,
    observed,
    businessPassed: valid,
    passed: false,
    buildId: session.buildId,
  };
  await atomicJson(path, result);
  if (!valid)
    throw new ToolError(
      "SCENARIO_POSTCONDITION_FAILED",
      "场景实际后置条件与注册定义不一致",
      "查看 scenario-check.json 和日志，修复准备逻辑后使用新会话",
      "blocked",
    );
  if (name === "download-conflict") {
    const target = join(
      runHome(root, session.profileRunId),
      "fixture-downloads/completed/sample.bin",
    );
    if ((await readFile(await agentFile(root, target), "utf8")) !== "保留的不同目标内容")
      throw new ToolError(
        "SCENARIO_FILE_CHANGED",
        "场景冲突目标内容不符",
        "保留当前证据并检查文件安全约束",
      );
  }
  if (name === "recovery-pending") {
    const target = join(
      runHome(root, session.profileRunId),
      "fixture-downloads/completed/sample.bin",
    );
    try {
      await access(target);
      throw new ToolError(
        "SCENARIO_UNEXPECTED_PUBLICATION",
        "未完成输入被提前发布",
        "停止使用当前构建并检查恢复边界",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  result.passed = true;
  await atomicJson(path, result);
  return observed;
}
