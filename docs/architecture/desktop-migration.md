# 桌面客户端迁移基线

本表用于独立 Electron 客户端的实施追踪。Java 路径相对于 `backend/src/main/java/com/mediamarshal/`，测试路径相对于 `backend/src/test/java/com/mediamarshal/`；旧源码继续保留在原目录。表中目标是需要实现的行为，不代表已迁移完成。客户端仅处理电影、普通剧集和 COPY 来源。

| 能力 | 原实现 | 行为证据 | 客户端迁移方式与验收边界 |
| --- | --- | --- | --- |
| 规则与目录 | `service/watchrule/WatchRulePreflightService.java`、`model/entity/WatchRule.java` | `service/watchrule/WatchRulePreflightServiceTest.java`；`frontend/src/views/PathsView.vue` | 重做原生目录选择和真实路径校验；来源/目标物理隔离、跨规则重叠、权限、缺盘、符号链接必须检查 |
| 忽略规则 | `service/discovery/DiscoveryIgnoreService.java`、`SampleVideoDetector.java` | `service/discovery/DiscoveryIgnoreServiceTest.java`、`SampleVideoDetectorTest.java` | 迁移默认规则、显式空列表及样片语义；不从规则名称猜网盘完成状态 |
| 事件与补扫 | `service/discovery/FileDiscoveryService.java`、`IncrementalDirectoryScanner.java` | `service/discovery/FileDiscoveryIncrementalTest.java`、`FileDiscoveryMissingSourceTest.java`、`IncrementalDirectoryScannerTest.java` | 重做持久化候选和统一就绪入口；监听、启动、手动、周期扫描不得绕过观察；根不可访问不等于删除 |
| 名称解析 | `service/parser/GuessitParserClient.java`、`model/dto/ParseResult.java`；`parser/main.py` | `model/dto/ParseResultTest.java`；原 parser 响应 | 保留 guessit 3.8 结果语义，HTTP 包装替换为冻结 stdio；仅名称数据、有界 JSON Lines、超时/EOF 清理 |
| 季号解析 | `service/parser/EpisodeSeasonResolver.java` | `service/parser/EpisodeSeasonResolverTest.java` | 迁移季号及绝对集映射，特殊集和歧义不自动通过 |
| 查询计划 | `service/matcher/TitleSearchPlanBuilder.java`、`ParentFolderContextExtractor.java` | `service/matcher/TitleSearchPlanBuilderTest.java`、`ParentFolderContextExtractorTest.java` | 提取确定性夹具，保留原名称、guessit、清洗、去年份重试及父目录证据上限 |
| 匹配与评分 | `service/matcher/TmdbMetadataMatcher.java`、`TmdbConfidenceScorer.java`、`ParentFolderMatchEnhancer.java` | `service/matcher/TmdbMetadataMatcherTest.java`、`TmdbConfidenceScorerTest.java`、`ParentFolderMatchEnhancerTest.java` | 保留候选合并和可解释评分，不用简单标题搜索替代；低置信度留待确认 |
| TMDB 缓存 | `service/matcher/TmdbInMemoryCache.java`、`TmdbPersistentCache.java` | 对应同名 `Test.java` | 内存请求合并及 SQLite 成功结果缓存；TTL、语言/类型键、8 MiB 限制、网络错误不缓存为成功 |
| 真实分集 | `service/matcher/TmdbEpisodeService.java` | `service/matcher/TmdbEpisodeServiceTest.java` | 保留实际集号集合校验，合并集必须全部存在；自动/人工/修正共用 |
| 命名模板 | `service/rename/TemplateRenderer.java`、`TemplateVariables.java`、`TemplateRange.java` | `service/rename/TemplateRendererTest.java`、`TemplatePreviewServiceTest.java` | 迁移可选片段、空值、范围、补零、前后缀、中文首字母与预览；禁止偷换模板语义 |
| 路径安全 | `service/rename/TemplatePathSafetyService.java` | `service/rename/TemplatePathSafetyServiceTest.java` | 强化为真实路径及平台命名检查；旧词法校验不足不作为兼容行为 |
| 自动流水线 | `service/pipeline/MediaProcessPipeline.java`、`AutomaticOrganizationGuard.java` | `service/pipeline/MediaProcessPipelineRecognitionTest.java`、`AutomaticOrganizationGuardTest.java` | 保留识别/确认边界；重做持久化领取、幂等、取消和崩溃核对 |
| 人工/批量确认 | `service/queue/QueueBatchRecognitionService.java`、`controller/QueueController.java` | `service/queue/QueueBatchRecognitionServiceTest.java`；`frontend/src/views/QueueView.vue`、`frontend/tests/queueRecognition.test.mjs` | 编辑不产生文件操作，目录分组不等于整组可确认；季集重复/重叠阻断 |
| 普通复制及附属文件 | `service/rename/CopyRenameStrategy.java`、`VideoFileAssetOrganizer.java`、`RenameService.java` | `service/rename/FileOperationStrategyTest.java`、`RenameServiceTest.java` | 重做同卷临时文件、流式摘要、来源快照、不覆盖提交及逐项恢复；主文件和字幕状态分离 |
| 单条修正与历史 | `service/correction/TaskCorrectionService.java`、`TaskCorrectionPersistenceService.java`、`TaskCorrectionFileExecutor.java` | `service/correction/TaskCorrectionServiceTest.java`、`TaskCorrectionConcurrencyGuardTest.java` | 仅改已整理目标，来源不动；预览指纹、历史链、持久化文件日志取代内存补偿 |
| 同季/同剧修正 | `service/correction/TaskCorrectionScopeService.java`、`TaskCorrectionBatchPreviewService.java`、`TaskCorrectionBatchWorker.java`、`TaskCorrectionBatchRecoveryService.java` | `service/correction/TaskCorrectionScopeServiceTest.java`、`TaskCorrectionBatchPreviewServiceTest.java`、`TaskCorrectionBatchWorkerTest.java`、`TaskCorrectionBatchPersistenceServiceTest.java` | 范围由数据库计算且跨分页；唯一活动占用、逐项日志、过期预览拒绝、部分失败独立重试；不承诺整批事务 |
| 桌面数据与设置 | `model/entity/`、`repository/`、`config/SqliteMediaTaskSchemaMigration.java`、`service/settings/SettingsService.java` | `config/SqliteMediaTaskSchemaMigrationTest.java`、`SqliteTaskCorrectionBatchSchemaMigrationTest.java`；`frontend/src/views/SystemSettingsView.vue` | 重建独立桌面 schema、有序 SQL、分页和作业列表；不导入旧 Java 库或复制 ORM 自动改表 |
| 代理与凭据 | `service/settings/TmdbProxySettingsService.java` | `service/settings/TmdbProxySettingsServiceTest.java` | 保留 TMDB 专属代理；Main safeStorage 管理密钥，Core 仅内存持有，不沿用明文设置 |
| Emby 连接 | `service/emby/EmbySettingsService.java` | `service/emby/EmbySettingsServiceTest.java` | 迁移身份、权限和库目录验证；路径命名空间不一致明确阻断，不猜映射 |
| Emby 交付 | `service/emby/EmbyLibraryRefreshService.java` | `service/emby/EmbyLibraryRefreshServiceTest.java` | 重做持久化刷新意图、合并/退避、分页收录核对；文件 DONE 不等于已收录 |
| 总览、队列和设置 | `frontend/src/views/DashboardView.vue`、`QueueView.vue`、`SetupView.vue`、`PathsView.vue`、`SystemSettingsView.vue` | `frontend/tests/confirmQueueDirectory.test.mjs`、`queueOrganization.test.mjs`、`queueDirectories.test.mjs` | React 重建，框架 StatefulService ViewModel；复用验证后的交互语义/文案，重载只查状态不重放任务 |

## 一期明确排除

- Spring Controller、JPA/Hibernate、STOMP 与服务端部署配置：保留旧工程，桌面以受限 IPC 替换，不追求 REST 兼容。
- `service/parser/CodexRecognitionService.java`、Codex CLI bridge、SMTP：保留旧部署能力，不进入桌面安装包。
- `MoveRenameStrategy`、`HardLinkRenameStrategy`、`SymbolicLinkRenameStrategy`：不作为来源入库模式。修正已整理目标的安全改名是独立业务。
- `service/discovery/asset/BluRayDirectoryAssetDetector.java`、`IsoImageAssetDetector.java` 及对应整理器：首版明确跳过；音乐、新 Web、NAS、网盘云端 API、旧库导入另立变更。

## 新增正确性要求

旧系统没有统一的普通任务恢复和可靠的 Emby 交付，不能把行为对照解释为照搬缺陷。新客户端必须通过真实 SQLite/临时文件故障测试验证唯一领取、提交后记账、过期修正、源/目标冲突及崩溃后补记。框架启动清理不能代替持久化恢复；平台真实安装验收结果独立记录，未验证项保持未完成。
