# 实施任务

## 1. 开发态日志入口

- [x] 1.1 实现开发启动及 CDP 日志命令，覆盖目标选择、控制台对象、异常、脱敏、超时和退出；用隔离 Electron 及参数／断连回归验证，并补充使用文档。

## 2. 集成检查

- [x] 2.1 运行工具回归、边界检查、文档构建及 OpenSpec 严格验证，记录通过范围与未验证平台，精确提交本轮内容。

## 验证记录

- 环境：macOS arm64、Node v22.23.1、Electron 44.9.0；Windows 和 Node 22.12 最低版本未实测。
- `npm run test:desktop:logs`：5/5 通过，包含真实 Electron、真实命令 JSONL、定时停止及 SIGINT；启动命令通过 npm 替身核验传参，未启动个人应用资料目录。
- `npm run check:boundaries`、`npm run docs:build`、脚本语法检查及 `git diff --check` 通过。
- `openspec validate add-desktop-cdp-log-reader --strict` 通过。
- `openspec validate --all --strict` 当次因独立在编变更 `migrate-complete-recognition-strategies` 缺少 delta 规格失败；本变更及其余当次检查项通过，不修改其他任务的规划文件。
- 本工具不涉及产品打包、业务流程或发行验收；未运行这些全量检查。
