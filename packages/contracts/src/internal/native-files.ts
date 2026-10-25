import { z } from "zod";
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
/** 仅供 Main → Core 启动；公开业务动作不接受原生模块路径。 */
export const nativeFileLaunchSchema = z.strictObject({ manifestPath: z.string().min(1).max(16384), manifestSha256: checksum });
export type NativeFileLaunch = z.infer<typeof nativeFileLaunchSchema>;
export const nativeFileManifestSchema = z.strictObject({ format: z.literal(1), target: z.enum(["darwin-arm64", "darwin-x64"]), napi: z.literal(8), sdk: z.string().max(64), electronHeaders: z.string().max(64), source: z.strictObject({ path: z.literal("tools/desktop-files/rename-exclusive.c"), sha256: checksum }), headers: z.record(z.string().max(64), checksum), binary: z.strictObject({ name: z.literal("rename-exclusive.node"), size: z.number().int().positive().max(8 * 1024 * 1024), sha256: checksum }), compiler: z.string().max(512), releaseStatus: z.enum(["unintegrated-development", "unsigned-preview", "developer-id"]) });
