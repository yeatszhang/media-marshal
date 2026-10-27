import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DesktopError, desktopAboutSchema, licenseIdSchema, licenseTextSchema, type LicenseId, type LicenseText } from "@media-marshal/contracts";
import lock from "../../../../tools/desktop-sidecars/sidecars.lock.json";
interface AboutEnvironment { appRoot: string; resourcesRoot: string; packaged: boolean; target: string; appVersion: string; electronVersion: string }
export class DesktopAboutController {
  constructor(private readonly environment: AboutEnvironment) {}
  private get parser() { const e = this.environment; return e.packaged ? join(e.resourcesRoot, "parser") : join(e.appRoot, "resources/parser", e.target, "runtime"); }
  private get sidecars() { const e = this.environment; return e.packaged ? join(e.resourcesRoot, "sidecars") : join(e.appRoot, "resources/sidecars", e.target); }
  private async read(path: string) { const data = await readFile(path); if (data.length > 200000) throw new Error(); return data.toString("utf8"); }
  async get() {
    const e = this.environment; let guessit = "未准备", framework = "未准备";
    try { const parserPath = e.packaged ? join(e.appRoot, "resources/parser/manifest.json") : join(e.appRoot, "resources/parser", e.target, "manifest.json"); const manifest = JSON.parse(await this.read(parserPath)); if (typeof manifest.guessitVersion === "string") guessit = manifest.guessitVersion; } catch {}
    try { const origin = JSON.parse(await this.read(join(e.appRoot, "resources/framework-origin.json"))); if (typeof origin.version === "string") framework = origin.version; } catch {}
    return desktopAboutSchema.parse({ appVersion: e.appVersion, electronVersion: e.electronVersion, target: e.target, packaged: e.packaged, components: [
      { name: "Media Marshal 与自有文件组件", version: e.appVersion, license: "GPL-3.0", licenseId: "application" },
      { name: "@yeatz/app-framework", version: framework, license: "MIT", licenseId: "framework" },
      { name: "冻结解析器（guessit）", version: guessit, license: "LGPL-3.0 及各依赖许可", licenseId: "parser" },
      { name: "OpenList", version: lock.components.openlist.version, license: lock.components.openlist.license.spdx, licenseId: "openlist" },
      { name: "Rclone", version: lock.components.rclone.version, license: lock.components.rclone.license.spdx, licenseId: "rclone" },
      { name: "Guardian", version: "随应用构建", license: "GPL-3.0", licenseId: "guardian" },
    ] });
  }
  async license(input: LicenseId): Promise<LicenseText> {
    const id = licenseIdSchema.parse(input), e = this.environment;
    const entries: Record<LicenseId, { title: string; paths: string[] }> = {
      application: { title: "Media Marshal · GPL-3.0", paths: [join(e.appRoot, "resources/media-marshal.LICENSE"), join(e.appRoot, "resources/pinyin4j-NOTICE.txt")] },
      framework: { title: "@yeatz/app-framework · MIT", paths: [join(e.appRoot, "resources/app-framework.LICENSE"), join(e.appRoot, "resources/framework-origin.json")] },
      openlist: { title: "OpenList · AGPL-3.0-only", paths: [join(this.sidecars, "licenses/openlist.LICENSE"), join(this.sidecars, "SOURCE-NOTICE.txt")] },
      rclone: { title: "Rclone · MIT", paths: [join(this.sidecars, "licenses/rclone.LICENSE"), join(this.sidecars, "SOURCE-NOTICE.txt")] },
      guardian: { title: "Guardian · 项目许可", paths: [join(this.sidecars, "licenses/guardian.LICENSE"), join(this.sidecars, "SOURCE-NOTICE.txt")] },
      parser: { title: "解析器与依赖许可", paths: [join(this.parser, "SOURCE-NOTICE.txt"), ...["guessit-LICENSE", "babelfish-LICENSE", "rebulk-LICENSE", "Python.LICENSE"].map((name) => join(this.parser, "licenses", name))] },
    };
    try { const entry = entries[id], texts = await Promise.all(entry.paths.map((path) => this.read(path))); return licenseTextSchema.parse({ title: entry.title, text: texts.join("\n\n────────\n\n") }); }
    catch { throw new DesktopError("COMPONENT_UNAVAILABLE", `「${entries[id].title}」随包许可不可读取，请重新安装完整客户端；不会从网络替换许可材料`); }
  }
}
