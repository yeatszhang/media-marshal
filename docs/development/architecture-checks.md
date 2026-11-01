# 架构检查与维护

当前变更正在实施模块重组。机器规则位于 `scripts/architecture/`，以实际检查结果区分目标边界和仍需修复的存量问题，不将有例外的通过解释为架构已经整理完成。

## 本地与 PR 检查

```sh
npm run format:check
npm run test:architecture
npm run check:boundaries
npm run check:structure
npm run check:architecture
```

`format` 修改活跃源码排版；检查命令只读。格式规则与版本由 `.prettierrc.json`、根依赖锁文件固定，历史、第三方、生成物及冻结夹具排除。TS 装饰器、TSX、CSS 与工具代码使用相同规则。

快速 PR 工作流 `architecture.yml` 不按文件路径跳过，不需要 Electron 窗口或业务数据库，安装依赖时禁用安装脚本。工作流显式传入 PR 基点，缺失基点或浅克隆解析失败会拒绝检查。它提供可用的失败检查。2026-11-01 只读查询远端 main 的传统分支保护返回未保护；本轮未更改远端设置，也未推送工作流，因此不能宣称已强制阻止合并。仓库 ruleset 与 required check 状态仍以远端实际配置为准。

## 模块与数据边界

`policy.mjs` 是职责分类与允许依赖的机器来源；解析 TS paths、工作区入口和相对导入后的真实目标，检查 import、export、type-only、require 与动态 import。纯规则不依赖宿主 I/O；产品源码不能导入测试或开发控制工具；Renderer 不依赖原生能力或内部协议。

跨业务调用使用公开入口，原始数据库只能在 storage、模块 persistence 与限定测试夹具中使用。`tables.json` 登记静态 DDL 中每张表的唯一所有者；新增或删除表须同步登记。当前旧表归属登记用于迁移核对，不代表旧模型已经收敛。

### 表所有者与基线切换清单

逐表归属以 `scripts/architecture/tables.json` 为唯一清单，生命周期分类以同目录的 `table-lifecycle.json` 为准。当前 v35 内存库实际有 118 张业务表，全部具有 configuration、library、sync、ingestion、corrections、delivery、retention 中的唯一所有者；静态 DDL 多出的 4 张表是迁移中重建表的名称，不进入新基线。`storage/schema-ownership.test.ts` 用真实 SQLite 核对当前表集、所有者及旧字段，架构检查校验生命周期登记不含未知、重复或互相冲突的条目。

仅为旧配置接管保留的表为 `legacy_configuration_owner`、`recognition_legacy_owner`、`recognition_rule_legacy_reference`、`source_rule_legacy_reference`；`sync_runtime` 和 `recognition_runtime` 的 `claimed`、`edited`、`legacy_fingerprint` 是同类待移除字段。删除须与运行期双轨分支的切换一起完成，不能先删表再让现有调用者访问缺失结构。排除这 4 张接管表后，当前直接初始化的候选基线是 114 张表；正式切换仍须以实际初始化结构及调用者回归核验，登记本身不执行删表。

`source_rule`、`source_rule_version`、`desktop_source` 和 `cloud_subscription` 目前仍承担执行身份、外键或共享需求关系，不能仅凭旧名称删除；相应身份转换按后续当前模型任务实施。独立同步／识别规则及版本同样保留。成功收据、历史确认、下载提交意图、共享需求、整理 outbox、文件重定位、修正及清理恢复意图均列入 `protectedFacts`，检查禁止它们进入删除集。目录授权与配置归 configuration，媒体目标和 Emby 绑定归 library，来源／下载／收据归 sync，接入／识别／COPY 归 ingestion，修正、交付、清理各归所属模块。`app_setting` 内的业务暂停 key 仍须在所属模块迁移时拆出，表登记不能授予跨所有者写权限。

静态检查不能证明任意 SQL 的写集合，也不能证明文件恢复正确。跨所有者写入、事务边界、授权和幂等仍须代码审查及故障回归。不要把 SQL 关键词匹配包装成完整 SQL 语义分析。

### 同步事务作用域

`storage/public.ts` 只声明 `Transactions` 与不透明的 `TransactionScope`；业务模块仅可通过 type-only 导入这些类型。组装入口通过 `storage/transactions.ts` 创建事务边界，向业务流程注入 `transactions`，向各模块的 persistence 单独注入 `connectionFor`。模块公开接口不返回此连接解析能力，业务端口使用具体操作及业务参数，不接收 SQL。

跨所有者记账由流程在 `transactions.run(scope => ...)` 内依次调用各所有者端口，并将同一 scope 传递下去。嵌套调用复用原 scope，不另建事务；任一嵌套调用失败后，即使上层捕获错误，最外层仍整体回滚。scope 仅在本数据库当前同步事务内有效，不能跨库、跨请求或在事务结束后复用，也不能接管其他入口已开启的 SQLite 事务。

网络、文件操作及其等待须在事务外完成。异步函数在调用前拒绝；普通函数返回 Promise／thenable 时回滚，后续异步操作使用原 scope 会被拒绝。测试入口为 `npm test -- packages/media-core/src/storage/transactions.test.ts`，使用内存库验证两个所有者端口的整体提交／回滚，不处理个人数据。现有业务 SQL 按后续模块任务逐步接入，此基础能力本身不切换数据格式。

## 结构预算与存量例外

预算按标准格式化后的结构测量：活跃可执行文件 600 个非空非纯注释行、函数 100 行、类 20 个方法。纯声明数据不按函数统计；修改排版不能规避预算。超限先审视状态所有权，不按行数机械拆分。

`exceptions.json` 只允许精确文件、规则、符号或依赖边及最大值，附原因、维护角色、对应实施任务与不超过 60 天的期限。相对基点只允许删除或收紧；新增、扩大、延期、陈旧例外和无效基点均失败。首次接入清单只建立一次，首次 PR 后的提交仍对比该初始清单。不要删除清单或改名来重置基线。

修复一个问题后删除对应例外。修改机器规则本身须说明工程理由、增加正反例并单独审查；业务改动不能同时静默降低验收标准。本轮重构完成前须清零任务承诺范围内的例外。

## 增加业务能力

先确定该事实的所有者，再确定公开动作和跨模块事务。功能实现、契约、测试与必要说明组成可回滚单元；检查后本地提交。前端功能组件、草稿、文案及测试就近，只有真实共享能力进入 shared。新增模块时同步规则清单及当前架构模型，不维护第二份手写导入白名单。
