# 完成 Mac 发行与综合验收

## 为什么

现有 arm64 构建和局部安装态证据不能覆盖 Intel、原生 OS 行为、完整故障矩阵或正式签名发行。需要独立跟踪剩余发行工作和新流程综合验收。

由[原变更归档](../archive/2026-10-27-add-local-desktop-emby-ingestion/tasks.md)拆出，承接原任务 1.3、1.4、2.6、8.1、8.2、8.4、8.5、9.1、9.2、18.4、21.10。原 21.1／21.2 已完成，本次不重做；旧任务部分已有实现，完整验收前仍保持未完成。

## 变更内容

Mac 两架构自包含构建、冻结 parser、原生生命周期、签名公证、安装升级、下载页面和新流程故障矩阵；不交付其他 OS，不包含自动安装 Emby 或语言切换。

架构构建、签名准备及原生生命周期可先推进；新流程最终验收依赖 finish-source-sync-rules、add-independent-recognition-mapping、add-emby-target-path-binding、validate-local-file-readiness。

## 能力

### 新增能力

- `desktop-distribution`：承接本变更负责的要求，保留原能力标识。
- `desktop-runtime`：承接本变更负责的要求，保留原能力标识。
- `bundled-transfer-runtime`：承接本变更负责的要求，保留原能力标识。

### 修改能力

无已发布主规格。原变更为保留未完成事实而跳过主规格同步，本变更使用 ADDED 承接原能力中的独立要求，其他后续变更使用不重叠的要求。后续归档须保留同能力的其他要求。

## 影响

影响 apps/desktop 的宿主与构建配置、tools/desktop-parser、tools/desktop-sidecars、tools/desktop-files、安装态测试和 docs 的发行说明。仅迁移规划，不修改运行代码或数据，不启动同步、识别或发行。非 macOS、多语言、Emby 安装仍由既有独立变更承担。
