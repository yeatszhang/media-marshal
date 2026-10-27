# 完成 Mac 发行与综合验收设计

## 上下文

架构构建、签名准备及原生生命周期可先推进；新流程最终验收依赖 finish-source-sync-rules、add-independent-recognition-mapping、add-emby-target-path-binding、validate-local-file-readiness。

当前基线为提交 87f2ac6：sync-recognition.ts 契约、schema v28 配置迁移及 v29 网盘成功收据已存在，主页面与调度仍有兼容模型。原完成项不重做，未完成项的局部证据不能代表整项通过。详见[归档设计](../archive/2026-10-27-add-local-desktop-emby-ingestion/design.md)与[任务证据](../archive/2026-10-27-add-local-desktop-emby-ingestion/tasks.md)。

## 目标与非目标

Mac 两架构自包含构建、冻结 parser、原生生命周期、签名公证、安装升级、下载页面和新流程故障矩阵；不交付其他 OS，不包含自动安装 Emby 或语言切换。 具体行为以本变更 specs 为准。保留 Renderer → 受限 IPC → Core 边界，Core 独占 SQLite，Main 管理原生授权和凭据；不接管真实媒体、不把数据库回退当作文件撤销。

## 决策

保留既有构建、parser、Guardian、原生 ABI 和安装工具，只补未完成范围并修复验证暴露的问题，不重新实现已有原型。每份证据绑定构建／ASAR 摘要、架构、系统和签名状态，同一构建可复用相交检查；旧包不能替代新流程验收。

arm64 与 x64 分别记录，macOS 14 最低系统仍须实际核验。OS 目录选择、托盘图标、登录启动和休眠等真实行为不能用 API 替身替代；实际账号自然限流与故障注入分列。验证文件使用隔离目录，真实媒体和凭据操作按具体授权进行。

无 Developer ID／公证配置时保持正式发行未完成，功能及未签名内测可继续。发行页面必须匹配实际产物、最低系统和摘要；上传发布不由本规划授权。原 21.10 新同步／多目标／删除后不重下闭环与原 9.1、9.2、18.4 矩阵共用当前构建收据，逐项记录覆盖，不缩小验收范围。

## 风险与取舍

- 旧配置与新投影漂移 → 切换前重新核对版本、授权与暂停，失败保留原记录和可修复原因。
- 局部测试被误当作完整交付 → 验证绑定当前源码和产物；已完成证据引用原版本，不填补缺失场景。
- 多个后续变更共用模块 → 本变更只负责提案中的范围，共享契约变更同步检查依赖，不重复维护配置写入口。

## 实施与恢复

按 tasks 逐项提交实现、定向测试及对应文档；先验证纯契约和隔离文件，再验证页面及当前安装产物。需要新增迁移时追加版本、保留一致性备份并拒绝旧核心写新库；不改写已经发布的迁移，不覆盖用户媒体。阶段失败保留持久记录，重试不重复已完成文件操作。

## 验证入口

按改动运行 npm run typecheck、npm run check:boundaries、相关 npm test、test:desktop／test:packaged；文档执行 npm run docs:build，规划执行 openspec validate --all --strict。每条任务中的真实客户端、真实 OS、架构和发行条件不可被这些通用检查替代。
