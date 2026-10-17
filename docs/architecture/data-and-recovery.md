# 数据与恢复机制

本文描述 2026-10-17 当前工作区的持久化、一致性和中断语义。总体模块见[架构总览](./index.md)，任务如何产生见[发现与整理流程](./processing.md)。

## 持久化模型

后端使用 JPA / Hibernate 与 SQLite，默认数据库为 `/data/media-marshal.db`。连接串启用 WAL、`busy_timeout=10000`，Hikari 最大连接数为 1。这限制了数据库并发访问，不会将外部 HTTP、文件系统操作或 Java 执行器一并串行化。

```text
watch_rule 1 -------- * media_task 1 -------- * task_candidate
                           |
                           +--> media_task (correction history)

task_correction_batch 1 -------- * task_correction_batch_item
          |                                  |
          +--> watch_rule / anchor task       +--> original / corrected task

app_setting (key / value)
```

图中表示逻辑关系。`TaskCandidate.task` 使用 JPA `@ManyToOne`；`ruleId`、修正链和批次条目的关联多为标量 ID，不应理解为所有关系都具有数据库外键或级联删除保护。

| 表 | 核心信息与生命周期 |
| --- | --- |
| `watch_rule` | 源 / 目标目录、媒体类型、操作、两类模板、忽略规则、发现模式与扫描间隔；任务通过 `ruleId` 引用 |
| `media_task` | 源 / 目标路径、资产类型、解析字段、确认后的 TMDB 信息、状态、失败信息、确认来源与修正历史指针 |
| `task_candidate` | 任务某次匹配的排序候选、分数、作品快照与 `selected` 标记；完成时保留，重新匹配时替换 |
| `task_correction_batch` | 已完成剧集修正的范围、目标作品、分组指纹、唯一幂等键、汇总状态与计数 |
| `task_correction_batch_item` | 原 / 新任务、当前 / 计划目标路径、季集、执行顺序、重试次数、状态与恢复说明 |
| `app_setting` | 配置键值、描述与敏感标记；敏感标记用于响应脱敏，不提供数据库加密 |
| `tmdb_cache_entry` | TMDB 成功元数据的类型化 JSON 与到期时间；按作品类型、ID / 搜索词、季号和语言隔离，不保存 API Key 或网络错误 |

`media_task` 保留解析信息和确认信息两组字段，避免把用户纠正标题、模型建议和 TMDB 标准信息混为一谈。`metadataWarning` 在完成后仍可保留；`errorMessage`、`errorCode` 和 `failureCount` 用于错误处理；`skipReason` 用于非错误的跳过。

`task_candidate` 是当前候选快照，不是不可变事件日志。重新匹配会删除旧候选再保存新候选，重复失败合并或删除任务记录也可能删除候选。TMDB 标识需要与媒体类型一起解释，电影和剧集的相同数字 ID 不构成同一作品。

源码入口：`model/entity/`、`repository/` 与 `src/main/resources/application.yml`，均位于 `backend/` 下。

## 普通任务状态

```text
[PENDING] --> [PROCESSING] --------------------> [DONE]
    |              |                               |
    |              +--> [AWAITING_CONFIRMATION]     +--> [CORRECTED]
    |              |              |                         |
    |              |              +--> [PROCESSING]          +--> [New DONE task]
    |              |              +--> [SKIPPED]
    v              v              v
 [FAILED]       [FAILED]        [FAILED]

[Unsupported / miscellaneous asset] --> [SKIPPED]
```

状态图表示主要业务转换，不意味着每种状态变化都有对应推送。`AWAITING_CONFIRMATION` 可以反复编辑、重新匹配并保留在队列；季集校验失败时也可回到该状态。

错误码包括 `TARGET_CONFLICT`、`UNSAFE_TARGET_PATH`、`SOURCE_MISSING` 和 `PIPELINE_FAILED`。流水线会按相同源路径、规则、错误码合并重复失败，累加计数并保留最近失败时间，避免反复扫描产生大量相同失败记录。

发现服务通过删除事件与定时巡检检查 `PENDING` / `AWAITING_CONFIRMATION` 源文件。定时巡检默认 60 秒，先确认源根目录可访问，再用 `Files.notExists()` 判断；无法确认访问状态不等于文件已删除。该巡检不是普通 `PROCESSING` 任务的崩溃恢复器。

## 已完成资产修正

修正以当前 `targetPath` 对应的资产为输入，不依赖原下载路径仍存在。应用时重新构造计划并检查状态、目标、冲突和元数据，预览本身不锁住后续文件系统状态。

执行顺序由 `TaskCorrectionService.executePrepared()` 定义：

1. `TaskCorrectionFileExecutor` 按计划操作当前目标资产及相关文件，记录已执行的移动。
2. 文件操作完成后，`TaskCorrectionPersistenceService.persist()` 用短事务保存新 `DONE` 任务及候选，将原任务置为 `CORRECTED`，保存双向历史关系。
3. 提交成功后清理空目标目录、发布修正和完成事件。

```text
[Original DONE task A]
          |
          v
[File operations] --> [Short DB transaction] --> [A: CORRECTED, B: DONE]
       |                      |                        |
       v                      v                        +--> [Events / cleanup]
[Reverse executed moves] <----+
```

旧任务的 `correctedToTaskId` 指向新任务，新任务的 `correctedFromTaskId` 指向旧任务；历史记录不再接受重复修正。新任务再次修正时可以继续形成链。

文件操作异常会逆序尝试撤销已执行操作；数据库持久化异常也会触发文件回滚尝试。补偿是尽力而为，回滚失败会附加错误说明。进程在文件操作完成与数据库提交之间退出时，内存操作记录可能丢失，不能承诺跨文件系统与数据库的原子提交或自动恢复全部文件。

普通整理流水线没有这套完整的修正补偿：主文件操作、`targetPath` 保存、附属文件处理和 `DONE` 保存分步执行。中途故障时需要结合源 / 目标文件和数据库检查，不能只凭最终任务状态判断文件仍在源位置。

## 批量修正作业

只有已完成的普通剧集任务可按 `SAME_SEASON` 或 `SAME_SERIES` 批量修正。后端按 `DONE + TV_SHOW + tmdbId + ruleId` 解析整剧范围，同季额外约束季号，因此范围跨越前端分页。预览记录成员与路径等信息的指纹；应用时重新检查指纹和计划，避免沿用过期范围。

`TaskCorrectionBatchService` 先持久化作业及条目，再将作业 ID 提交给 `TaskCorrectionBatchExecutor` 的进程内单线程队列。条目顺序执行，单项失败不必使其它条目停止。单项内部仍复用修正计划、文件执行和短事务，而不是为整批文件维持一个长事务。

| 层次 | 状态 |
| --- | --- |
| 作业 | `QUEUED`、`RUNNING`、`SUCCEEDED`、`PARTIAL_FAILED`、`FAILED`、`INTERRUPTED` |
| 条目 | `PENDING`、`RUNNING`、`SUCCEEDED`、`FAILED`、`EXCLUDED` |

并发和重复请求通过几层保护协调：

- `idempotencyKey` 唯一；同键请求返回已有作业引用，不再创建新批次。它不是文件内容幂等或跨作业去重。
- `TaskCorrectionConcurrencyGuard` 用进程内协调锁、任务锁和数据库活动占用检查，协调单项修正与批量修正。
- 数据库对 `(batch_id, original_task_id)` 唯一；对 `PENDING / RUNNING` 条目的 `original_task_id` 建部分唯一索引，阻止同任务被多个活动作业同时预留。
- Worker 执行前再次核对原任务仍为 `DONE`、当前路径及重新计算的目标仍与作业快照一致。

启动时 `TaskCorrectionBatchRecoveryRunner` 将遗留 `QUEUED / RUNNING` 作业标为 `INTERRUPTED`，把未完成条目标为 `FAILED` 并记录原路径和计划目标。它不自动续跑，也不自动回滚崩溃前的文件操作。用户重试失败项时，服务重新检查原任务及路径；已经变化的项需要重新核对。

Dashboard 通过 HTTP 按作业 ID 轮询进度，最近作业引用放在当前浏览器 `localStorage`。服务端保存作业事实，但没有作业列表接口；换浏览器后不能依赖该本地索引找回全部历史作业。普通队列的批量确认不使用这里的持久化作业表。

## 配置的生效来源

| 类别 | 生效规则 |
| --- | --- |
| 普通业务配置 | 非空 `MEDIA_MARSHAL_*` 环境变量 > Spring 中 `media-marshal.*` 属性 > `app_setting` > 调用方默认值 |
| `tmdb.api-key` | 只从数据库读取，由页面 / 配置 API 保存 |
| TMDB 代理 | 经 `TmdbProxySettingsService` 解析；页面显式保存优先，未保存时才回退普通来源；支持从地址推导启用状态 |
| 规则模板 | 对应媒体类型的规则模板 > 全局模板解析结果 > 内置模板 |
| 数据库、端口、SMTP 等 Spring 基础配置 | 按 Spring 配置体系读取；不属于任意键都可从 `app_setting` 动态覆盖的业务配置 |

页面保存成功表示数据库写入成功，不代表普通配置一定覆盖了环境变量或 YAML 中的值。`GET /api/settings/effective` 可查询支持项的生效来源。TMDB 代理仅作用于 TMDB 客户端，不会自动代理 parser、Codex、Emby 或浏览器海报请求。

## 运行、升级和恢复边界

`ddl-auto=update` 与显式兼容迁移并存。启动阶段的 `SqliteMediaTaskSchemaMigration`（顺序 20）处理旧任务表的 CHECK 约束兼容，`SqliteTaskCorrectionBatchSchemaMigration`（顺序 30）创建修正作业表与索引，之后作业恢复 Runner（顺序 40）标记中断作业。项目未使用 Flyway / Liquibase 的版本化迁移体系；这些 Runner 不能代替完整升级和回滚验证。

| 状态所在位置 | 重启后的行为 |
| --- | --- |
| 后端 SQLite | 规则、配置、任务、候选与修正作业保留，取决于数据卷是否保留 |
| 媒体文件系统 | 已完成的文件操作保留；数据库回滚不自动撤销文件系统变化 |
| 普通处理 / 批量确认执行器 | 内存工作丢失；当前没有统一启动续跑 `PENDING / PROCESSING` 的机制 |
| 增量扫描索引 | 丢失并重建，不影响数据库中的已知路径去重 |
| TMDB 缓存 | 内存缓存重建；SQLite 中未到期的成功结果在首次访问时恢复，同请求并发只加载一次，失败可以重试 |
| 批量修正执行器 | 内存队列丢失；持久化作业被标记中断，等待核对与失败项重试 |
| STOMP broker、待刷新 Emby 标记 | 内存状态丢失，没有可靠投递保证 |
| Codex 桥接缓存与预算 | 挂在独立桥接运行目录中；保留该目录才可跨桥接进程重启复用 |

SQLite WAL 模式下，运行时只复制主 `.db` 文件可能漏掉尚未 checkpoint 的提交；备份应采用 SQLite 一致性备份方式，或停服后按[部署指南](../deployment.md#_7-升级、备份与恢复)操作。数据库备份不包含媒体文件，也不包含桥接运行目录和浏览器本地索引。

TMDB 缓存沿用可配置的有效期：搜索默认 6 小时、空搜索 10 分钟、电影详情 24 小时、剧集详情和整季分集 10 分钟，内存及持久层各最多保留 5000 项。有效期内同作品详情和同季分集跨任务、跨重启复用；连载数据到期后重新获取。接口响应上限为 8 MiB，避免大型整季详情超过客户端默认 256 KiB 而在 HTTP 200 时仍读取失败。限流、连接和响应读取错误会保留具体原因并传到任务页面。

当前单连接 SQLite、进程内锁、发现去重与本地文件系统共同构成单实例假设。启动多个后端共享数据库和媒体目录不能直接获得可靠的分布式调度。

## 已核实的维护限制

以下是源码边界，不表示本次已运行故障注入或部署验收：

- 后端没有内置认证，API CORS 与 WebSocket 允许来源较宽；信任边界由部署网络和外部入口控制。桥接有独立令牌，不会替后端提供访问控制。
- 模板检查阻止词法路径越界，但不保证符号链接解析后的物理目录隔离。
- 文件存在性检查、源路径查重和部分执行器保护不足以提供全局严格一次执行；并发扫描 / 确认仍需单独验证。
- 普通任务未接入重启续跑，修正补偿也不覆盖所有进程崩溃窗口；恢复时需要核对资产真实位置。
- 前端 WebSocket 尚未消费到 Store / 页面，任务列表接口又没有服务端分页；大规模历史任务与实时更新是独立的后续改进点。
- 候选和任务并非不可变审计日志，删除或重新匹配会改变记录；不能将其当成完整事件溯源系统。
