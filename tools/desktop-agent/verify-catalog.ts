export const verifyChecks = [
  "architecture",
  "types",
  "business",
  "tools",
  "desktop",
  "packaged",
  "native",
  "docs",
  "specs",
  "benchmark",
] as const;
export type VerifyCheck = (typeof verifyChecks)[number];
export const verifyDescriptions: Record<VerifyCheck, string> = {
  architecture: "格式、依赖边界、结构预算与规则反例",
  types: "工作区及开发驱动类型检查",
  business: "契约、业务及 Renderer 组件断言",
  tools: "开发控制协议、驱动及证据负例",
  desktop: "当前开发构建的隔离 Electron 交互",
  packaged: "当前目录包资源检查及受管安装态 smoke",
  native: "macOS 原生观察／输入验收，缺能力明确受阻",
  docs: "文档构建及链接核对",
  specs: "OpenSpec 全量严格验证",
  benchmark: "当前设备的启动、交互、CPU／内存和队列样本",
};
