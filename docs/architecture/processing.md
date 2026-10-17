# 发现与整理流程

本文以 2026-10-17 当前工作区为基线，与[架构总览](./index.md)一同阅读。数据状态、事务和中断行为见[数据与恢复机制](./data-and-recovery.md)。

## 从规则到媒体资产

`WatchRule` 是业务入口：源目录、目标目录、媒体类型约束、发现模式、操作策略和电影 / 剧集模板共同决定整理行为。保存前由 `WatchRulePreflightService` 检查目录与所选操作能力；创建、更新、删除、启用切换会重载发现服务。

`FileDiscoveryService.reload()` 读取启用规则，重建 WatchService、目录映射、周期任务和内存扫描索引。它不等价于立即对全部历史文件做完整整理扫描。

| 发现入口 | 执行方式 | 行为边界 |
| --- | --- | --- |
| `WATCH_EVENT` | 递归注册 JDK WatchService | 普通视频事件先防抖，默认 3 秒，再间隔 1 秒比较文件大小；稳定后进入发现去重 |
| `PERIODIC_SCAN` | 周期触发增量扫描 | 默认每 10 分钟，最小 5 分钟；首次建立目录索引 |
| `HYBRID` | 监听 + 周期增量扫描 | 默认模式，以补扫弥补网络盘 / 挂载盘事件遗漏 |
| 手动全量扫描 | `POST /api/watch-rules/{id}/scan` | 不受发现模式限制；枚举全量，允许失败路径重新进入处理 |
| 新目录事件 | 注册新子树并补扫 | 覆盖一次性移入的既有文件；与同规则扫描互斥 |

周期扫描使用 `IncrementalDirectoryScanner`，按目录缓存修改时间、文件标识、直接子目录与文件集合。每轮仍检查所有已知子目录的属性；只有目录变化时重新枚举直接子项，将新增文件送入后续发现。因此它减少的是重复枚举和重复识别，不是完全不遍历目录。索引在重启、规则重载及事件溢出重建时失效；文件内容变化本身不作为重新识别的理由。目录属性不能可靠反映变动时，需要手动全量扫描核对。

普通视频的大小稳定检查属于监听事件路径；全量 / 增量扫描直接调用发现与流水线，并不统一经过该防抖步骤。不要据此承诺所有入口都能确认文件已写入完成。

忽略规则先行，随后 `MediaAssetDetectionService` 按探测器优先级识别资产：

- 普通视频是单文件资产。
- 电影蓝光目录是整体资产，发现后剪枝，避免内部 `.m2ts` 被拆成普通视频任务。
- ISO、裸监控根目录下的 `BDMV`、不支持的剧集蓝光走跳过语义，不因存在探测器或枚举就可以整理。
- Sample 过滤、附属文件等待主视频处理、杂项文件跳过分别由发现层分类处理。

去重依据是数据库中的源路径。自动发现跳过所有已有路径，包括失败和已修正历史；手动全量扫描仅跳过 `PENDING / PROCESSING / AWAITING_CONFIRMATION / DONE / SKIPPED` 路径，因此失败路径可以重试。这是“先查询、再创建”的应用层保护，`media_task.source_path` 没有唯一约束，不能视为并发条件下的严格一次执行。

源码入口：`service/discovery/FileDiscoveryService.java`、`IncrementalDirectoryScanner.java`、`DiscoveryIgnoreService.java`、`SampleVideoDetector.java` 与 `service/discovery/asset/`。

## 名称解析、作品匹配与确认

```text
[Discovered asset]
        |
        v
[PENDING --> PROCESSING]
        |
        v
[guessit parse] --> [Optional Codex cluster identity]
        |                         |
        +-------------------------+
        v
[Rule / parsed media type]
        |
        v
[TMDB queries + scoring + optional parent context]
        |
        +--> [Optional single-file Codex fallback] --> [TMDB validation]
        |
        v
[Persist ranked candidates]
        |
        +--> [Uncertain / invalid episode] --> [AWAITING_CONFIRMATION]
        |                                           |
        |                                  [Edit / select / confirm]
        |                                           |
        +-------------------------------------------+
        v
[TMDB detail + season / episode validation]
        |
        v
[Render path --> organize asset --> associated files]
        |
        +--> [DONE] --> [Events / optional Emby refresh]
        |
        +--> [FAILED]
```

`MediaProcessPipeline.process()` 创建任务后立即执行处理；`PENDING` 是持久化状态，不代表已经进入独立的可靠任务队列。

1. `GuessitParserClient` 只将资产展示名传给 parser，转换为 `ParseResult`。Parser 默认超时 5 秒；启用 Codex 时，常规解析异常可继续尝试兜底。
2. `CodexRecognitionService.recognizeCluster()` 可在普通视频的作品搜索前尝试同作品聚类；电影规则不走这一路径。共同身份与逐文件季集号分开处理。
3. 规则强制类型或解析结果确定媒体类型，无法确定时尝试允许的兜底，仍不明确则进入待确认。
4. `TitleSearchPlanBuilder` 生成标题查询，`TmdbMetadataMatcher` 合并候选并去重，`TmdbConfidenceScorer` 结合标题、年份、类型及查询证据评分。无结果时可去掉年份再查；后续季的年份不直接当作作品首播年份过滤。
5. 文件名候选不足时，`ParentFolderMatchEnhancer` 可补充父目录上下文。仅父目录命中的候选被压在自动阈值以下；同一作品的文件名与父目录证据可互证加分。
6. 候选按置信度保存为 `TaskCandidate`。自动阈值默认 0.8；无候选、分数不足、剧集缺坐标、Codex 要求确认或季集冲突均可进入人工队列。
7. 自动采纳或人工确认后，加载 TMDB 详情并校验剧集季集，再执行整理。自动确认与人工确认分别记录来源。

`TmdbEpisodeService` 的校验覆盖自动整理、人工单条 / 批量确认与已完成任务修正。路径季号仅作线索：先验证该季的完整集号范围，不存在或缺集时检查其他正片季，只有唯一一季包含全部集号才修正季号并保留映射提示。判断使用实际分集列表，不能仅凭总集数；连续合并集必须逐集存在，特殊集不映射到正片，也不猜测累计集号偏移。可靠映射通过其余校验后可自动整理，历史映射提示不单独阻断重试；人工确认首次修正仍需核对，已完成任务修正在预览中展示。重复检查同时考虑修正前季号及来源路径季号，避免漏过尚未入队的副本。无法唯一确认、分集列表缺失或远端失败时暂停整理。作品匹配分数高不等于季集坐标正确。

TMDB 搜索、详情和季数据经过 `TmdbInMemoryCache`，采用按键合并并发请求与分类型 TTL；这是进程内缓存，重启即丢失。数据库候选快照用于人工选择和追踪，不等同于 HTTP 缓存。

## Codex 桥接边界

Codex 是可选的名称建议来源，默认关闭。它不能直接决定最终 TMDB 身份，也不能直接操作媒体。Java 端通过带 `X-Media-Marshal-Token` 的 HTTP 请求调用桥接的 `/recognize`、`/recognize-cluster` 或 `/recognize-directory`。

桥接接收文件名、有限父目录与同目录文件名上下文，不接收媒体内容或 TMDB Key。它以隔离目录运行只读 Codex CLI，将模型输出约束为结构化结果，并维护文件 / 目录 / 作品簇缓存与每日调用预算。作品簇缓存可被新增剧集及其它季复用，各文件坐标仍分别解析。桥接持久化目录独立于后端 SQLite，标准三服务 Compose 不会自动启动它。

建议必须满足结构、置信度、规则类型及明确坐标约束，再经过 TMDB 搜索。单文件低分兜底不会采纳降低既有最佳匹配质量的结果。默认强制人工确认；即使关闭强制确认，Codex 置信度低于 0.9 仍需确认。手动重识别只更新识别信息和候选，不立即整理文件。

详细协议、调用成本与运行方式沿用[Codex CLI 识别兜底](../codex-fallback.md)，源码入口是 `service/parser/CodexRecognitionService.java` 与 `scripts/codex-bridge.py`。

## 待确认队列的三种批量动作

当前队列按同一 `ruleId` 和直接父目录分组，原盘与镜像独立展示。目录摘要可以展示部分文件拥有的候选及覆盖数；整目录确认要求所选文件有共同作品、完整坐标，且没有重复或重叠的季集号。摘要可见某作品不代表整个目录已具备确认条件。

| 动作 | 改变什么 | 是否整理文件 |
| --- | --- | --- |
| 公共识别字段批量编辑 | 按明确字段更新解析信息，可预览顺序集号；选择重新匹配时刷新候选 | 否 |
| Codex 同目录重识别 | 同规则、同直接父目录中的待确认普通视频共享作品识别，再回填各任务信息 | 否；不递归子目录，也不发现新任务 |
| 批量确认 | 逐项校验并转为 `PROCESSING`，提交后端确认执行器 | 是；响应中的逐项成功表示已接收，最终结果看任务状态 |

单条确认走同步 `confirm()`；批量确认走 `submitConfirm()`，使用最多 4 个并发工作的进程内执行器。它不同于[已完成任务的持久化批量修正作业](./data-and-recovery.md#批量修正作业)，没有独立批次表或重启续跑机制。

## 从模板到文件系统

`AssetOrganizerService` 按资产类型选择 `AssetOrganizerStrategy`。普通视频委托 `RenameService`；蓝光目录使用专门的整体目录整理逻辑。

模板选择顺序是：规则中对应媒体类型的模板，然后是全局模板配置，最后为内置默认模板。`TemplateVariables` 与 `@TemplateVar` 构建变量袋，`TemplateRenderer` 负责替换、格式化、连续范围与 `[[...]]` 可选片段。缺失变量在普通片段中保留占位符；可选片段缺值时整段移除。

`TemplatePathSafetyService` 在执行前拒绝空结果、绝对路径、盘符 / UNC 路径、`..` 段及规范化后逃出目标根的路径。该检查基于路径字符串和 `normalize()`，没有解析已有符号链接的真实目标，不能据此承诺对链接目录的物理隔离。

| 文件操作 | 当前语义 |
| --- | --- |
| `MOVE` | 优先 `ATOMIC_MOVE`，不支持时降级普通移动；跨文件系统不保证原子性 |
| `COPY` | 复制到目标，不以覆盖现有文件为目标行为 |
| `HARD_LINK` | 创建硬链接，需要源与目标文件系统支持；原路径保留 |
| `SYMBOLIC_LINK` | 创建指向源绝对路径的链接；依赖源路径持续可访问 |

主目标已存在时报 `TARGET_CONFLICT`。这是执行前检查，不能代替文件系统级的并发互斥保证。电影蓝光以根目录为资产，MOVE / SYMBOLIC_LINK 操作根目录，COPY / HARD_LINK 递归处理内容。

普通视频整理后，同名字幕、NFO、封面、`.md5` 等按规则的操作类型处理；附属文件冲突或 I/O 失败通常记为警告并跳过，不必然令主任务失败。蓝光目录不再走普通视频的附属文件处理。MOVE 模式下按规则清理空源目录，并以源根目录为边界。

任务落为 `DONE` 后发布完成事件，并为已启用的 Emby 集成设置待刷新标记。刷新服务每 30 秒合并请求，失败留待下轮；刷新失败不回滚整理。邮件有后端待确认 / 失败通知逻辑，但页面入口未开放。
