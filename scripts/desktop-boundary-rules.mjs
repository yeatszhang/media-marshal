import { dirname, resolve } from "node:path";
import { builtinModules } from "node:module";

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
export function dependencyViolation(area, file, name) {
  const specifier = name.replaceAll("\\", "/");
  const resolved = resolve(dirname(file), name).replaceAll("\\", "/");
  const internal = specifier === "@media-marshal/contracts/internal" ||
    specifier.startsWith("@media-marshal/contracts/internal/") ||
    /\/packages\/contracts\/(?:src|dist)\/internal(?:\/|$)/.test(resolved);
  if (area === "packages/contracts/src" &&
      (builtins.has(name) || /electron|app-framework|media-core|react/.test(name)))
    return "契约必须独立于宿主、框架和 UI";
  if (area === "packages/contracts/src" && !file.replaceAll("\\", "/").includes("/src/internal/") && internal)
    return "公开契约不得导入或重导出内部宿主协议";
  if (area === "packages/media-core/src" && /^(electron|react(?:-dom)?(?:\/|$))|app-framework\/react/.test(name))
    return "媒体核心不能依赖 Electron/React";
  if (area === "packages/media-core/src" && /openlist|rclone|sidecar-host/i.test(name))
    return "云端业务不能导入具体网盘组件或宿主实现";
  if (area.includes("renderer") &&
      (builtins.has(name) || internal || /electron|media-core|better-sqlite3/.test(name) ||
       /\.\.\/.*(?:main|worker|infrastructure|sidecar-host)/.test(specifier)))
    return "Renderer 不能导入原生能力、媒体核心或内部宿主协议";
  if (area.includes("preload") && (internal || /app-framework|media-core|better-sqlite3|react/.test(name)))
    return "Preload 只保留公开受限桥接";
  if (/app-framework\/(?:src|dist|legacy)/.test(name))
    return "框架只使用公开的非 legacy 入口";
}
