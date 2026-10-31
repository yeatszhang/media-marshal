import { execFileSync } from "node:child_process";
import { readFile, readdir, lstat, readlink, realpath } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { digestFile } from "./resources.ts";
import { ToolError } from "./protocol.ts";
import { z } from "zod";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface FileDigest {
  path: string;
  sha256?: string;
  size?: number;
  mode?: number;
  link?: string;
  missing?: boolean;
}
function active(path: string) {
  if (
    [
      "package.json",
      "package-lock.json",
      "tsconfig.base.json",
      "vitest.config.ts",
      ".npmrc",
      ".gitignore",
    ].includes(path)
  )
    return true;
  const roots = [
    "apps/desktop/src/",
    "apps/desktop/resources/icons/",
    "packages/contracts/",
    "packages/media-core/",
    "tools/desktop-agent/",
    "tools/desktop-parser/",
    "tools/desktop-files/",
    "tools/desktop-sidecars/",
    "scripts/",
  ];
  const config = /^apps\/desktop\/[^/]+\.(?:ts|json|yml)$/.test(path);
  return (
    (config || roots.some((root) => path.startsWith(root))) &&
    !/\.(?:md|log)$/.test(path) &&
    !/(?:^|\/)(?:dist|out|release|node_modules|\.venv|\.build|__pycache__)(?:\/|$)/.test(path)
  );
}
async function describe(root: string, path: string): Promise<FileDigest> {
  let info;
  try {
    info = await lstat(join(root, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, missing: true };
    throw error;
  }
  if (info.isSymbolicLink()) return { path, link: await readlink(join(root, path)) };
  if (!info.isFile())
    throw new ToolError(
      "INVALID_BUILD_INPUT",
      "构建输入包含非普通文件",
      "核对源码与资源目录中的异常文件",
    );
  return { path, ...(await digestFile(join(root, path))), mode: info.mode & 0o111 };
}
async function observations(root: string, names: string[]) {
  const values = [];
  for (const path of names) {
    try {
      const info = await lstat(join(root, path), { bigint: true });
      values.push([path, String(info.ino), String(info.ctimeNs), String(info.mtimeNs)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") values.push([path, "missing"]);
      else throw error;
    }
  }
  return hash(values);
}
export async function sourceFingerprint(root: string) {
  const names = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  )
    .split("\0")
    .filter(active);
  const files: FileDigest[] = [];
  const selected = [...new Set(names)].sort(),
    before = await observations(root, selected);
  for (const path of selected) {
    const file = await describe(root, path);
    if (file.link)
      throw new ToolError(
        "BUILD_INPUT_LINK",
        "活跃源码不能通过链接引入外部内容",
        "使用仓库内的实际源码或明确的包依赖",
      );
    files.push(file);
  }
  const observation = await observations(root, selected);
  if (before !== observation)
    throw new ToolError("SOURCE_CHANGED", "生成指纹期间源码发生变化", "停止并行修改后重新构建");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return {
    digest: hash(files),
    observation,
    files,
    commit,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    toolProtocol: 1,
  };
}
export async function artifactFingerprint(root: string, target: "development" | "packaged") {
  const files: FileDigest[] = [];
  const inputs =
    target === "development"
      ? [
          "apps/desktop/out",
          ...["parser", "native-files", "sidecars"].map(
            (name) => `apps/desktop/resources/${name}/${process.platform}-${process.arch}`,
          ),
        ]
      : [
          process.platform === "darwin"
            ? `apps/desktop/release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/Media Marshal.app`
            : "apps/desktop/release/win-unpacked",
        ];
  async function walk(path: string, boundary: string) {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) {
      const actual = await realpath(join(root, path));
      if (actual !== boundary && !actual.startsWith(boundary + "/"))
        throw new ToolError(
          "ARTIFACT_ESCAPE",
          "构建产物包含越界链接",
          "重新生成自包含的当前平台产物",
        );
      files.push(await describe(root, path));
    } else if (info.isDirectory()) {
      for (const item of (await readdir(join(root, path))).sort())
        await walk(`${path}/${item}`, boundary);
    } else files.push(await describe(root, path));
    if (files.length > 20000)
      throw new ToolError(
        "ARTIFACT_TOO_LARGE",
        "产物文件数量超过检查预算",
        "核对构建是否误带入开发目录",
      );
  }
  for (const path of inputs) {
    const physical = await realpath(join(root, path)),
      base = await realpath(root);
    if ((await lstat(join(root, path))).isSymbolicLink() || !physical.startsWith(base + "/"))
      throw new ToolError(
        "ARTIFACT_ESCAPE",
        "产物根不能指向外部目录",
        "重新构建到工作区内的自有目录",
      );
    await walk(path, physical);
  }
  if (!files.length)
    throw new ToolError("MISSING_ARTIFACT", "尚未生成当前构建", "运行 build 后重试");
  return { digest: hash(files), files, target, platform: process.platform, arch: process.arch };
}
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const fileSchema = z.strictObject({
  path: z.string(),
  sha256: digestSchema.optional(),
  size: z.number().optional(),
  mode: z.number().optional(),
  link: z.string().optional(),
  missing: z.boolean().optional(),
});
const manifestSchema = z.strictObject({
  format: z.literal(1),
  buildId: digestSchema,
  createdAt: z.iso.datetime(),
  source: z.strictObject({
    digest: digestSchema,
    observation: digestSchema,
    files: z.array(fileSchema),
    commit: z.string(),
    platform: z.string(),
    arch: z.string(),
    node: z.string(),
    toolProtocol: z.literal(1),
  }),
  artifact: z.strictObject({
    digest: digestSchema,
    files: z.array(fileSchema),
    target: z.enum(["development", "packaged"]),
    platform: z.string(),
    arch: z.string(),
  }),
});
export async function readManifest(path: string) {
  try {
    const value = manifestSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
    if (
      value.buildId !== hash({ source: value.source, artifact: value.artifact }) ||
      value.source.digest !== hash(value.source.files) ||
      value.artifact.digest !== hash(value.artifact.files)
    )
      throw new Error("摘要不一致");
    return value;
  } catch {
    throw new ToolError(
      "INVALID_MANIFEST",
      "构建清单无效或摘要不一致",
      "重新执行 build",
      "blocked",
    );
  }
}
export const identityHash = hash;
