# 统一本地下载目录

## Why
来源与识别重复选择目录和客户端，偏离设置页统一下载目录的产品边界。

## What Changes
- 设置页为唯一下载目录配置入口；来源只选择同步输入，识别只配置媒体目标及规则。
- 新同步预览使用当前设置，识别输入随设置切换；已受理任务保持冻结路径。
- 未配置时引导设置，删除已同步文件不自动补回，保留目录身份核验。

## Capabilities
### New Capabilities
- `shared-download-directory`: 唯一下载目录及两阶段执行边界。
### Modified Capabilities
无。此决策替代 finish-source-sync-rules 和 add-independent-recognition-mapping 中允许逐规则覆盖目录的行为。

## Impact
桌面来源、识别、设置，公共写契约和核心目录解析。无数据清理或新增兼容迁移。
