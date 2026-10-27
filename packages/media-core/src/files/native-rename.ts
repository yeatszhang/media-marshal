import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, dirname, join } from "node:path";
import { z } from "zod";
import { DesktopError } from "@media-marshal/contracts";
import { nativeFileLaunchSchema, nativeFileManifestSchema, type NativeFileLaunch } from "@media-marshal/contracts/internal";
export interface NativeFileSnapshot { dev: bigint; ino: bigint; size: bigint; birthtimeNs: bigint; mtimeNs: bigint; ctimeNs: bigint }
export const nativeRenameResultSchema = z.strictObject({ state: z.enum(["RENAMED", "NOT_RENAMED", "UNCERTAIN"]), code: z.enum(["OK", "INVALID_SOURCE", "SOURCE_CHANGED", "TARGET_EXISTS", "CROSS_VOLUME", "UNAVAILABLE", "UNSUPPORTED", "SYNC_FAILED", "INTERRUPTED", "UNSAFE_PATH"]), moved: z.boolean(), osError: z.number().int().min(0).max(65535) }).refine((row) => row.state === "RENAMED" ? row.moved && row.code === "OK" : row.state === "UNCERTAIN" ? row.moved && row.code !== "OK" : !row.moved && row.code !== "OK");
export type NativeRenameResult = z.infer<typeof nativeRenameResultSchema>;
export const nativePublishResultSchema = z.strictObject({ state: z.enum(["PUBLISHED", "NOT_PUBLISHED", "UNCERTAIN"]), code: nativeRenameResultSchema.shape.code, published: z.boolean(), osError: z.number().int().min(0).max(65535) }).refine((row) => row.state === "PUBLISHED" ? row.published && row.code === "OK" : row.state === "UNCERTAIN" ? row.published && row.code !== "OK" : !row.published && row.code !== "OK");
export type NativePublishResult = z.infer<typeof nativePublishResultSchema>;
export interface NativeRenameApi { linkBeneath(fromRootFd: number, from: string[], toRootFd: number, to: string[], expected: NativeFileSnapshot): Promise<NativePublishResult>; renameBeneath(fromRootFd: number, from: string[], toRootFd: number, to: string[], expected: NativeFileSnapshot): Promise<NativeRenameResult> }
export type NativeRenameLaunch = NativeFileLaunch;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** 启动参数只能由 Main 的私有资源定位产生，不接受 Renderer 提供的路径或原生模块。 */
export async function loadNativeRename(input: NativeRenameLaunch): Promise<NativeRenameApi> {
  const unavailable = () => new DesktopError("COMPONENT_UNAVAILABLE", "修正文件组件不可用或完整性不符，请重开匹配版本的客户端");
  if (process.platform !== "darwin") throw new DesktopError("UNSUPPORTED_CAPABILITY", "当前平台尚未验证安全修正文件操作");
  try {
    input = nativeFileLaunchSchema.parse(input); if (!isAbsolute(input.manifestPath)) throw unavailable();
    const info = await lstat(input.manifestPath); if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw unavailable();
    const bytes = await readFile(input.manifestPath); if (hash(bytes) !== input.manifestSha256) throw unavailable();
    const manifest = nativeFileManifestSchema.parse(JSON.parse(bytes.toString("utf8"))); if (manifest.target !== `darwin-${process.arch}` || Number(process.versions.napi ?? 0) < 8) throw unavailable();
    const path = join(dirname(input.manifestPath), manifest.binary.name), binaryInfo = await lstat(path); if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink() || binaryInfo.size !== manifest.binary.size) throw unavailable();
    const binary = await readFile(path); if (binary.length !== manifest.binary.size || hash(binary) !== manifest.binary.sha256 || binary.readUInt32LE(0) !== 0xfeedfacf || binary.readUInt32LE(4) !== (process.arch === "arm64" ? 0x100000c : 0x1000007)) throw unavailable();
    const api = createRequire(import.meta.url)(path) as Partial<NativeRenameApi>; if (typeof api.renameBeneath !== "function" || typeof api.linkBeneath !== "function") throw unavailable();
    return { linkBeneath: async (...args) => { const result = nativePublishResultSchema.safeParse(await api.linkBeneath!(...args)); if (!result.success) throw new DesktopError("CONFLICT", "文件发布结果无法核对，请保留现存文件并从原作业重试核对"); return result.data; }, renameBeneath: async (...args) => { const result = await api.renameBeneath!(...args), parsed = nativeRenameResultSchema.safeParse(result); if (!parsed.success) throw new DesktopError("CONFLICT", "改名结果无法核对，请保留现存文件并从原修正作业重试核对"); return parsed.data; } };
  } catch (error) { if (error instanceof DesktopError) throw error; throw unavailable(); }
}
