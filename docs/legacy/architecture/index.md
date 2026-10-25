# 架构总览

> 旧 Java / Vue / Docker 工程资料，已于 2026-10-25 归档。下文的“当前”指原文核对时点，不代表桌面客户端能力。

本文面向维护者，描述 Media Marshal 当前代码的模块边界、部署关系与扩展入口。处理细节见[发现与整理流程](./processing.md)，持久化和故障语义见[数据与恢复机制](./data-and-recovery.md)。安装步骤沿用[部署指南](../deployment.md)。

核对日期：2026-10-17；源码版本：`VERSION` 中的 `v0.2.13.1`。本文包含当前工作区尚未提交的增量扫描、Codex 识别和队列目录分组实现，不代表对应能力已发行或部署。本文记录源码现状；[旧架构决策历史](../design-decisions.md) 保留历史决策及其演变，早期描述需结合后续决策和代码阅读。

## 系统定位与边界

Media Marshal 是单实例、自托管的媒体文件整理应用。核心业务在 Java 后端：将源目录中的媒体识别为 TMDB 作品，经自动校验或人工确认后，按规则放入目标媒体库。Vue 前端负责配置、确认与修正；Python parser 仅解析名称。服务拆分主要用于隔离 Python 依赖，业务没有拆成独立的分布式服务。

系统不负责下载、播放或媒体服务器的用户管理。目前有 Emby 自动刷新集成；面向 Jellyfin / Plex 的文件整理不意味着具有同等的刷新接口集成。内置认证、Webhook 发现、ISO 整理和剧集蓝光整理尚未开放。当前不生成 NFO，已有 NFO 可以作为附属文件随媒体整理；`generateNfo` / `regenerateNfo` 仅保留兼容字段。

## 部署与依赖

```text
[Browser]
    |
    | HTTP :3000
    v
[portal / Nginx :80]
    | /api/*             | /ws
    +--------------------+
                         v
             [media-marshal :8080]
                  |    |    |    |
                  |    |    |    +--> [TMDB API / optional HTTP proxy]
                  |    |    +-------> [parser :8000 / guessit]
                  |    +------------> [SQLite /data/media-marshal.db]
                  +-----------------> [Mounted source / target media]
                  |
                  +--> [Optional Codex bridge :18081] --> [Codex CLI]
                  +--> [Optional Emby API / SMTP]

[Emby / Jellyfin / Plex] --> [Organized media library]
```

| 组件 | 技术与职责 | 持有状态 |
| --- | --- | --- |
| `frontend/`，部署为 `portal` | Vue 3、TypeScript、Vite、Element Plus、Pinia、vue-i18n；Nginx 提供静态页面与反向代理 | 内存页面状态；浏览器中的最近修正作业引用 |
| `backend/`，部署为 `media-marshal` | Java 21、Spring Boot 3.3.5、Spring MVC、JPA；业务编排、文件操作、配置与任务 API | SQLite、媒体文件；进程内扫描索引、缓存和执行器 |
| `parser/` | FastAPI、guessit；`GET /parse?filename=...`、`GET /health` | 不保存业务状态，不访问媒体目录 |
| `scripts/codex-bridge.py`，可选 | Python HTTP 服务桥接 Codex CLI，提供结构化名称建议 | 独立运行目录中的 JSON 缓存、`usage.db` 用量预算 |
| TMDB | 作品搜索、详情、季与分集信息 | 远端元数据；后端保留候选及已确认信息快照 |

标准拓扑以 `docker-compose.yml` 为准：前端默认映射宿主机 3000，后端默认映射 8080，parser 仅在 Compose 网络中可达。后端挂载 `mm_data:/data` 与 `${MEDIA_DIRS}:/media`；只有后端需要读写媒体。`docker-compose.beta.yml` 提供本地构建，`deploy/local/` 是单独的本机部署方案，不能混用它们的挂载和端口假设。

本地前端由 `frontend/vite.config.ts` 将 `/api` 和 `/ws` 代理到 8080；生产代理由 `frontend/nginx.conf` 提供。后端采用 Spring MVC 请求模型，虽然引入 WebFlux 用于 `WebClient`，外部 HTTP 调用仍使用 `.block(...)` 等待结果。

## 后端职责划分

下表中的包路径相对于 `backend/src/main/java/com/mediamarshal/`。

| 包 | 职责与关键入口 |
| --- | --- |
| `controller/` | HTTP 参数与响应；部分查询直接使用 Repository，业务动作调用服务 |
| `service/discovery/` | `FileDiscoveryService` 管理监听、补扫和入库前去重；`IncrementalDirectoryScanner` 保存目录快照 |
| `service/discovery/asset/` | `MediaAssetDetectionService` 按优先级调用资产探测器，区分视频文件、蓝光目录和 ISO |
| `service/pipeline/` | `MediaProcessPipeline` 串联解析、候选、确认、整理与状态持久化 |
| `service/parser/` | `GuessitParserClient` 调用 parser；`CodexRecognitionService` 校验桥接建议；`EpisodeSeasonResolver` 解析季号上下文 |
| `service/matcher/` | `MetadataMatcher` 定义元数据适配边界；TMDB 实现负责多查询、评分、父目录增强、缓存和季集校验 |
| `service/rename/` | 模板变量与渲染、路径校验、资产整理，以及 MOVE / COPY / HARD_LINK / SYMBOLIC_LINK 策略 |
| `service/queue/` | 待确认任务公共字段批量编辑、顺序集号预览和重新匹配 |
| `service/correction/` | 已完成资产的预览与修正、历史记录、持久化批量作业、并发占用与补偿 |
| `service/watchrule/` | 规则路径与操作能力预检、规则导入导出 |
| `service/settings/` | 配置生效来源、TMDB 代理特例与系统重置 |
| `service/emby/`、`notification/`、`websocket/` | 合并 Emby 刷新请求、邮件发送和 STOMP 事件发布 |
| `model/`、`repository/`、`config/` | 实体与 DTO、JPA 查询、Web 配置、数据库兼容迁移及作业启动恢复 |

扩展资产类型需同时考虑探测器、`AssetOrganizerStrategy`、模板变量和修正能力；只增加枚举不会自动获得整理支持。扩展文件操作可实现 `FileOperationStrategy`，并同步规则预检。扩展元数据源可从 `MetadataMatcher` 入手，但当前 TMDB 的季集服务和任务中的 `tmdbId` 仍是直接依赖，尚非完全可替换的通用插件系统。

## 前端组织与状态同步

`src/main.ts` 装配 Pinia、Router、Element Plus 和 i18n，并启动 STOMP 连接。路由守卫加载 `settingsStore`，缺少 TMDB Key 时进入 `/setup`；这是首次配置引导，不是认证。

| 页面 / 模块 | 边界 |
| --- | --- |
| `DashboardView.vue` | 任务列表、单项修正、已完成剧集批量修正；修正作业通过 HTTP 轮询查询 |
| `QueueView.vue` | 待确认任务、目录分组、候选与识别字段编辑；当前工作区按目录分页 |
| `PathsView.vue` | 规则 CRUD、预检、扫描、导入导出 |
| `SystemSettingsView.vue`、`DangerSettingsView.vue` | 业务配置、Codex / Emby 配置、系统重置 |
| `api/`、`types/` | Axios 调用封装与 TypeScript 合约 |
| `stores/` | `mediaStore` 保存所加载任务数组，`settingsStore` 保存配置及引导状态；页面同时持有交互状态 |
| `utils/queueDirectories.ts`、`utils/confirmQueueDirectory.ts` | 目录分组、候选覆盖与交集、季号解析、目录确认校验 |

HTTP 返回 `{ success, message, data }`。`api/http.ts` 既处理 HTTP 错误，也将 `success=false` 转为错误；HTTP 200 本身不能作为业务成功依据。`GET /api/tasks` 和 `GET /api/queue` 仍返回完整数组，分页发生在前端，尚无服务端分页协议。

WebSocket 端点是 `/ws`，内存 STOMP broker 的任务主题是 `/topic/tasks`。`EventPublisher` 发布任务创建、处理、待确认、完成、失败与被修正事件，载荷只有 `type`、`taskId`、`status`、`sourcePath`。当前 `wsClient.ts` 已连接并提供 `onTaskEvent`，但源码未发现页面或 Store 调用它注册处理器，因此列表尚未接通推送更新；需要通过已有 HTTP 加载动作更新。broker 没有消息持久化、离线重放或断线增量同步。

## HTTP 能力边界

以下是维护时的接口地图，字段细节以 Controller、DTO 和 `frontend/src/api/` 为准，不在此重复一份完整接口规范。

| 路径前缀 | 对应能力 |
| --- | --- |
| `/api/tasks` | 任务列表、详情、删除记录；删除记录不删除文件 |
| `/api/queue` | 待确认列表、候选、单条 / 批量确认、跳过、识别字段编辑、Codex 单文件 / 同目录重识别 |
| `/api/metadata/search` | 独立于任务的 TMDB 候选搜索 |
| `/api/tasks/{id}/correction` | 已完成任务重新匹配、预览、应用，以及同季 / 同剧集批量范围与应用 |
| `/api/task-correction-batches` | 按 ID 查询作业和失败项重试；当前没有作业列表接口 |
| `/api/watch-rules` | 规则 CRUD、预检、切换启用、手动扫描和导入导出 |
| `/api/template-variables` | 可用变量目录、模板预览 |
| `/api/settings`、`/api/emby/settings` | 配置、有效来源、代理配置、重置和 Emby 设置 |
| `/api/filesystem/browse` | 浏览后端可访问的目录；路径以服务端 / 容器视角解释 |

## 关键取舍与维护入口

当前架构以单机可部署性换取较低的运维复杂度：SQLite、进程内调度与缓存无需外部基础设施；代价是不能直接横向扩容、普通任务缺少崩溃续跑，较大的任务列表和目录树也会增加加载与扫描成本。已完成批量修正单独引入持久化作业，因为它需要逐项进度、失败重试和中断记录。

| 需要修改的行为 | 优先阅读的实现 | 对应回归测试 |
| --- | --- | --- |
| 发现、去重、增量目录索引 | `service/discovery/` | `FileDiscoveryIncrementalTest`、`IncrementalDirectoryScannerTest`、`FileDiscoveryMissingSourceTest` |
| 标题召回、置信度、季集校验 | `service/matcher/`、`MediaProcessPipeline` | `TitleSearchPlanBuilderTest`、`TmdbConfidenceScorerTest`、`TmdbEpisodeServiceTest`、`MediaProcessPipelineRecognitionTest` |
| Codex 协议与缓存预算 | `CodexRecognitionService`、`scripts/codex-bridge.py` | `CodexRecognitionServiceTest`、`scripts/test_codex_bridge.py` |
| 模板与文件路径 | `service/rename/` | `TemplateRendererTest`、`TemplatePathSafetyServiceTest`、`FileOperationStrategyTest` |
| 单项 / 批量修正及恢复 | `service/correction/`、`config/` | `TaskCorrectionServiceTest`、`TaskCorrectionBatchWorkerTest`、`TaskCorrectionBatchStateServiceTest`、迁移测试 |
| 队列目录确认 | `frontend/src/utils/`、`QueueView.vue` | `frontend/tests/queueDirectories.test.mjs`、`confirmQueueDirectory.test.mjs` |

后端测试入口为在 `backend/` 执行 `mvn test`，前端为在 `frontend/` 执行 `npm run test:queue` 和 `npm run build`，桥接为在根目录执行 `python3 -m unittest discover -s scripts -p test_codex_bridge.py`；这些是维护入口，不表示本文编写时已执行全部业务回归。文档检查入口为根目录 `npm run docs:build`。

目前 OpenSpec 已初始化，`openspec/specs/` 与活动变更均为空。本文是现状架构基线，没有将已有实现转写为新的需求，也没有创建实现变更。后续业务变更可从此定位相关模块，再在 OpenSpec 中描述增量要求。
