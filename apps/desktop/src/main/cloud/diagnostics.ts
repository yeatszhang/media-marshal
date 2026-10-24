import { z } from "zod";
import { cloudErrorCodeSchema, cloudDiagnosticCountsSchema, type CloudDiagnosticCounts } from "@media-marshal/contracts";
import lock from "../../../../../tools/desktop-sidecars/sidecars.lock.json";

const componentState = z.enum(["DISABLED", "STARTING", "READY", "STOPPING", "FAILED", "UNCERTAIN"]);
export const componentDiagnosticSchema = z.strictObject({
  state: componentState, configuredAccounts: z.number().int().min(0).max(100), lastFailure: cloudErrorCodeSchema.nullable(),
});
export type ComponentDiagnostic = z.infer<typeof componentDiagnosticSchema>;
const version = z.string().max(100).regex(/^[0-9][0-9A-Za-z.+-]*$/);
const reportSchema = z.strictObject({
  schemaVersion: z.literal(1), createdAt: z.iso.datetime(), appVersion: version, electronVersion: version,
  target: z.enum(["darwin-arm64", "darwin-x64", "win32-x64"]),
  core: z.enum(["starting", "ready", "failed", "stopping"]), cloud: componentDiagnosticSchema,
  activity: cloudDiagnosticCountsSchema.nullable(),
  bundledVersions: z.strictObject({ openlist: version, rclone: version }), privateDataIncluded: z.literal(false),
});
export function defaultDiagnostic(input: { appVersion: string; electronVersion: string; target: string; core: string; cloud: ComponentDiagnostic; activity?: CloudDiagnosticCounts | null }): string {
  // 逐字段构造白名单；不读取数据库、配置、日志或用户数据目录，额外字段也不复制。
  const report = reportSchema.parse({ schemaVersion: 1, createdAt: new Date().toISOString(), appVersion: input.appVersion, electronVersion: input.electronVersion, target: input.target, core: input.core,
    cloud: { state: input.cloud.state, configuredAccounts: input.cloud.configuredAccounts, lastFailure: input.cloud.lastFailure },
    activity: input.activity ? cloudDiagnosticCountsSchema.parse(input.activity) : null,
    bundledVersions: { openlist: lock.components.openlist.version.replace(/^v/, ""), rclone: lock.components.rclone.version.replace(/^v/, "") }, privateDataIncluded: false });
  return JSON.stringify(report, null, 2) + "\n";
}
