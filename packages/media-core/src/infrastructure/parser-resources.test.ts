import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ParserLaunch } from "@media-marshal/contracts/internal";
import { verifyParserResources } from "./parser-resources";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marshal-parser-resources-")); directories.push(root); const bytes = Buffer.alloc(128); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(process.arch === "arm64" ? 0x100000c : 0x1000007, 4);
  await writeFile(join(root, "parser"), bytes); await chmod(join(root, "parser"), 0o700);
  const descriptor: ParserLaunch = { root, manifest: { schemaVersion: 1, target: `${process.platform}-${process.arch}` as ParserLaunch["manifest"]["target"], protocolVersion: 1, guessitVersion: "3.8.0", pythonVersion: "3.11.14", sourceHash: "a".repeat(64), entryPoint: "parser", files: { parser: { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } } } };
  return descriptor;
}
describe.skipIf(process.platform !== "darwin")("冻结解析器资源边界", () => {
  it("摘要、架构、额外代码和空目录全部核验，不能只信任清单标签", async () => {
    const data = await fixture(); expect(await verifyParserResources(data)).toContain("parser");
    await writeFile(join(data.root, "unlisted.py"), "fixture"); await expect(verifyParserResources(data)).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" }); await rm(join(data.root, "unlisted.py"));
    await mkdir(join(data.root, "unlisted-directory")); await expect(verifyParserResources(data)).rejects.toThrow(); await rm(join(data.root, "unlisted-directory"), { recursive: true });
    await writeFile(join(data.root, "parser"), Buffer.alloc(128)); await expect(verifyParserResources(data)).rejects.toThrow();
    data.manifest.files.parser = { size: 128, sha256: createHash("sha256").update(Buffer.alloc(128)).digest("hex") }; await expect(verifyParserResources(data)).rejects.toThrow();
  });
  it("拒绝错误目标、路径穿越及指向外部目录的资源链接", async () => {
    const data = await fixture(); data.manifest.target = "win32-x64"; await expect(verifyParserResources(data)).rejects.toThrow(); data.manifest.target = `darwin-${process.arch}` as "darwin-arm64" | "darwin-x64";
    data.manifest.entryPoint = "../parser"; await expect(verifyParserResources(data)).rejects.toThrow(); data.manifest.entryPoint = "parser";
    const outside = await mkdtemp(join(tmpdir(), "marshal-parser-outside-")); directories.push(outside); await writeFile(join(outside, "fixture.py"), "fixture"); await symlink(outside, join(data.root, "outside"));
    data.manifest.files.outside = { link: outside }; await expect(verifyParserResources(data)).rejects.toThrow();
  });
  it.skipIf(!existsSync(resolve(`apps/desktop/resources/parser/darwin-${process.arch}/manifest.json`)))("实际冻结产物的全部运行文件和依赖可核验", async () => {
    const root = resolve(`apps/desktop/resources/parser/darwin-${process.arch}`), manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    expect(await verifyParserResources({ root: join(root, "runtime"), manifest })).toBe(join(root, "runtime", manifest.entryPoint));
  });
});
