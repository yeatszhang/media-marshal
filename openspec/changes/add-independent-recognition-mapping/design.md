# 独立识别配置与多目标映射设计

2026-10-28 产品决策更新：逐规则下载目标／识别输入覆盖及识别客户端选择由后续变更 [unify-local-download-directory](../unify-local-download-directory/proposal.md) 收敛到设置页唯一目录。以下为本变更已完成时的设计记录。


## 上下文

复用原 21.1／21.2 契约与迁移。普通目录入口可先实现；受管同步联调依赖 finish-source-sync-rules，Emby 自动路径关联由 add-emby-target-path-binding 承接。

当前基线为提交 87f2ac6：sync-recognition.ts 契约、schema v28 配置迁移及 v29 网盘成功收据已存在，主页面与调度仍有兼容模型。原完成项不重做，未完成项的局部证据不能代表整项通过。详见[归档设计](../archive/2026-10-27-add-local-desktop-emby-ingestion/design.md)与[任务证据](../archive/2026-10-27-add-local-desktop-emby-ingestion/tasks.md)。

## 目标与非目标

独立识别页、完成交接、电影／剧集多 target、预览与执行、暂停／编辑／删除／重置协调。 具体行为以本变更 specs 为准。保留 Renderer → 受限 IPC → Core 边界，Core 独占 SQLite，Main 管理原生授权和凭据；不接管真实媒体、不把数据库回退当作文件撤销。

## 决策

以现有 RecognitionRuleConfiguration、RecognitionRuleSnapshot 和 v28 迁移结果为基础。旧本地直整保留原输入和媒体路径，不新增中间副本；新识别规则可以直接读取普通目录或受管完成区。受管输入只接收有提交事实的成果，排除暂存和未登记外部文件。

outbox 与补扫按资产版本去重，来源只保留追溯关系。来源暂停不暂停已完成文件的识别，识别暂停不阻塞同步；缺失输入不反向触发补下载。复用现有 COPY、季集核对和修正日志，拒绝循环路径与重叠识别接管。

目标按电影／剧集类型唯一匹配，同类多匹配或缺目标等待人工选择，不能按保存顺序猜测。自动策略默认关闭，首次样本授权绑定识别规则版本；未知客户端保留人工确认。预览随配置变更失效，已受理计划冻结到安全点，规则删除不删文件或历史。

## 风险与取舍

- 旧配置与新投影漂移 → 切换前重新核对版本、授权与暂停，失败保留原记录和可修复原因。
- 局部测试被误当作完整交付 → 验证绑定当前源码和产物；已完成证据引用原版本，不填补缺失场景。
- 多个后续变更共用模块 → 本变更只负责提案中的范围，共享契约变更同步检查依赖，不重复维护配置写入口。

## 实施与恢复

按 tasks 逐项提交实现、定向测试及对应文档；先验证纯契约和隔离文件，再验证页面及当前安装产物。需要新增迁移时追加版本、保留一致性备份并拒绝旧核心写新库；不改写已经发布的迁移，不覆盖用户媒体。阶段失败保留持久记录，重试不重复已完成文件操作。

## 验证入口

按改动运行 npm run typecheck、npm run check:boundaries、相关 npm test、test:desktop／test:packaged；文档执行 npm run docs:build，规划执行 openspec validate --all --strict。每条任务中的真实客户端、真实 OS、架构和发行条件不可被这些通用检查替代。
