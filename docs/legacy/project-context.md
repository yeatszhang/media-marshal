---
search: false
---

> 旧 Java/Vue/Docker 工程历史快照，迁移于 2026-10-25。下文“当前”、完成状态、维护要求和待办均保留原记录口径，不作为当前桌面客户端的指令、进度或接口依据。新工作使用 OpenSpec；旧路径和 `.mdc` 文件名仅用于历史追溯。参见[旧工程资料索引](./index.md)。

# Media Marshal 项目上下文

## 项目定位
为 Emby / Jellyfin / Plex 用户提供媒体文件自动整理工具：识别、重命名、生成 NFO 元数据。Docker 原生部署，Web UI 操作。

## 技术栈
- **Backend**: Java 21 + Spring Boot 3.3.x + Maven，包名 `com.mediamarshal`
- **Frontend**: Vue 3 + TypeScript + Vite + Element Plus + Pinia + vue-i18n
- **Parser Sidecar**: Python 3 + FastAPI + guessit（HTTP 微服务）
- **数据库**: SQLite（JPA + Hibernate Community Dialects），文件路径 `/data/media-marshal.db`
- **部署**: Docker + Docker Compose（三服务：media-marshal、portal、parser；前端源码目录为 `frontend/`）

## 服务端口
- `media-marshal` (Java): 8080
- `portal` (Nginx): 容器端口 80，默认宿主机 3000；前端本地开发默认 3000
- `parser` (Python): 8000（仅内部网络，不对外暴露）

## 当前需求基线
- 当前工作区版本以根目录 `VERSION` 为准；2026-09-05 核对为 `v0.2.13.1`，不代表远端已发行。
- 需求状态与验收见 `requirements-status.mdc`，阶段顺序见 `project-roadmap.mdc`，设计见 `design-decisions.mdc`，实际接口见 `api-contracts.mdc`。
- 已完成任务单项修正、普通剧集同季 / 同剧集批量修正及 Queue 公共识别信息批量编辑均已实现；不再按待开发能力安排。

## 核心处理流程
文件发现 → guessit 解析 → TMDB 匹配 → 置信度判断（低则进队列）→ 按规则移动 / 复制 / 链接 → 附属文件处理与可选 NFO 生成 → WebSocket 推送完成。

已完成任务修正基于当前目标资产，经预览后执行并建立 `CORRECTED -> DONE` 历史；剧集批量修正使用持久化后台作业。

## 配置优先级（从高到低）
- 普通配置：环境变量 `MEDIA_MARSHAL_*` > `application.yml` > 数据库 `app_setting` 表 > 默认值。
- `tmdb.api-key` 例外：只从数据库读取，由 Web UI 保存。
- TMDB 代理例外：经 `TmdbProxySettingsService` 解析，Web UI 显式保存优先；未保存时才回退环境变量 / application 配置，见 ADR-024。

## 关键设计模式
- **策略模式**: `FileOperationStrategy` — MOVE/COPY/HARD_LINK/SYMBOLIC_LINK 均已实现，保存前支持能力预检。
- **适配器模式**: `MetadataMatcher` — 当前实现 TMDB，预留豆瓣等扩展

## 通知方式
- WebSocket (STOMP): 实时推送任务状态到前端，订阅 `/topic/tasks`
- 邮件：后端有低置信度 / 失败发送逻辑，系统设置入口禁用；当前不作为完整开放的产品能力。

## 当前能力限制
- 支持普通电影、普通剧集、连续多集和电影蓝光目录；ISO、剧集蓝光、裸 `sourceDir/BDMV` 当前跳过。
- Dashboard / Queue 有前端分页，任务接口仍返回数组；尚无独立完整任务管理与扫描作业页。
- 批量修正范围由后端跨分页解析，但最近作业找回依赖当前浏览器本地索引，待补服务端检索。
- SQLite 单实例单连接，现有显式迁移与 `ddl-auto=update` 并存；正式升级 / 备份恢复需独立验证。

## 国际化
- 前端从第一行代码开始支持中英文（vue-i18n），语言文件在 `frontend/src/i18n/`
- i18n key 命名：`模块.子键`，如 `nav.dashboard`、`task.status.DONE`

## 不做的事
- 不做内容下载、PT 站集成、播放器
- 不做用户认证（v1，后续用 Spring Security 扩展）
