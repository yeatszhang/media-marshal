# 识别目标与 Emby 媒体库路径关联

## 为什么

已有 Emby 交付实现只接受直接可匹配的路径，需要根据识别目标自动发现媒体库并支持本机与服务端路径命名空间转换。

由[原变更归档](../archive/2026-10-27-add-local-desktop-emby-ingestion/tasks.md)拆出，承接原任务 21.8、21.9。原 21.1／21.2 已完成，本次不重做；旧任务部分已有实现，完整验收前仍保持未完成。

## 变更内容

全部媒体库路径发现、目标自动关联、显式路径转换、绑定版本及独立交付重试；不安装或修改 Emby Server。

基于原 21.1／21.2 的 EmbyTargetBinding 契约及既有交付协调器；最终页面和文件交付联调依赖 add-independent-recognition-mapping。

## 能力

### 新增能力

- `emby-delivery`：承接本变更负责的要求，保留原能力标识。

### 修改能力

无已发布主规格。原变更为保留未完成事实而跳过主规格同步，本变更使用 ADDED 承接原能力中的独立要求，其他后续变更使用不重叠的要求。后续归档须保留同能力的其他要求。

## 影响

影响 packages/contracts/src/sync-recognition.ts、packages/media-core 的 Emby 连接／交付适配、apps/desktop 的识别 target 配置。仅迁移规划，不修改运行代码或数据，不启动同步、识别或发行。非 macOS、多语言、Emby 安装仍由既有独立变更承担。
