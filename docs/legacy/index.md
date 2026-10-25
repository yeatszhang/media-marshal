# 旧 Java / Vue / Docker 工程资料

这些资料于 2026-10-25 从 Cursor 规则目录迁入，保留旧项目行为、决策与验收证据，供维护旧工程和迁移规则时按需查阅。它们不是当前桌面架构，也不代表全部记录仍与当前源码一致。

## 阅读入口

| 资料 | 用途 |
| --- | --- |
| [项目上下文](./project-context.md) | 旧三服务部署、端口、配置优先级与能力边界 |
| [API 契约快照](./api-contracts.md) | 旧 HTTP / WebSocket 接口与数据结构；修改旧接口时需重新核对控制器、DTO 和测试 |
| [架构决策历史](./design-decisions.md) | ADR 编号、决策演变和被替代的设计 |
| [实施记录](./implementation-log.md) | 原日期的改动与验证证据，不将旧“下一步”作为当前待办 |
| [需求与验收快照](./requirements-status.md) | 当时的 REQ 编号与验收缺口，不作为新的实施清单 |
| [路线图快照](./project-roadmap.md) | 旧阶段规划和候选方向，不自动纳入当前交付范围 |

## 当前开发依据

- 当前桌面工程阅读[桌面客户端开发](../architecture/desktop-development.md)与[迁移基线](../architecture/desktop-migration.md)。仓库根 `AGENTS.md` 提供 Codex 的工程入口和按目录约束。
- 新需求、设计与任务维护在仓库 `openspec/`，不继续追加这里的历史 ADR、需求表或实施日志。旧工程有新的修改时，也在对应变更中记录与历史快照的差异，更新实际适用的维护文档。
- 快照中的“不做下载”、Vue 双语要求、Java HTTP 及四种文件操作不约束 Electron 客户端；具体交付边界以对应 OpenSpec 变更为准。
- 历史正文中保留原路径、时间和角色约定用于追溯；相邻文档的 Markdown 链接已更新，原 Cursor 元数据已移除。不得将历史成功记录当成本轮验证结果。
