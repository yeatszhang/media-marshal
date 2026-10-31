# 桌面开发控制工具

统一入口供 Codex 和本地开发脚本调用，协议使用 JSON。当前已交付命令参数、结果、异步收据和 CLI 基础；具体能力按 OpenSpec 任务逐项接入，未接入命令返回 `blocked`，不会报告为验证成功。

```sh
npm run --silent desktop:agent -- help --json
npm run test:desktop-agent
npm run typecheck:desktop-agent
```

复杂参数使用 `--input 请求参数.json`，会话使用 `--session UUID`，幂等请求使用 `--request UUID`。help 返回命令的 JSON Schema；不接受额外属性、任意代码、SQL 或任意 IPC 动作。stdout 仅输出一条 JSON 结果，结果包含协议版本、请求身份、状态和可信修复动作。

异步操作返回 jobId；重复请求继续使用原收据。相同请求 ID 携带不同输入会拒绝，超时或取消可能只结束等待，必须先查询结果，不能重新确认写操作。收据容量耗尽时拒绝新请求，不静默淘汰旧写操作身份。

开发工具不进入发行包，不连接用户正在使用的实例。完整能力和验收条件见 `openspec/changes/refactor-desktop-module-boundaries/`；架构检查同样覆盖本目录。
