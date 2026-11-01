import { createRequire, setSourceMapsSupport } from "node:module";

// 必须早于应用及其共享 chunk 的加载；仅在业务入口中启用会漏掉自身的映射。
setSourceMapsSupport(true, { nodeModules: true });
createRequire(__filename)("./application.js");
