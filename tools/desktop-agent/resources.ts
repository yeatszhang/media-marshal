import { createReadStream } from "node:fs";
import { readFile, realpath, readlink, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";

interface Digest {
  path?: string;
  name?: string;
  size: number;
  sha256: string;
}
export async function digestFile(path: string) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const bytes of createReadStream(path)) {
    hash.update(bytes);
    size += bytes.length;
  }
  return { sha256: hash.digest("hex"), size };
}
async function contained(root: string, path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.split(/[\\/]/).some((part) => !part || part === ".." || part === ".")
  )
    throw new Error("资源路径无效");
  const base = await realpath(root),
    actual = await realpath(join(root, path));
  if (!actual.startsWith(base + "/")) throw new Error("资源路径越界");
  return actual;
}
async function verify(root: string, path: string, expected: Digest) {
  if (
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0 ||
    expected.size > 512 * 1024 * 1024
  )
    throw new Error("资源摘要清单无效");
  const actual = await digestFile(await contained(root, path));
  if (actual.sha256 !== expected.sha256 || actual.size !== expected.size)
    throw new Error("资源摘要不符");
}
async function parser(root: string, resource: string, value: Record<string, any>) {
  const names = [
    "main.py",
    "codex_recognition.py",
    "codex_stdio.py",
    "build.py",
    "prepare.py",
    "requirements-build.txt",
  ].sort();
  const entries = await Promise.all(
    names.map(
      async (name) =>
        `${JSON.stringify(name)}: ${JSON.stringify((await digestFile(join(root, "tools/desktop-parser", name))).sha256)}`,
    ),
  );
  if (
    createHash("sha256")
      .update("{" + entries.join(", ") + "}")
      .digest("hex") !== value.sourceHash
  )
    throw new Error("解析器源码已变化");
  if (!value.files || Object.keys(value.files).length > 4096 || !value.entryPoint)
    throw new Error("解析器清单无效");
  const runtime = join(resource, "runtime");
  for (const [path, expected] of Object.entries(value.files) as [string, any][]) {
    const actual = await contained(runtime, path);
    if (expected.link) {
      if (
        !(await lstat(join(runtime, path))).isSymbolicLink() ||
        (await readlink(join(runtime, path))) !== expected.link
      )
        throw new Error("解析器链接不符");
    } else await verify(runtime, path, expected);
  }
  await contained(runtime, value.entryPoint);
}
async function sidecars(root: string, resource: string, value: Record<string, any>) {
  const lock = JSON.parse(
    await readFile(join(root, "tools/desktop-sidecars/sidecars.lock.json"), "utf8"),
  );
  for (const name of ["openlist", "rclone"]) {
    const expected = lock.components[name]?.assets[value.target]?.binary,
      current = value.components?.[name];
    if (
      !expected ||
      current?.binary?.sha256 !== expected.sha256 ||
      current?.binary?.size !== expected.size
    )
      throw new Error("网盘组件未匹配固定锁文件");
    await verify(resource, current.binary.path, expected);
  }
}
export async function verifyResource(root: string, manifest: string, name: string) {
  const file = resolve(root, manifest),
    resource = dirname(file);
  const value = JSON.parse(await readFile(file, "utf8"));
  if (value.target !== `${process.platform}-${process.arch}`) throw new Error("资源架构不匹配");
  if (name === "parser") await parser(root, resource, value);
  else if (name === "sidecars") await sidecars(root, resource, value);
  else if (value.binary) {
    await verify(resource, value.binary.name ?? value.binary.path, value.binary);
    if (name === "native-files") {
      const expectedElectron = JSON.parse(
        await readFile(join(root, "apps/desktop/package.json"), "utf8"),
      ).devDependencies.electron;
      if (
        value.napi !== 8 ||
        value.electronHeaders !== expectedElectron ||
        !/^[a-f0-9]{64}$/.test(value.source?.sha256 ?? "")
      )
        throw new Error("原生文件构建清单不匹配");
      const actual = await digestFile(resolve(root, "tools/desktop-files/rename-exclusive.c"));
      if (value.source.sha256 !== actual.sha256) throw new Error("原生文件源码已变化");
    }
  } else throw new Error("资源缺少二进制摘要");
}
