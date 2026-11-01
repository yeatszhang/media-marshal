export const faultNames = [
  "http-timeout",
  "http-rate-limit",
  "component-exit",
  "volume-unavailable",
  "same-name-replacement",
  "post-publish-accounting",
] as const;
export interface CheckPhase {
  runner: "vitest" | "node";
  file: string;
  tests: string[];
  timeoutMs: number;
}
const httpFile = "packages/media-core/src/infrastructure/tmdb.test.ts";
const httpFault = "正文、Content-Length、超时、取消和重定向分别有界，不转发原始错误";
const httpBaseline = "同一请求只访问一次，缓存脱敏且不同消费者不能修改共享元数据";
const syncFile = "packages/media-core/src/sources/sync-rules.test.ts";
const nativeFile = "packages/media-core/src/files/native-rename.test.ts";
const phase = (
  file: string,
  test: string,
  runner: CheckPhase["runner"] = "vitest",
): CheckPhase => ({ file, tests: [test], runner, timeoutMs: 60000 });
export const faultCatalog = {
  "http-timeout": {
    title: "HTTP 超时",
    platform: "desktop",
    injection: "本地 HTTP 替身挂起响应，生产 requestJson 的 30ms 超时断言",
    on: phase(httpFile, httpFault),
    off: phase(httpFile, httpBaseline),
    substitutes: ["loopback-http", "fixed-test-inputs"],
  },
  "http-rate-limit": {
    title: "HTTP 限流",
    platform: "desktop",
    injection: "同一有界 HTTP 用例中的 429 与 Retry-After=20 断言",
    on: phase(httpFile, httpFault),
    off: phase(httpFile, httpBaseline),
    substitutes: ["loopback-http", "fixed-test-inputs"],
  },
  "component-exit": {
    title: "自有应用组件退出",
    platform: "desktop",
    injection: "只结束用例新建实例的已核验应用子进程，保留崩溃及控制器收敛断言",
    on: phase(
      "tools/desktop-agent/session.integration.ts",
      "自有应用异常退出明确记录崩溃，停止只回收原控制进程",
      "node",
    ),
    off: phase(
      "tools/desktop-agent/session.integration.ts",
      "独立客户端续用会话，重启保留数据且代际变化，不影响外部实例",
      "node",
    ),
    substitutes: ["isolated-empty-profile"],
  },
  "volume-unavailable": {
    title: "卷不可用",
    platform: "darwin",
    injection: "隔离库标记卷不可用并临时改名自有目录；核对暂存和未知所有权保护",
    on: phase(
      "packages/media-core/src/files/owned-attempt-cleanup.test.ts",
      "缺盘和所有权标记丢失时保留暂存，不把未知目录当垃圾",
    ),
    off: phase(nativeFile, "已整理文件经私有隔离后改名，收据保持 inode／内容；下载原件不参与"),
    substitutes: ["fixture-volume-identity", "temporary-directory-offline"],
  },
  "same-name-replacement": {
    title: "同名文件替换",
    platform: "darwin",
    injection: "发布后保留原 inode，写入同内容第三方同名文件并拒绝认领／删除",
    on: phase(
      nativeFile,
      "暂存发布的回执丢失后复用原 inode 补记，保留锚点且拒绝认领同内容外部文件",
    ),
    off: phase(nativeFile, "已整理文件经私有隔离后改名，收据保持 inode／内容；下载原件不参与"),
    substitutes: ["fixture-volume-identity", "native-receipt-loss-port"],
  },
  "post-publish-accounting": {
    title: "发布后记账失败",
    platform: "darwin",
    injection: "只在用例新库安装失败触发器，移除后重试保持原文件 inode 且仅一份成功收据",
    on: phase(syncFile, "正式文件已提交而记账失败后，输入离线仍只恢复原作业并保留文件身份"),
    off: phase(
      syncFile,
      "无账号和 Go 组件仍可预览、明确确认及 COPY，重复确认只产生一个操作和成功收据",
    ),
    substitutes: ["fixture-volume-identity", "isolated-sqlite-trigger", "synthetic-clock"],
  },
} as const;
export type FaultName = (typeof faultNames)[number];
export const faultPattern = (phase: CheckPhase) =>
  phase.tests.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
