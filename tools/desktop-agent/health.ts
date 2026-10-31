import type { ElectronApplication } from "@playwright/test";
import type { DesktopApi } from "@media-marshal/contracts";
import { trustedPage } from "./collector.ts";
import { ToolError } from "./protocol.ts";

/** 固定只读业务查询，调用者不能传入 JS、SQL、IPC 动作名或对象成员路径。 */
export async function readHealth(app: ElectronApplication) {
  const pages = app.windows().filter(trustedPage);
  if (pages.length !== 1)
    throw new ToolError(
      "HEALTH_TARGET_AMBIGUOUS",
      "无法唯一确认主界面诊断目标",
      "查询窗口身份；不访问登录页面或猜测其他窗口",
      "blocked",
    );
  const business = await pages[0]!.evaluate(async () => {
    const api = (globalThis as unknown as { desktopApi: DesktopApi }).desktopApi;
    const summarize = (value: unknown) => {
      const data = value as { items?: Record<string, unknown>[]; total?: number },
        items = Array.isArray(value) ? value : data?.items;
      if (!items) return { state: "unavailable" };
      return {
        state: "observed",
        total: data.total ?? items.length,
        truncated: Array.isArray(value) ? items.length >= 100 : (data.total ?? 0) > items.length,
        items: items.slice(0, 20).map((item) => ({
          id: item.id,
          state: item.state ?? item.status,
          deliveryStatus: item.deliveryStatus,
          failed: item.failed,
          errorCode: item.errorCode,
        })),
      };
    };
    const sections = await Promise.allSettled([
      api.getRuntime(),
      api.getOrganizePause(),
      api.getCloudDownloadPause(),
      api.listSyncJobs({ page: 1, pageSize: 20 }).then(summarize),
      api.listTasks({ page: 1, pageSize: 20 }).then(summarize),
      api.listDownloadCleanup({ page: 1 }).then(summarize),
      api.listCorrections({ page: 1 }).then(summarize),
    ]);
    return Object.fromEntries(
      [
        "runtime",
        "organizePause",
        "downloadPause",
        "syncJobs",
        "mediaTasks",
        "cleanup",
        "corrections",
      ].map((name, index) => {
        const section = sections[index]!;
        return [
          name,
          section.status === "fulfilled"
            ? { status: "observed", value: section.value }
            : { status: "unavailable", reason: "组件未就绪或只读查询失败" },
        ];
      }),
    );
  });
  const host = await app.evaluate(({ app }) => ({
    mainPid: process.pid,
    processes: app
      .getAppMetrics()
      .slice(0, 20)
      .map((row) => ({ pid: row.pid, type: row.type, name: row.name })),
    truncated: app.getAppMetrics().length > 20,
  }));
  return { ...business, host: { status: "observed", value: host } };
}
