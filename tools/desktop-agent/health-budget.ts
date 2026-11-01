import type { ElectronApplication } from "@playwright/test";
import { readHealth } from "./health.ts";
import { ToolError } from "./protocol.ts";
/** 收尾观测不得占用应用自己的退出期限；完整诊断仍走独立 diagnose。 */
export async function healthWithin(app: ElectronApplication, milliseconds = 150) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readHealth(app),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ToolError(
                "HEALTH_CAPTURE_TIMEOUT",
                "收尾健康采集超过预算",
                "使用独立 diagnose 查询；不延迟退出",
                "blocked",
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
