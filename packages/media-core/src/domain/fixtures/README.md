# 桌面媒体规则的行为对照

以下固定样例只包含仓库中的示例名称和 `/fixture/library` 虚构路径，不从个人媒体或数据库提取，也不请求公网服务。各案例用 `source` 定位旧 Java 测试或实现方法；`manifest.json` 固定提取基线、来源 SHA-256、方法和案例数量。期望根据旧断言、源码与新规格人工核对，未宣称运行 Java 生成结果。

| 夹具 | 数量 | 对照内容 |
| --- | ---: | --- |
| `templates.json` | 14 | Java `TemplateRendererTest` 的有效输出：可选片段、缺值、补零、范围、前后缀及字符清洗 |
| `search-plans.json` | 24 | Java `TitleSearchPlanBuilderTest`：中英文、字幕组、括号、数字标题、集名排除及 guessit 退路去重 |
| `confidence-scores.json` | 12 | Java `TmdbConfidenceScorerTest`：五项评分分量、加权总分、邻近年份、续季、别名弱证据和媒体类型排除 |
| `episode-reconciliation.json` | 16 | Java `TmdbEpisodeServiceTest`：真实集号、合并集缺集、特别篇、唯一换季、歧义、网络失败及不猜累计偏移 |
| `correction-scopes.json` | 18 | Java 修正范围与桌面边界：同季／同剧、稳定顺序、跨来源／策略排除、缺值保留、完整 101 项范围；另有 7 项证据变更样例 |
| `intentional-differences.json` | 2 | 已知旧缺陷的旧期望、新期望及对应新规格 |

独立命令无需 Java、旧服务或数据库。仓库运行器使用 Electron Node，命令及依赖准备见桌面开发文档；不是调用旧 Maven 测试。

```sh
npm run test:rules
```

开发期还可显式取消 Java 环境配置后复验：

```sh
JAVA_HOME=/nonexistent-media-marshal-java npm run test:rules
```

`migration-fixtures.test.ts` 直接执行生产领域函数，断言固定输出、分集请求范围、失败分类、输入不被修改、修正成员与两个固定 SHA-256 向量。分集请求顺序采用 TS 当前确定顺序，不要求旧实现的网络调用顺序或原始异常消息一致。范围内新增成员、移除成员、修改路径、更新版本、季集、来源或策略都改变修正范围证据；输入排列不改变证据。后续接入修正用例时，输入必须来自完整核心查询，不能把 UI 当前分页当成整个修正范围。

`correction-scope.ts` 是纯成员与证据计算，不接入文件操作或 IPC。它保留缺少季集、缺少目标和不支持资产的成员并逐项标记原因，避免摘要隐瞒失败；同季要求锚点有季号，同剧可包含缺季成员供后续预览阻断。后续 5.6／5.7 仍须接入 SQLite 范围查询、真实分集复核、根与文件身份检查、活动占用、持久执行与历史；本组夹具通过不代表修正功能已可用。证据采用带版本的 JSON 数组，固定字段、锚点与范围，包含来源／策略及资产版本；Core 后续计算 SHA-256，不承诺兼容旧 Java 以分隔符拼接的哈希或导入旧库。

`media.test.ts` 另按 `ParseResultTest`、`EpisodeSeasonResolverTest` 核对连续集、最近季号线索及坐标冲突。错误类型、小数、无界范围、非法模板参数和路径安全在相应领域测试中检查。单条／批量整理已共用 `reconcileEpisodes` 和 `assertUniqueEpisodes`；自动及修正入口仍按任务 3.4 验收，不能自行按集数上限或偏移换算。

## 有意修正的差异

- Java `ParseResult.setEpisode`／`toEpisodeNumbers` 使用 `Number.intValue`，可能将 `1.2` 截断为第 1 集。桌面以 `PARSE_INVALID` 拒绝，不把错误坐标当有效识别；依据变更中的「迁移后的识别与模板行为」及已有归一化约束。
- Java `ParentFolderMatchEnhancerTest#boostsCandidateOnlyWhenFilenameAndParentFolderAgreeOnSameTmdbId` 接受文件名 0.30、父目录 0.90 合并为 0.95。新规格「父目录命中但文件名证据不足」不允许仅靠父目录自动整理；TS 在此组合保持 0.75，只有双方都至少 0.60 才相互加分。
- 修正范围沿旧规则的 DONE／TV／TMDB／规则归属边界，桌面对应物理来源与整理策略，增加资产版本证据。旧规则 ID 和数字任务 ID 不作为桌面 UUID 或哈希的兼容承诺。缺值和不支持成员保留在范围中等待逐项处理，不静默当作整组成功。

中文首字母继续采用单字首读音规则，固定字典生成过程及摘要见 `tools/desktop-parser/generate_initials.py`，声明及来源见 `apps/desktop/resources/pinyin4j-NOTICE.txt`。不引入运行时 Java 或上下文多音字推断。模板预览保留缺值的原占位符，执行路径另外拒绝未解析变量、越界及平台不支持名称。
