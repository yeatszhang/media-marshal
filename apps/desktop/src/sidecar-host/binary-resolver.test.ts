import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SidecarBinaryResolver, sidecarTarget, type BinaryDefinitions } from "./binary-resolver";

const directories: string[] = [];
const target = sidecarTarget(process.platform, process.arch);
function header(wrongArchitecture = false) {
  const bytes = Buffer.alloc(256);
  if (process.platform === "darwin") { bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(wrongArchitecture ? 7 : process.arch === "arm64" ? 0x0100000c : 0x01000007, 4); }
  else { bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(128, 0x3c); bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(wrongArchitecture ? 0xaa64 : 0x8664, 132); }
  return bytes;
}
async function resources(wrongArchitecture = false) {
  const root = await mkdtemp(join(tmpdir(), "marshal-resolver-")); directories.push(root);
  await mkdir(join(root, "bin"));
  const bytes = header(wrongArchitecture); const definitions = {} as Record<keyof BinaryDefinitions, BinaryDefinitions["guardian"]>;
  for (const name of ["openlist", "rclone", "guardian"] as const) {
    const filename = name + (process.platform === "win32" ? ".exe" : "");
    await writeFile(join(root, "bin", filename), bytes, { mode: 0o755 });
    definitions[name] = { path: `bin/${filename}`, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  return { root, definitions };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });
describe("受管二进制定位与完整性", () => {
  it("只依据给定绝对资源根定位，开发与安装目录使用相同约束", async () => {
    for (let index = 0; index < 2; index++) {
      const { root, definitions } = await resources();
      const resolved = await new SidecarBinaryResolver(root, target, definitions).resolve();
      expect(resolved.guardian).toBe(join(await realpath(root), definitions.guardian.path));
      expect(Object.isFrozen(resolved)).toBe(true);
    }
    const { definitions } = await resources();
    await expect(new SidecarBinaryResolver("relative-root", target, definitions).resolve()).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
  });
  it("摘要或文件长度异常时拒绝，不回退 PATH", async () => {
    const { root, definitions } = await resources();
    await writeFile(join(root, definitions.rclone.path), Buffer.alloc(1));
    await expect(new SidecarBinaryResolver(root, target, definitions).resolve()).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
    const second = await resources();
    second.definitions.openlist = { ...second.definitions.openlist, sha256: "0".repeat(64) };
    await expect(new SidecarBinaryResolver(second.root, target, second.definitions).resolve()).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
  });
  it("即使摘要匹配也拒绝错误架构文件头", async () => {
    const { root, definitions } = await resources(true);
    await expect(new SidecarBinaryResolver(root, target, definitions).resolve()).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
  });
  it("拒绝越界清单与符号链接资源", async () => {
    const { root, definitions } = await resources();
    definitions.guardian = { ...definitions.guardian, path: "../guardian" };
    await expect(new SidecarBinaryResolver(root, target, definitions).resolve()).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
    if (process.platform !== "win32") {
      const other = await resources();
      const binary = join(other.root, other.definitions.guardian.path);
      await rm(binary); await symlink(join(other.root, other.definitions.rclone.path), binary);
      await expect(new SidecarBinaryResolver(other.root, target, other.definitions).resolve()).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
    }
  });
});
