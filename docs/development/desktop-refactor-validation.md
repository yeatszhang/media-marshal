# 桌面模块重构实施验证

本文件记录 `refactor-desktop-module-boundaries` 的当前实施证据。任务勾选以变更的 `tasks.md` 为准；下列基线通过不表示目录重构、开发自动化或发行验收已经完成。

## 实施起点与隔离

起点为 `1892c35`，使用分支 `codex/desktop-module-boundaries` 的隔离工作树。原工作区未提交的日志、锁文件及规划归档调整未带入提交。当前已提交的识别引擎、目录工作台与 175 项旧用例对照作为本轮行为基线，不能为了重组回退。

环境为 macOS arm64、Node 22.23.1、Electron 44.9.0，业务 schema 35、协议 1。依赖使用锁文件独立 `npm ci`；安全文件组件重新编译，Rclone／OpenList 从固定清单核验的归档准备，Guardian 使用锁定 Go 工具链重新构建。

## 2026-11-01 基线与格式化

- 工作区类型检查通过，原有 contracts／Core／Renderer／Preload 边界检查通过。
- 完整基线首轮：1289 passed、3 failed、17 skipped；失败均为新工作树未准备 Rclone／Guardian 资源。准备后对应两个文件复跑为 99 passed、1 skipped。
- 格式化后的完整回归：130 个文件通过、3 个文件条件跳过；1292 项通过、17 项条件跳过，0 失败。使用 Electron Node 运行器，未连接个人账号或处理真实媒体。
- 格式检查连续通过，类型检查与边界检查通过。格式化提交只调整排版、固定 Prettier 3.9.10 及增加格式命令；生成字表、冻结夹具、产物与历史源码排除。

复现命令：先按桌面开发说明准备依赖、固定 Sidecar 与原生文件资源，依次运行 `npm run typecheck`、`npm run check:boundaries`、`npm run format:check`、`npm test`。类型构建和测试不要并行写同一 dist。

## 行为回归入口

| 范围 | 当前入口 |
| --- | --- |
| 请求、启动回滚与关闭顺序 | `packages/media-core/src/modules/application.test.ts`、`application/request-executions.test.ts`、Main supervisor 测试 |
| 识别策略与目录工作台 | `ingestion/recognition-strategies.test.ts`、`codex-*.test.ts`、`pipeline.test.ts`、Renderer recognition／ingestion 用例及识别迁移对照检查 |
| 来源与成功历史 | `sources/sync-rules.test.ts`、`sync-receipts.test.ts`、`recognition-rules.test.ts`、`scans.test.ts` |
| 下载提交和恢复 | `apps/desktop/src/main/cloud/downloads.test.ts`、`download-crash.test.ts`、`no-overwrite.test.ts` |
| 整理、修正与清理 | `ingestion/pipeline.test.ts`、`corrections.test.ts`、`download-cleanup*.test.ts`、`files/relocations.test.ts` |
| Emby 与目录身份 | `ingestion/emby-delivery.test.ts`、`emby-paths.test.ts`、Main configuration-directories 测试 |
| GUI 与安装态 | 重新构建后运行 `apps/desktop/tests/`；尚未在本阶段执行，不能用单元基线替代 |

后续每组实施在该组交付时补充对应验证结果，最终集成验收再报告完整矩阵。

## 架构约束首次接入

格式化后测得 390 项精确存量例外，静态 DDL 登记 122 张表。例外均关联任务、责任角色和期限；新检查工具自身没有结构例外。它们是待修复清单，不是模块重构完成证明。

`check:architecture` 通过，规则正反例与 CLI 基点测试共 8 项通过，文档构建通过。快速架构工作流已加入源码；只读查询确认 main 的传统分支保护不存在、有效分支规则为空。未推送或修改远端保护，不声称远端 CI 已执行或合并已被强制拦截。
