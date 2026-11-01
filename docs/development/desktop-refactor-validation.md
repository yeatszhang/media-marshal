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

## 开发控制协议与只读诊断

已接入 JSON 命令协议、输入 Schema、异步请求收据和只读 doctor；开发工具类型检查、架构检查及 7 项协议／资源／原生能力测试通过。doctor 在本工作树核验 Electron 44.9.0、SQLite ABI 149、固定 Sidecar、Guardian 和原生文件资源，正确报告未构建的 parser／源码映射。诊断不自动下载、安装或修改权限。

macOS 权限实测：辅助功能可用，屏幕录制未授权。已请求用户授权，原生截图与前台验收仍受阻；helper 的编译和能力探测不代替原生交互验收。

## 构建控制与当前产物

构建／协议测试共 11 项通过，工具类型及架构检查通过（仍为 390 项存量例外，没有新增）。故障样例覆盖脏源码、未跟踪输入、构建期间变化与改后复原、跨平台清单、产物篡改及构建写入权冲突。

统一 CLI 实际完成 development 构建，作业 `e266f375-3113-4352-9740-5b5fefc76e9e`，buildId `91d30831fa9eeb468cbb03b3865c1e389fef3e584afc03cff179534a9a942c47`。执行前重新核对源码和产物摘要。当前构建后台呈现用例 1 项通过，覆盖启动、菜单显示请求、920×640 窗口、页面重载、窗口重建与独立 userData 回收；实际查看截图，核心已连接且布局正常。此用例不代替原生前台验收。

## 隔离会话监管

协议／工具测试 13 项通过；真实 Electron 会话集成 2 项通过，呈现回归 1 项通过。集成验证跨独立 CLI 客户端查询与重复请求、保留隔离数据的重启、新 runId／代际、正常停止后的应用和控制进程退出，以及另一个独立 Electron 实例始终存活；崩溃用例仅 SIGKILL 已核实身份的临时测试应用，随后识别 crashed 并回收原控制进程。PID 复用、过期启动、错误令牌和跨会话请求另有负例。原应用关闭后调试对象已释放的时序问题已修复并复验。

当前验证构建作业 `6ea7cb3e-4b58-4cb2-ad5f-010b06f5c5b9`，buildId `5dcc176a07fe5bc714eb1bbae723abfbc3e1bed5707988041ce2f9f166623c3c`。证据及测试数据仍保留在自有 test-results，正常停止没有删除数据。会话异常时不按名称查杀，也不自动删除未知写入者的锁。

## 日志因果与真实失败迭代

工作区类型检查通过，定向回归 104 项通过，工具协议 13 项通过，架构检查通过。新增本地同步状态收敛 persistence，在同一事务读取前态并更新状态，提交后才输出带 jobId／operationIds 的变化事件；回滚不发成功事件，重复 tick 不重复打印。该文件结构上限从 753 收紧为 732，例外数量仍为 390，未增加或延期。

当前构建 `16bca64b-11a8-49a6-96eb-2f9c80ac8b35`、buildId `f7ac31a7dda78e46bb0a58b5fd765fa2b908c79ae2e46647c2da0f286511937c`：3 项 Electron 日志／源码映射用例和 2 项真实会话用例通过。UI 先经过真实 120 秒连续观察，再在预览与提交间制造隔离目标冲突；验证 actionId→Main 请求→Core 请求→jobId、持久失败、目标内容保留、物理操作关联与 Core 重启后续查。目录选择明确为后台替身，不算 native 通过。

此次复验先由新断言发现本地同步缺少 `sync.job.state` 事件，实现补齐后保持原断言通过。修复前证据保存在 `test-results/agent/c80cce75-5d4d-4ec3-8fb1-349f66ef636b/iteration-before/`；修复后见同目录树下本次 runId 的 `iteration-after/manifest.json`。前次临时日志与失败截图缺失已在 manifest 标记；当前有完整关联事件及断言结果。这是本阶段局部迭代，尚不能替代任务 11.5 的统一 CLI／Skill 全流程验收。

## 日志查询、健康与故障采集

工作区类型、格式及架构检查通过，无新增例外。工具单元／协议 19 项通过，日志回归 13 项通过；覆盖 UTF-8 字节游标、轮转续读、历史删除／原地改写、过滤绑定与签名篡改、部分行、超长行、最近警告、未知栈、路径链接拒绝、限流精确汇总与慢磁盘队列上限。完整性保持可用范围与未知历史的区分。

本轮当前构建作业 `99857df5-0028-426f-a917-747d0a5cc779`、buildId `dc59d66c9c380aaa73f72675bff2206b621f429e519bbe7d392d33d43b5d1aba`：2 项真实诊断集成通过，2 项现有日志／源码映射桌面用例通过。CLI 健康查询前后空场景业务作业保持为零，正常停止后采集总结可读；实际 pageerror、仅自有 Core 的 SIGKILL 和 Renderer 崩溃均自动保留事件，敏感异常正文未进入证据。测试使用独立 userData，没有操作个人账号或媒体。

## 场景准备：共享夹具先行

已将真实下载崩溃用例的计划准备、识别工作台的待核对任务／扫描问题准备抽到 `apps/desktop/tests/support/`，原用例复用同一实现；下载子进程先取得业务库独占访问。下载崩溃回归 7 项通过，当前构建的识别工作台回归 1 项通过，格式与架构检查通过（仍为 390 项存量例外）。验证构建作业 `6cb7ae6e-d112-4669-924f-232c8a851508`，buildId `29d7c5c09b3e07beb56453a9ded9faff30892f85c9a20f858aa394cbc0d9d88e`。

本提交仅完成共享准备逻辑，统一场景注册、seed、启动前准入及五个场景的重复后置条件仍在实施；任务 2.7 未勾选。

## 五种隔离场景与重复准备

已接入版本化场景注册、seed 和启动前独占准备；准备进程使用匹配 ABI 的 Electron Node，活跃应用只通过受限只读业务 API 核对后置条件。场景失败／部分准备保留数据、进程身份和日志，不覆盖旧库。重启保持原 profile 和开发操作，使用新 runId 记录初始断言未重跑。真实路径及固定替身见每个 profile 的 scenario.json 和工具 README 的场景表。

工具单元 21 项、真实 Electron 集成 9 项通过；五种场景各创建两次，同 seed 后置条件一致，均核对独立目录、活跃改库拒绝、重复请求不重建、跨命令请求冲突及重启保留数据。两组原有会话／故障集成也通过。构建作业 `59f16d3e-12dc-47b6-bd42-2c9765ab7d14`，buildId `28055af888a024c08fb6c014fbb392cf97c700eba287d241da9f48b5f21f3d07`，schema 35。所有成功会话最终正常停止，证据保留。

各场景首次证据 profileRunId：empty `42bddcf4-3700-4722-ba46-af3a87c700ec`；local-sync-ready `823d928f-8a0d-4aa4-889c-a58f6326ca99`；recognition-review `c8a4749c-2135-4225-84fe-97455e2fb2ae`；download-conflict `83e536f7-7802-4862-b1fd-3e5ca28a00d4`；recovery-pending `0e1d8767-8563-48d8-bad9-7e27a29f1a69`。文件位于 `test-results/agent/<profileRunId>/`；两次创建有各自独立 manifest。

待识别准备由实际后置条件发现问题：仅放入文件没有正式收据，补走生产提交后仍因暂存硬链接未清理而拒绝接入。夹具现调用真实提交和 owned cleanup，原待确认断言保持。失败证据保留于 `5ff5fadb-ec67-4a53-a9a6-c184f6664df5`、`306cc1e2-f998-4d6f-a07f-cac832512786`。识别内容、云端计划和远端 stat 仍为固定替身；恢复待处理由合成中断状态建立，不能代替真实远程传输、识别质量、OS 目录授权或本轮 SIGKILL 验收。

共享夹具回归：下载崩溃 7 项、识别工作台桌面用例 1 项通过。工具类型、格式及架构检查通过，仍为 390 项精确存量例外、122 张已登记表，无新增例外；文档构建与 OpenSpec 严格验证通过。

## 窗口枚举与语义观察

已接入 observe windows／snapshot、区域与同快照分页、控件状态／焦点／错误提示、输入遮罩和重复名称提示。公开元素引用只在当前快照内有效，内部通过 Playwright ARIA 引用定位唯一元素；不导出任意 selector／evaluate。窗口代际、文档身份／变化序号、焦点和几何变化均使旧快照失效，快照缓存上限 8 份，节点上限 4000。非可信窗口仅返回元数据，嵌入页面和明确敏感区域禁止内容采集。

工具单元 23 项通过；当前构建上 2 项 GUI 集成及 2 项会话回归通过。真实应用验证设置页导航、重载及缩放；同一可信页中的隔离 DOM 控件用于验证表单值不进入快照或文件、焦点、禁用、重复按钮各自唯一引用、匿名控件不可操作、错误弹层和分页。这些 DOM 控件为测试替身，不算产品业务提交或原生 OS 验收。构建作业 `7d59ea7e-20b8-4ed6-86d7-4e16197f8896`，buildId `e725935f7e2baec6be610a8a2b3803aecd3bba24c1abe96fbd40f51102222fe3`。

首次集成发现新快照误用“读取已有文件”的校验，写入前即失败；已改为核验自有目录后原子写入新文件，保留原路径拒绝规则和测试断言。此阶段只交付语义观察，尚无关联截图／动作／原生界面完成结论。

工作区类型、格式、架构、文档构建和 OpenSpec 严格验证通过，结构例外保持 390 项。两次 GUI 用例证据 runId 为 `3167549d-21cc-4df0-a25d-c7b8d155b54e`、`3a9461d4-928f-4bea-b538-991bf94b5d46`，均已关闭隔离应用并保留快照。
