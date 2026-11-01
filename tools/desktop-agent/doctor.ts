import { readFile, access, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifyResource } from "./resources.ts";
import type { Input } from "./protocol.ts";
import { assertNativeHelper } from "./native-fingerprint.ts";

const run = promisify(execFile);
interface Check {
  name: string;
  status: "ready" | "blocked" | "unsupported";
  detail: string;
  repair?: string;
}
const json = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
export async function electronPath(root: string): Promise<string> {
  const value = (await readFile(join(root, "node_modules/electron/path.txt"), "utf8")).trim();
  if (!value || value.startsWith("/") || value.split(/[\\/]/).includes(".."))
    throw new Error("无效 Electron 路径");
  const path = join(root, "node_modules/electron/dist", value);
  await access(path);
  return path;
}
async function runtimeCheck(root: string): Promise<Check> {
  try {
    const executable = await electronPath(root);
    const script = `const DB=require(${JSON.stringify(join(root, "node_modules/better-sqlite3"))});const db=new DB(':memory:');const version=db.prepare('SELECT sqlite_version() AS value').get().value;db.close();console.log(JSON.stringify({electron:process.versions.electron,abi:process.versions.modules,sqlite:version}));`;
    const { stdout } = await run(executable, ["-e", script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 10000,
      maxBuffer: 8192,
    });
    const data = JSON.parse(stdout.trim());
    const expected = (await json(join(root, "apps/desktop/package.json"))).devDependencies.electron;
    if (data.electron !== expected || !data.sqlite) throw new Error("运行时不匹配");
    return {
      name: "electron-sqlite",
      status: "ready",
      detail: `Electron ${data.electron}，ABI ${data.abi}，SQLite ${data.sqlite}`,
    };
  } catch {
    return {
      name: "electron-sqlite",
      status: "blocked",
      detail: "Electron 不完整或 SQLite 原生 ABI 无法加载",
      repair: "npm ci，然后 npm run desktop:rebuild",
    };
  }
}
async function component(
  root: string,
  name: string,
  manifest: string,
  repair: string,
): Promise<Check> {
  try {
    await verifyResource(root, manifest, name);
    return { name, status: "ready", detail: "本机二进制／解析运行文件摘要与架构已核验" };
  } catch {
    return { name, status: "blocked", detail: "资源未准备、架构或完整性不匹配", repair };
  }
}
async function sourceMaps(root: string): Promise<Check> {
  try {
    await access(join(root, "apps/desktop/out/main/index.js.map"));
    await access(join(root, "apps/desktop/out/preload/index.js.map"));
    const files = await readdir(join(root, "apps/desktop/out/renderer/assets"));
    if (!files.some((file) => file.endsWith(".map"))) throw new Error("缺少页面映射");
    return {
      name: "source-maps",
      status: "ready",
      detail: "宿主、Preload 与页面构建映射存在；仍须校验构建指纹",
    };
  } catch {
    return {
      name: "source-maps",
      status: "blocked",
      detail: "当前桌面构建或源码映射缺失",
      repair: "npm run desktop:build",
    };
  }
}
async function lockCheck(root: string): Promise<Check> {
  try {
    const pkg = await json(join(root, "package.json")),
      lock = await json(join(root, "package-lock.json"));
    if (JSON.stringify(pkg.devDependencies) !== JSON.stringify(lock.packages[""].devDependencies))
      throw new Error("锁文件不符");
    return { name: "lockfile", status: "ready", detail: "根开发依赖与锁文件一致" };
  } catch {
    return {
      name: "lockfile",
      status: "blocked",
      detail: "依赖清单或锁文件缺失／不一致",
      repair: "核对依赖变更并执行 npm install，再使用 npm ci 验证",
    };
  }
}
async function nativeCheck(root: string, required: boolean): Promise<Check> {
  if (process.platform !== "darwin")
    return {
      name: "native-gui",
      status: "unsupported",
      detail: "本工具原生 GUI 驱动当前仅支持 macOS",
    };
  try {
    const { stdout } = await run(await assertNativeHelper(root), ["capabilities"], {
      timeout: 5000,
      maxBuffer: 8192,
    });
    const caps = JSON.parse(stdout);
    const ready =
      caps.accessibility === true && caps.screenCapture === true && caps.sessionLocked === false;
    return {
      name: "native-gui",
      status: ready ? "ready" : "blocked",
      detail: `辅助功能=${!!caps.accessibility}，屏幕录制=${!!caps.screenCapture}，锁屏或非交互会话=${caps.sessionLocked ?? "未知"}${required ? "" : "；本次未要求原生验收"}`,
      ...(!ready
        ? {
            repair:
              typeof caps.sessionLocked !== "boolean"
                ? "重新 desktop:agent:native:build 后再 doctor"
                : "解锁当前 macOS 会话，并在隐私设置为运行工具的应用授权，再重新 doctor",
          }
        : {}),
    };
  } catch {
    return {
      name: "native-gui",
      status: "blocked",
      detail: "原生 helper 尚未准备，本次不代表原生 GUI 验收",
      repair: "npm run desktop:agent:native:build",
    };
  }
}
export async function doctor(root: string, input: Input<"doctor">) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const checks: Check[] = [
    {
      name: "node",
      status: major! > 22 || (major === 22 && minor! >= 12) ? "ready" : "blocked",
      detail: process.version,
      repair: "使用 Node 22.12 或更高版本",
    },
  ];
  const target = `${process.platform}-${process.arch}`,
    resources = `apps/desktop/resources`;
  checks.push(
    ...(await Promise.all([
      lockCheck(root),
      runtimeCheck(root),
      sourceMaps(root),
      component(
        root,
        "parser",
        `${resources}/parser/${target}/manifest.json`,
        "npm run desktop:prepare-parser",
      ),
      component(
        root,
        "native-files",
        `${resources}/native-files/${target}/manifest.json`,
        "npm run desktop:prepare-native-files",
      ),
      component(
        root,
        "sidecars",
        `${resources}/sidecars/${target}/manifest.json`,
        "按 tools/desktop-sidecars/README.md 准备固定组件",
      ),
      component(
        root,
        "guardian",
        `${resources}/sidecars/${target}/guardian.json`,
        "python3 tools/desktop-sidecars/prepare_guardian.py --target " + target,
      ),
      nativeCheck(root, input.native),
    ])),
  );
  return {
    status: checks.every(
      (check) => check.status === "ready" || (check.name === "native-gui" && !input.native),
    )
      ? "ready"
      : "blocked",
    target,
    nativeRequired: input.native,
    checks,
  };
}
