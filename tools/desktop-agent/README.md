# 桌面开发控制工具

统一入口供 Codex 和本地开发脚本调用，协议使用 JSON。当前已交付命令参数、结果、异步收据、环境诊断和 CLI 基础；具体能力按 OpenSpec 任务逐项接入，未接入命令返回 `blocked`，不会报告为验证成功。

```sh
npm run --silent desktop:agent -- help --json
npm run --silent desktop:agent -- doctor --json
npm run test:desktop-agent
npm run typecheck:desktop-agent
```

复杂参数使用 `--input 请求参数.json`，会话使用 `--session UUID`，幂等请求使用 `--request UUID`。help 返回命令的 JSON Schema；不接受额外属性、任意代码、SQL 或任意 IPC 动作。stdout 仅输出一条 JSON 结果，结果包含协议版本、请求身份、状态和可信修复动作。

异步操作返回 jobId；重复请求继续使用原收据。相同请求 ID 携带不同输入会拒绝，超时或取消可能只结束等待，必须先查询结果，不能重新确认写操作。收据容量耗尽时拒绝新请求，不静默淘汰旧写操作身份。

开发工具不进入发行包，不连接用户正在使用的实例。完整能力和验收条件见 `openspec/changes/refactor-desktop-module-boundaries/`；架构检查同样覆盖本目录。

`doctor` 只读检查依赖、Electron／SQLite ABI、源码映射和本机资源，不自动安装或下载。资源缺失返回 `blocked` 和修复命令，退出码为 2。原生权限严格检查使用输入 `{"native": true}`；后台 DOM 自动化不需要屏幕录制权限。

macOS 原生 helper 需显式执行 `npm run desktop:agent:native:build`。其能力探测不会弹出或操作权限确认；系统未授权录屏时原生截图保持受阻。helper 仅面向本工作树中使用工具隔离 profile 的进程，拒绝不匹配的可执行文件、创建时间和界面指纹，输出只进入新的会话证据文件。

当前原生 helper 已通过编译、能力探测及非法输入／进程拒绝测试；完整目标身份、窗口代际和前台原生流程仍在任务 2.12／2.13 验收，不能将这些探测结果算作原生交互已通过。
