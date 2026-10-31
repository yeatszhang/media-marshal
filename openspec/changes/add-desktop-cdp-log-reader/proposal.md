# 开发态 Electron 页面日志读取

## Why

当前普通页面控制台只在 DevTools 可见，开发工具不能直接读取。沿用现有 Electron CDP 能力提供显式开发入口和日志读取命令，减少人工转述。

## What Changes

- 增加跨平台开发调试启动命令，默认使用本机 9222 端口。
- 增加目标发现、显式选择及有界 JSONL 日志采集，覆盖控制台、未捕获异常和浏览器日志。
- 复用现有脱敏器，提供隔离真实 Electron 回归与排障文档。

## Capabilities

### New Capabilities

无产品规格新增。本次是独立开发工具，使用 `skip_specs: true`。

### Modified Capabilities

无。`refactor-desktop-module-boundaries` 的统一自动化会话、日志关联和证据平台仍按原任务验收，本工具不代表这些任务完成。

## Impact

涉及根目录 npm scripts、开发脚本、隔离测试及开发文档；不增加依赖，不修改 Main／Preload／Renderer 或正式包配置，不改变现有日志落盘策略。
