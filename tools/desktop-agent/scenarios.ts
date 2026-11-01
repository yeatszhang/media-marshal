import { createHash } from "node:crypto";
import type { Input } from "./protocol.ts";
export type ScenarioName = Input<"start">["scenario"];
export const SCENARIO_VERSION = 1;
export const scenarios = {
  empty: {
    title: "空状态",
    platform: "desktop",
    expected: "没有来源、识别任务或下载作业",
    substitutes: [],
  },
  "local-sync-ready": {
    title: "本地同步配置",
    platform: "darwin",
    expected: "已授权输入与默认下载根，确认一条本地同步配置；文件仍遵循生产稳定观察",
    substitutes: ["fixture-directory-authorization"],
  },
  "recognition-review": {
    title: "待识别核对",
    platform: "darwin",
    expected: "独立识别规则与一条待确认合成候选，不创建 COPY 计划",
    substitutes: [
      "fixture-directory-authorization",
      "synthetic-recognition-result",
      "synthetic-cloud-plan",
      "synthetic-remote-stat",
    ],
  },
  "download-conflict": {
    title: "下载目标冲突",
    platform: "darwin",
    expected: "已有不同内容的目标和 BLOCKED_LOCAL 下载，不连接真实账号",
    substitutes: ["fixture-directory-authorization", "synthetic-cloud-plan"],
  },
  "recovery-pending": {
    title: "恢复待处理",
    platform: "darwin",
    expected: "未完成写入及不充分停止证据，启动后仍需核对，不能当作成功",
    substitutes: ["fixture-directory-authorization", "synthetic-interrupted-state"],
  },
} as const;
export function sceneIdentity(name: ScenarioName, seed: string, label: string) {
  const value = createHash("sha256")
    .update(`${SCENARIO_VERSION}:${name}:${seed}:${label}`)
    .digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
export const sceneBytes = (name: ScenarioName, seed: string) =>
  Buffer.from(
    `Media Marshal 隔离场景 ${name}\n${createHash("sha256").update(seed).digest("hex")}\n`,
  );
