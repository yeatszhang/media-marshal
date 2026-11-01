import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { nativeInputs, nativeBuildRecord } from "./native-fingerprint.ts";
if (process.platform !== "darwin") throw new Error("原生 GUI helper 当前仅在 macOS 构建");
const root = resolve(import.meta.dirname, "../..");
const input = await nativeInputs(root);
mkdirSync(resolve(root, "tools/desktop-agent/.build"), { recursive: true, mode: 0o700 });
execFileSync(
  "xcrun",
  [
    "swiftc",
    "-parse-as-library",
    "-swift-version",
    "5",
    "-O",
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
    "-framework",
    "ScreenCaptureKit",
    ...input.sources,
    "-o",
    "tools/desktop-agent/.build/native-helper",
  ],
  { cwd: root, stdio: "inherit" },
);
const manifest = await nativeBuildRecord(root);
const after = await nativeInputs(root);
if (
  input.source !== after.source ||
  input.builder !== after.builder ||
  input.observation !== after.observation
)
  throw new Error("原生构建期间源码发生变化，保留旧清单并拒绝当前产物");
const path = resolve(root, "tools/desktop-agent/.build/native-manifest.json"),
  temporary = path + "." + randomUUID() + ".tmp";
writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
renameSync(temporary, path);
console.log("macOS 开发用原生 GUI helper 已构建，未修改任何系统权限");
