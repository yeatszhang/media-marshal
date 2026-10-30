# 非 macOS 桌面客户端提案

## 为什么

当前主变更聚焦 Mac，Windows、Linux 等客户端需要独立验证宿主能力、原生依赖和安装体验，不能将既有兼容代码等同于产品支持。将这些工作从本次范围迁出，后续单独排期。

本变更由 [add-local-desktop-emby-ingestion](../archive/2026-10-27-add-local-desktop-emby-ingestion/proposal.md) 于 2026-10-25 拆出，状态为后续待实施；不属于主变更的验收或归档前置。本次只迁移规划，不实施功能。

## 变更内容

- 承接 Windows、Linux 等非 macOS 客户端的平台适配、组件资源、文件系统行为和安装发行。
- 复用现有 Electron、TypeScript Core、来源与任务契约；逐个平台建立经过实际验证的支持矩阵。
- 优先复核已有 Windows x64、NSIS、ACL 和 Guardian Job Object 基础；Linux 后续按独立目标验证，不因 Windows 完成就宣称 Linux 可用。
- 不包括 Mac Intel（仍在主变更）、Emby 自动安装或界面多语言。

## 能力

### 新增能力

- `desktop-platform-support`：非 macOS 客户端的支持矩阵、宿主行为、平台资源与安装发行验收。

### 修改能力

无。当前主规格为空；本增量只定义后续扩展，不复制主变更的七份基础规格。实施前按当时已归档主规格复核能力边界及与本扩展有关的范围限制。

## 影响

影响桌面 Main、原生文件/卷策略、parser、sidecars、electron-builder 与 CI；沿用现有业务和数据恢复语义。既有三目标证据只对应当时构建，后续完整用户流程必须重新验证。

依赖主变更对应的运行、来源与交付基线。其他后续变更可独立排期，不隐含同时实施。原任务完成状态不迁移为本变更的完成证据。
