import { execFile } from "node:child_process";
import { promisify } from "node:util";
/** Playwright 的 CJS 测试工作区通过固定 Node 入口核验 ESM 工具，不复制指纹规则。 */
export async function currentBuild(root: string) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      'import {assertBuild} from "./tools/desktop-agent/build.ts"; console.log(JSON.stringify(await assertBuild(process.cwd(), "development")));',
    ],
    { cwd: root },
  );
  return JSON.parse(stdout) as { buildId: string; manifest: string };
}
