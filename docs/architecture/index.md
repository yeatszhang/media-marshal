# 架构总览

当前开发主体是 `apps/desktop/`（Electron + React）、`packages/contracts/` 和 `packages/media-core/`（TypeScript）。桌面运行不依赖旧 Java 服务或旧数据库。

Renderer 通过受限业务 IPC 访问能力，Preload 保持最小桥接；Main 管理原生窗口、目录授权与凭据，Core 独占业务 SQLite。具体进程关系和模型见[云端下载内部边界](./cloud-downloads-internal.md)。

## 阅读入口

| 任务 | 文档 |
| --- | --- |
| 环境、构建与进程边界 | [桌面客户端开发](./desktop-development.md) |
| 旧业务规则迁移 | [桌面迁移基线](./desktop-migration.md) |
| 识别与人工确认 | [识别规则](./desktop-recognition.md) |
| 文件整理与 Emby 交付 | [整理流水线](./desktop-ingestion.md) |
| 下载进程、权限与恢复 | [云端下载内部边界](./cloud-downloads-internal.md) |
| 网盘与传输扩展 | [扩展开发](./cloud-adapter-development.md) |
| Mac 云端下载验证记录 | [Mac 云端下载验收](./mac-cloud-downloads-validation.md) |
| 错误与交互反馈 | [错误反馈约定](../development/error-feedback.md) |

产品范围与任务状态以对应 OpenSpec 变更和已落地主规格为准；验证记录不自动代表正式发行验收完成。

## 旧工程架构

Java / Vue / Docker 的[架构总览](../legacy/architecture/index.md)、[发现与整理流程](../legacy/architecture/processing.md)及[数据与恢复机制](../legacy/architecture/data-and-recovery.md)已归档。其他历史资料见[旧工程入口](../legacy/index.md)。
