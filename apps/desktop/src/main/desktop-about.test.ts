import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DesktopAboutController } from "./desktop-about";
const cleanup: (() => Promise<unknown>)[] = []; afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(packaged: boolean) {
  const root = await mkdtemp(join(tmpdir(), "marshal-about-")); cleanup.push(() => rm(root, { recursive: true, force: true })); const appRoot = join(root, "只读应用 空格"), resourcesRoot = join(root, "外部资源 中文"), target = "darwin-arm64";
  const put = async (path: string, text: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
  const resource = (file: string) => join(appRoot, "resources", file), sidecars = packaged ? join(resourcesRoot, "sidecars") : resource("sidecars/" + target), parser = packaged ? join(resourcesRoot, "parser") : resource("parser/" + target + "/runtime");
  for (const [file, text] of Object.entries({ "media-marshal.LICENSE": "项目 GPL 原文", "pinyin4j-NOTICE.txt": "拼音来源说明", "app-framework.LICENSE": "框架 MIT 原文", "framework-origin.json": JSON.stringify({ version: "0.1.0", integrity: "包来源摘要" }), [packaged ? "parser/manifest.json" : `parser/${target}/manifest.json`]: JSON.stringify({ guessitVersion: "3.8.0" }) })) await put(resource(file), text);
  for (const name of ["openlist", "rclone", "guardian"]) await put(join(sidecars, "licenses", name + ".LICENSE"), name + " 许可原文"); await put(join(sidecars, "SOURCE-NOTICE.txt"), "随包对应源码材料说明");
  await put(join(parser, "SOURCE-NOTICE.txt"), "冻结解析器来源说明"); for (const name of ["guessit-LICENSE", "babelfish-LICENSE", "rebulk-LICENSE", "Python.LICENSE"]) await put(join(parser, "licenses", name), name + " 原文");
  return { root, resource, sidecars, parser, put, about: new DesktopAboutController({ appRoot, resourcesRoot, target, packaged, appVersion: "0.2.1", electronVersion: "44.9.0" }) };
}
describe("固定随包版本与许可读取", () => {
  it.each([false, true])("开发／目录包布局 packaged=%s 使用各自资源根，材料不依赖核心或网络", async (packaged) => {
    const f = await fixture(packaged), about = await f.about.get(); expect(about).toMatchObject({ appVersion: "0.2.1", electronVersion: "44.9.0", packaged, target: "darwin-arm64" }); expect(about.components.find((value) => value.name === "冻结解析器（guessit）")?.version).toBe("3.8.0");
    const project = await f.about.license("application"); expect(project.text).toContain("项目 GPL 原文"); expect(project.text).toContain("拼音来源说明");
    expect((await f.about.license("framework")).text).toContain("包来源摘要"); for (const id of ["openlist", "rclone", "guardian"] as const) expect((await f.about.license(id)).text).toContain("随包对应源码材料说明"); const parser = await f.about.license("parser"); for (const name of ["guessit-LICENSE", "babelfish-LICENSE", "rebulk-LICENSE", "Python.LICENSE"]) expect(parser.text).toContain(name + " 原文");
  });
  it("许可缺失或过大明确提示完整重装，任意路径和未知标识不能读取私有文件", async () => {
    const f = await fixture(true); await f.put(join(f.root, "私有密文"), "不能读取的内容"); await expect(f.about.license("../../私有密文" as never)).rejects.toThrow();
    await rm(join(f.sidecars, "licenses/rclone.LICENSE")); await expect(f.about.license("rclone")).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE", message: expect.not.stringContaining(f.root) });
    await f.put(f.resource("app-framework.LICENSE"), "x".repeat(200001)); await expect(f.about.license("framework")).rejects.toThrow("随包许可不可读取");
    await f.put(f.resource("framework-origin.json"), "不完整来源材料"); expect((await f.about.get()).components.find((value) => value.name === "@yeatz/app-framework")?.version).toBe("未准备");
  });
});
