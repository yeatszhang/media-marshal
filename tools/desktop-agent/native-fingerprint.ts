import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ToolError } from "./protocol.ts";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.strictObject({
  format: z.literal(1),
  platform: z.literal("darwin"),
  arch: z.string(),
  createdAt: z.iso.datetime(),
  source: digest,
  builder: digest,
  binary: digest,
  buildId: digest,
});
async function ownedFile(root: string, relative: string, maximum: number) {
  const path = resolve(await realpath(root), relative),
    info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    info.size > maximum
  )
    throw new ToolError(
      "NATIVE_BUILD_PATH_REJECTED",
      "原生构建输入或二进制不是受限的本地普通文件",
      "移除越界链接并重新构建 helper",
      "blocked",
    );
  return readFile(path);
}
export async function nativeInputs(root: string) {
  const directory = resolve(await realpath(root), "tools/desktop-agent/native");
  if ((await realpath(directory)) !== directory)
    throw new ToolError(
      "NATIVE_BUILD_PATH_REJECTED",
      "原生源码目录含链接",
      "恢复本地源码目录",
      "blocked",
    );
  const names = (await readdir(directory)).filter((name) => name.endsWith(".swift")).sort();
  if (!names.length || names.length > 32)
    throw new ToolError(
      "NATIVE_SOURCE_LIMIT",
      "原生源码清单缺失或超过预算",
      "核对 native 目录",
      "blocked",
    );
  const selected = [
    ...names.map((name) => `tools/desktop-agent/native/${name}`),
    "tools/desktop-agent/native-build.mjs",
  ];
  const observe = async () =>
    Promise.all(
      selected.map(async (name) => {
        const info = await lstat(resolve(root, name), { bigint: true });
        return [name, String(info.ino), String(info.ctimeNs), String(info.mtimeNs)];
      }),
    );
  const before = hash(JSON.stringify(await observe()));
  const sources = [];
  for (const name of names)
    sources.push({
      name,
      sha256: hash(await ownedFile(root, `tools/desktop-agent/native/${name}`, 2 * 1024 * 1024)),
    });
  const builder = hash(await ownedFile(root, "tools/desktop-agent/native-build.mjs", 65536));
  const observation = hash(JSON.stringify(await observe()));
  if (before !== observation)
    throw new ToolError(
      "NATIVE_SOURCE_CHANGED",
      "生成原生指纹时源码发生变化",
      "停止并行编辑后重新构建",
      "blocked",
    );
  return {
    source: hash(JSON.stringify(sources)),
    builder,
    observation,
    sources: names.map((name) => join(directory, name)),
  };
}
export async function nativeBuildRecord(root: string) {
  const input = await nativeInputs(root);
  const value = {
    format: 1 as const,
    platform: "darwin" as const,
    arch: process.arch,
    createdAt: new Date().toISOString(),
    source: input.source,
    builder: input.builder,
    binary: hash(
      await ownedFile(root, "tools/desktop-agent/.build/native-helper", 16 * 1024 * 1024),
    ),
  };
  return { ...value, buildId: hash(JSON.stringify(value)) };
}
export async function nativeHelperRecord(root: string, platform: string = process.platform) {
  if (platform !== "darwin")
    throw new ToolError(
      "NATIVE_UNSUPPORTED",
      "原生驱动当前仅支持 macOS",
      "使用 DOM 能力；其他平台不作为原生通过",
      "blocked",
    );
  try {
    const manifest = manifestSchema.parse(
      JSON.parse(
        (await ownedFile(root, "tools/desktop-agent/.build/native-manifest.json", 65536)).toString(
          "utf8",
        ),
      ),
    );
    const { buildId, ...content } = manifest;
    if (buildId !== hash(JSON.stringify(content)))
      throw new ToolError(
        "NATIVE_BUILD_RECORD_INVALID",
        "原生构建清单的摘要无效",
        "重新构建 helper，不使用改写的清单",
        "blocked",
      );
    const actual = await nativeBuildRecord(root);
    if (
      manifest.source !== actual.source ||
      manifest.builder !== actual.builder ||
      manifest.binary !== actual.binary ||
      manifest.arch !== process.arch
    )
      throw new ToolError(
        "NATIVE_HELPER_STALE",
        "原生 helper 与源码、构建器或运行平台不一致",
        "执行 desktop:agent:native:build 后重新验证",
        "blocked",
      );
    return { path: resolve(root, "tools/desktop-agent/.build/native-helper"), manifest };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      "NATIVE_BUILD_MISSING",
      "缺少可信的当前原生 helper 构建",
      "执行 desktop:agent:native:build",
      "blocked",
    );
  }
}
export const assertNativeHelper = async (root: string, platform: string = process.platform) =>
  (await nativeHelperRecord(root, platform)).path;
