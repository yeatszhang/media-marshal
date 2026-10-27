# Media Marshal 仓库指引

## 当前工程与边界

- 当前开发主体是 `apps/desktop/`（Electron + React）、`packages/contracts/` 和 `packages/media-core/`（TypeScript）。桌面运行不依赖旧 Java 服务或旧数据库。
- `backend/`、`frontend/`、`parser/` 与 Docker 入口属于旧工程，仅在任务明确涉及它们或需要行为对照时修改；其目录内 `AGENTS.md` 不适用于桌面工作区。`tools/desktop-parser/` 是桌面冻结解析器，不是旧 HTTP parser。
- 产品范围、设计与任务状态以对应的 `openspec/changes/` 和已落地主规格为准，不能从旧路线图或现有枚举推断本轮承诺。规划完成、代码实现、测试通过和发行验收分开记录。
- 新规划和实施证据使用 OpenSpec 及对应架构／验收文档；`docs/legacy/` 是只供按需查阅的旧工程快照，不继续维护第二套需求、ADR 或进度日志。历史正文中的角色要求和“必须先读全部文档”不作为当前指令。

## 知识入口

| 任务 | 优先阅读 |
| --- | --- |
| 桌面开发、构建、进程与框架边界 | [桌面客户端开发](docs/architecture/desktop-development.md) |
| 从旧工程迁移业务规则 | [迁移基线](docs/architecture/desktop-migration.md)，再按需查询[旧工程资料](docs/legacy/index.md) |
| 来源、网盘与传输 | [统一来源](docs/architecture/source-rules.md)、[下载内部边界](docs/architecture/cloud-downloads-internal.md)、[扩展开发](docs/architecture/cloud-adapter-development.md) |
| 识别、整理与 Emby 交付 | [识别规则](docs/architecture/desktop-recognition.md)、[整理流水线](docs/architecture/desktop-ingestion.md) |
| 修改错误处理或交互反馈 | [错误反馈约定](docs/development/error-feedback.md) |
| 产品范围与商业方向 | 对应 OpenSpec 变更、[产品定位](docs/product/positioning.md)与[商业策略](docs/product/business-and-operations.md) |

## 工程约束

- Renderer 只使用受限业务 IPC，不导入 Node 或媒体核心；Preload 保持最小桥接。Core 独占业务 SQLite，Main 管理原生窗口、目录授权和凭据；遵循现有边界检查。
- 保留文件操作的预览、授权、幂等和恢复边界；数据库回退不等于撤销媒体文件操作。测试使用隔离目录，不擅自接管真实媒体、修改个人凭据或沿用旧构建冒充当前验收。
- 错误应包含可定位对象、可信原因和修复动作，异步／批量失败持久可查；不显示凭据或原始敏感响应。具体约定见上方错误反馈文档。
- 用实际源码、契约和测试核对历史说明；发现不一致时修正受影响的当前文档，不照抄旧行为或把用户产品决策交给历史 PM 角色。
- 按全局规则小步提交，只暂存本轮内容；目录外已有改动或同一文件其他差异不得混入。

## 验证入口

根目录使用 npm workspaces；按改动选择必要检查，命令和环境说明见桌面开发文档：

- 类型与边界：`npm run typecheck`、`npm run check:boundaries`。
- 核心／契约／组件：`npm test`（仓库运行器使用 Electron Node，原生 SQLite ABI 须匹配）。
- 桌面交互与安装态：`npm run test:desktop`、`npm run test:packaged`；原生 OS 行为与正式发行要求按对应任务单独验证。
- 文档：`npm run docs:build`；OpenSpec：`openspec validate --all --strict`。
- 指令迁移的场景核对见 [Codex 指令检查](docs/development/agent-instructions-checks.md)。纯文档改动不默认运行媒体业务全量测试。
