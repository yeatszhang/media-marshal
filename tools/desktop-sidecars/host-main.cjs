// 仅供真实 Utility Host 验收，无窗口、凭据或业务入口。
const { app } = require("electron");
const root = process.argv.find((arg) => arg.startsWith("--fixture-root="))?.slice("--fixture-root=".length);
if (!root) throw new Error("缺少临时数据目录");
app.setPath("userData", root);
app.whenReady().then(() => { setInterval(() => {}, 1000); });
