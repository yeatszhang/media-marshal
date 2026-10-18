# 本机桌面端自动入库提案

## 为什么

已经使用夸克、百度或阿里云盘客户端下载影视的 Emby 用户，需要把下载文件持续整理到本机媒体库。Media Marshal 已积累识别、人工确认、模板整理、修正与 Emby 集成规则；一期将这些能力迁入独立 Electron 客户端，降低部署和使用门槛，验证下载后自动入库的细分需求。付费规模尚待验证。

## 变更内容

- 以 monorepo 管理 Electron 应用、TypeScript 媒体核心和进程契约。React + TypeScript 重建客户端界面，electron-vite 构建，electron-builder 生成官网分发的 macOS/Windows 安装包。
- 采用 `wenger-repo/packages/app-framework` 的 `@yeatz/app-framework` 作为应用组织框架。Main、Utility Process 和 Renderer 各自拥有独立 Application，以静态模块、依赖注入、受管资源及生命周期组装功能；React 使用 StatefulService 与框架 hooks，页面临时状态仍使用 React。框架命令仅在进程内分发，IPC、安全校验和持久化恢复继续由客户端实现。
- 将一期所需 Java 业务逻辑迁入应用内的 TypeScript 核心，在 Electron Utility Process 中执行；Main 管理桌面能力和生命周期，Renderer 仅处理交互。不携带 JRE、不启动 Spring Boot 或本地 HTTP/WS 业务服务，无需用户安装 Docker、Node.js、Java 或 Python。
- 保留 guessit 的解析能力为随包冻结的离线子进程，通过受控管道调用，不携带 FastAPI/uvicorn 服务；独立客户端不等于只有一个操作系统进程。
- 提供夸克、百度、阿里云盘及自定义来源的本地目录接入。用户仍在官方客户端选择和下载内容；App 不登录网盘、不解析分享链接、不控制下载。
- 首版处理电影与普通剧集，目录接入只开放复制并保留来源；统一文件就绪检查、预览、低置信度确认、冲突阻断、持久化任务与中断核对。已整理目标的纠错保留预览和可恢复执行，不移动原下载文件。
- 将文件已整理、刷新待发送、等待收录与 Emby 已收录独立持久化；Emby 离线只重试交付，不再次复制媒体。
- 提供托盘、可选登录启动、暂停接入、恢复、受限 IPC、凭据保护及脱敏诊断。应用无需产品账户和自建后台，但 TMDB 查询及 Emby 访问仍依赖相应服务可用。
- 一期只交付独立客户端，不同步重建 Web/Docker 产品。既有 `backend/`、`frontend/`、`parser/` 与 Docker 入口作为历史实现及迁移参考保留，不进入桌面运行依赖，也不自动导入旧服务端数据库。
- 桌面与整理核心免费；官方 API、托管通知等付费服务和商店上架独立规划，见[商业与付费策略](../../../docs/product/business-and-operations.md)。

## 能力

### 新增能力

- `desktop-runtime`：独立客户端运行、框架模块与进程隔离、受限进程通信、生命周期、应用内媒体核心、React 状态、凭据与数据管理。
- `local-folder-ingestion`：来源引导、就绪检查、识别确认、模板整理、复制与修正恢复，以及业务迁移的行为契约。
- `emby-delivery`：本机连接、持久化刷新、收录核对及独立重试。
- `desktop-distribution`：自包含安装、平台签名、版本兼容、手动升级和数据保留。

### 修改能力

无。当前主规格目录为空；上述增量规格定义新客户端，不把旧 Web 服务的全部功能列入一期迁移承诺。

## 影响

- 新增 `apps/desktop/`、`packages/media-core/`、`packages/contracts/` 和 `tools/desktop-parser/`；采用 npm workspaces 与根锁文件管理新 TS 工程。现有文档站和旧应用构建保持可独立运行，不为了目录统一立即搬迁旧代码。
- 将发现、规则、解析结果归一化、TMDB 匹配/缓存、季集校验、模板、确认队列、复制、单条/批量修正和 Emby 客户端迁入本地核心；以旧测试和脱敏夹具验证等价行为，补齐旧实现不足的恢复语义。
- Spring Controller、JPA/Hibernate、STOMP、服务端启动配置不迁入客户端；Codex CLI 桥接、SMTP、MOVE/HARD_LINK/SYMBOLIC_LINK 入库、蓝光、ISO、音乐不进入一期桌面支持范围。
- SQLite 由媒体 Utility Process 独占，使用 better-sqlite3、显式 SQL 迁移、版本检查和一致性备份；Electron Main/Renderer 不直接打开业务库。
- 应用按框架公开子路径导入，领域纯函数和跨进程 contracts 不依赖框架；不复制其源码形成分叉，不引入第二套全局状态容器或 DI 容器。当前公开 registry 尚无法取得该包，首个实现使用随仓保存、含来源与校验值的构建包快照，发布后再显式切换到精确版本；正式安装与 CI 不依赖个人目录、全局链接或另一仓库的实时状态。
- 增加目录来源、候选、文件操作与 Emby 交付记录，保留任务完成与收录完成的区别。首次安装新建独立桌面库，旧 Java 库导入及新 Web 产品另立变更。
- 发行需要验证 Electron ABI 对应的原生 SQLite 模块和冻结 parser，携带许可及源码获取说明。Emby Server 与网盘客户端由用户自行安装，不打包进本应用。
