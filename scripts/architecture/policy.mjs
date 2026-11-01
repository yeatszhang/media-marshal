import { builtinModules } from "node:module";

export const limits = { file: 600, function: 100, methods: 20 };
export const sourceRoots = [
  "apps/desktop/src",
  "packages/contracts/src",
  "packages/media-core/src",
  "tools/desktop-agent",
  "scripts",
];
export const nativeModules = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
export const rendererFeatures = [
  "recognition",
  "sync",
  "downloads",
  "corrections",
  "settings",
  "tasks",
  "accounts",
  "overview",
];
export const allowedCore = {
  configuration: [],
  library: ["configuration"],
  sync: ["configuration", "library"],
  ingestion: ["configuration", "library"],
  corrections: ["ingestion", "configuration", "library"],
  delivery: ["ingestion", "library"],
  retention: [],
};

/** 旧路径仍接受检查；移动后使用同一职责标识，不通过改名重置边界。 */
export function moduleOf(file) {
  if (file === "apps/desktop/src/logging/shared.ts") return "portable:logging";
  const core = "packages/media-core/src/";
  if (file.startsWith(core)) {
    const part = file.slice(core.length);
    if (/^(bootstrap|application|modules\/application)/.test(part)) return "core:bootstrap";
    const module = /^modules\/([^/]+)\//.exec(part)?.[1];
    if (module) return `core:${module}`;
    if (/^(domain|files|storage|adapters)\//.test(part)) return `core:${part.split("/")[0]}`;
    if (part.startsWith("infrastructure/"))
      return /migration|database/.test(part) ? "core:storage" : "core:adapters";
    if (part.startsWith("cloud/")) return "core:sync";
    if (part.startsWith("sources/")) {
      if (/configuration-directories/.test(part)) return "core:configuration";
      if (/emby-library|library-media/.test(part)) return "core:library";
      return /recognition|organization|automatic-consent/.test(part)
        ? "core:ingestion"
        : "core:sync";
    }
    if (part.startsWith("ingestion/")) {
      if (/download-cleanup/.test(part)) return "core:retention";
      if (/correction/.test(part)) return "core:corrections";
      if (/emby-delivery/.test(part)) return "core:delivery";
      return "core:ingestion";
    }
    return "core:public";
  }
  const renderer = "apps/desktop/src/renderer/src/";
  if (file.startsWith(renderer)) {
    const part = file.slice(renderer.length);
    return part.startsWith("features/")
      ? `renderer:${part.split("/")[1]}`
      : part.startsWith("shared/")
        ? "renderer:shared"
        : "renderer:app";
  }
  if (file.startsWith("packages/contracts/src/"))
    return file.includes("/internal/") ? "contracts:internal" : "contracts:public";
  if (file.startsWith("tools/desktop-agent/")) return "development:agent";
  return "host";
}

export function edgeReason(from, to, typeOnly = false) {
  const a = moduleOf(from),
    b = moduleOf(to);
  if (to.startsWith("tools/desktop-agent/") && from.startsWith("apps/desktop/src/"))
    return "产品源码不能导入开发控制工具";
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(to) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(from))
    return "产品源码不能导入测试";
  if (a.startsWith("contracts:") && !b.startsWith("contracts:")) return "契约不得引用应用实现";
  if (
    from.startsWith("apps/desktop/src/main/") &&
    b.startsWith("core:") &&
    !["core:public", "core:files"].includes(b)
  )
    return "Main 只能使用核心包公开入口与文件授权能力";
  if (
    from.startsWith("apps/desktop/src/sidecar-host/") &&
    b.startsWith("core:") &&
    b !== "core:files"
  )
    return "Sidecar 不得导入业务核心实现";
  if (a === "portable:logging" && !["portable:logging", "contracts:public"].includes(b))
    return "跨进程共享日志必须保持无宿主依赖";
  if (a === "contracts:public" && b === "contracts:internal") return "公开契约不能泄漏私有协议";
  if (a === "core:domain" && !["core:domain", "contracts:public"].includes(b))
    return "纯规则不能依赖 I/O 或业务模块";
  if (a === "core:files" && b === "core:storage") return "文件能力必须通过端口写业务日志";
  if (
    b === "core:storage" &&
    a.startsWith("core:") &&
    !["core:bootstrap", "core:storage"].includes(a) &&
    !(typeOnly && to === "packages/media-core/src/storage/public.ts") &&
    !from.includes("/persistence/")
  )
    return "原始数据库仅供 storage 与业务 persistence 使用";
  if (a.startsWith("core:") && b.startsWith("core:")) {
    const x = a.slice(5),
      y = b.slice(5);
    if (allowedCore[x] && allowedCore[y] && x !== y) {
      if (!allowedCore[x].includes(y)) return "业务依赖方向不允许";
      if (!/\/(public|index|ports)\.ts$/.test(to)) return "跨模块必须使用公开入口";
    }
    if (allowedCore[x] && y === "bootstrap") return "业务模块不能反向依赖组装入口";
    if (allowedCore[x] && y === "adapters" && !typeOnly) return "外部实现必须通过端口注入";
  }
  if (a.startsWith("renderer:") && b.startsWith("renderer:") && a !== b) {
    if (a === "renderer:shared" && b !== a) return "共享界面能力不能反向依赖业务";
    if (
      !["renderer:app", "renderer:shared"].includes(a) &&
      b !== "renderer:shared" &&
      !/\/public\.tsx?$/.test(to)
    )
      return "前端功能之间只能使用公开展示接口";
  }
}
