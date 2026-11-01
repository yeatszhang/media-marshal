import { createRequire, setSourceMapsSupport } from "node:module";

// Utility Process 的入口也必须在加载业务模块前启用堆栈映射。
setSourceMapsSupport(true, { nodeModules: true });
createRequire(__filename)("./core-application.js");
