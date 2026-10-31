import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
if (process.platform !== "darwin") throw new Error("原生 GUI helper 当前仅在 macOS 构建");
const root = resolve(import.meta.dirname, "../..");
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
    resolve(root, "tools/desktop-agent/native/Helper.swift"),
    "-o",
    "tools/desktop-agent/.build/native-helper",
  ],
  { cwd: root, stdio: "inherit" },
);
console.log("macOS 开发用原生 GUI helper 已构建，未修改任何系统权限");
