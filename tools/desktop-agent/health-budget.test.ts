import { test } from "node:test";
import assert from "node:assert/strict";
import type { ElectronApplication } from "@playwright/test";
import { healthWithin } from "./health-budget.ts";
test("Core 不响应时健康采集按自身预算结束，不占用应用退出期限", async () => {
  const app = {
    windows: () => [
      { url: () => "marshal://app/index.html", evaluate: () => new Promise(() => {}) },
    ],
  } as unknown as ElectronApplication;
  const started = Date.now();
  await assert.rejects(healthWithin(app, 20), { code: "HEALTH_CAPTURE_TIMEOUT" });
  assert.ok(Date.now() - started < 1000);
});
