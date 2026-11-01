# 读取 Electron 页面日志

本工具用于开发排障：从显式开启 CDP 的本机 Electron 读取普通控制台、未捕获异常及浏览器日志。现有 Main／Core／Sidecar 和 Renderer 结构化日志仍使用 `<userData>/logs/desktop.log`，见[桌面开发说明](../architecture/desktop-development.md#开发与本地日志)。

## 启动与读取

使用 Node.js 22.12+，在仓库根目录启动：

```bash
npm run desktop:dev:debug
```

另开终端读取日志：

```bash
npm run desktop:logs
npm run desktop:logs -- --duration 10
```

默认端口是 `9222`；启动命令也接受 `REMOTE_DEBUGGING_PORT`，显式 `--port` 优先。读取其他端口时，两个命令使用相同参数：

```bash
npm run desktop:dev:debug -- --port 9333
npm run desktop:logs -- --port 9333 --duration 10
```

启动入口调用原来的 `desktop:dev`，只增加开发态调试端口。已运行的普通开发进程需要退出并重新启动；仅刷新页面不会打开端口。工具不自动启动、重启或关闭目标应用。调试端口仅用于本机开发，不加入正式包默认启动行为。

## 选择窗口与 webview

只有一个 `page` 时自动选择；多个页面时拒绝猜测。先列出目标，再按返回的 ID 读取：

```bash
npm run desktop:logs -- --list
npm run desktop:logs -- --target 实际目标ID --duration 10
```

目标列表包含脱敏 URL、标题、ID 和类型。真正的 `<webview>` 类型是 `webview`，必须显式选择它的 ID；宿主页连接不代表同时采集访客页面。当前 Media Marshal 主界面使用 `BrowserWindow`，不需要放开项目已有的 `<webview>` 挂载限制。选择你需要排查的开发窗口，避免采集其他登录窗口。

## 输出与保存

标准输出为 JSON Lines。用 npm 的静默模式保存，避免 npm 命令回显混入文件：

```bash
npm run --silent desktop:logs -- --duration 10 > /tmp/media-marshal-renderer.log
```

事件包括 `connected`、`console`、`exception`、`browser`、`context.cleared` 和 `disconnected`。每条包含接收时间，日志包含目标 ID；原始协议时间保留在 `timestamp`，不同域的时间单位按 CDP 定义解释。`console` 包含参数及可用调用位置；对象最多读取两层、每层 30 个自身可枚举数据属性、每条最多 10 个参数，不调用 getter。`truncated` 标记属性或参数可能省略，`unavailable` 表示对象失效、连接关闭或属性读取超时。调用栈最多 16 帧，行列号沿用 CDP 的零起始定义。

共享脱敏器过滤敏感字段、认证文本及 HTTP URL 凭据和查询；目标及源码 URL 另外清除查询、凭据与片段，data URL 内容直接省略。未知异常仅输出类型和调用位置，不写原始异常 message。没有标签的秘密文本无法自动识别，不要主动打印凭据或第三方原始响应。

Chromium 可能补发连接前仍缓存的日志。工具始终输出 `historyComplete: false`，不保证历史完整，也不把没有采集到错误当作验证通过。对象属性是采集时的当前值，不保证等于打印时快照；页面刷新后可能无法读取旧引用。

待处理消息最多 100 条，单条协议消息超过 256 KiB 会丢弃，属性读取超时为 1.5 秒；最终 `disconnected.dropped` 报告丢弃数。进程强杀无法保证输出最终记录。Ctrl+C 或指定时长结束只断开读取器；目标关闭或意外断连返回非零退出码，按提示重新列出并选择目标。

## 验证

```bash
npm run test:desktop:logs
```

回归使用临时资料目录、隐藏 Electron 窗口和合成日志，覆盖历史／实时控制台、对象与访问器、异常脱敏、浏览器日志、真正的 webview、超大消息和断连；不读取个人凭据或真实媒体。该测试验证开发工具，不代替正式安装包或 Windows 实测。

协议依据：[Electron 调试端口](https://www.electronjs.org/docs/latest/api/command-line-switches#--remote-debugging-portport)、[electron-vite 调试](https://electron-vite.org/guide/debugging)、[CDP Runtime](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/js_protocol.pdl)、[CDP Log](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Log.pdl)。
