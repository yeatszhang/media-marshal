# 独立识别配置与多目标映射

## 为什么

识别与整理仍依赖旧来源组织配置。需要独立输入、规则、类型目标和执行控制，使来源同步与媒体映射可以分别配置和暂停。

由[原变更归档](../archive/2026-10-27-add-local-desktop-emby-ingestion/tasks.md)拆出，承接原任务 4.6、21.6、21.7。原 21.1／21.2 已完成，本次不重做；旧任务部分已有实现，完整验收前仍保持未完成。

## 变更内容

独立识别页、完成交接、电影／剧集多 target、预览与执行、暂停／编辑／删除／重置协调。

复用原 21.1／21.2 契约与迁移。普通目录入口可先实现；受管同步联调依赖 finish-source-sync-rules，Emby 自动路径关联由 add-emby-target-path-binding 承接。

## 能力

### 新增能力

- `local-folder-ingestion`：承接本变更负责的要求，保留原能力标识。
- `managed-cloud-downloads`：承接本变更负责的要求，保留原能力标识。

### 修改能力

无已发布主规格。原变更为保留未完成事实而跳过主规格同步，本变更使用 ADDED 承接原能力中的独立要求，其他后续变更使用不重叠的要求。后续归档须保留同能力的其他要求。

## 影响

影响 packages/media-core/src/ingestion/、sources/、packages/contracts/src/sync-recognition.ts、apps/desktop 的识别／待处理／任务页面。仅迁移规划，不修改运行代码或数据，不启动同步、识别或发行。非 macOS、多语言、Emby 安装仍由既有独立变更承担。
