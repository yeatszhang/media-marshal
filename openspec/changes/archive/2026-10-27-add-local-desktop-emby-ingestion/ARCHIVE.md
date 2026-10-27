# 历史归档与后续任务索引

归档日期：2026-10-27。用户要求归档当前大变更，并将所有未完成任务拆为后续 change。

这是分阶段收束的历史归档，不代表全部功能或正式发行完成。归档时为 **97/119**，22 项未完成任务已全部迁出；原 tasks.md 勾选和历史证据保留，未将迁出任务标为已完成。21.1／21.2 已完成；v29 成功收据及网盘接线为 21.5 的局部进度，不代替完整验收。

## 规格处理

原变更的 7 份增量规格混合已实现与尚未实现的行为；主规格原先为空。本次跳过主规格同步，全部增量原文留作历史，不宣称这些要求已落地主规格。后续变更沿用原 capability 标识，将相关要求按不重叠范围承接为 ADDED，分别实现和验收后再同步；没有被迁出的历史能力仍可在本归档中查阅，不能因为归档被当成新实现承诺。

## 后续变更

| Change | 范围 | 原未完成任务数 |
| --- | --- | --- |
| [finish-source-sync-rules](../../finish-source-sync-rules/proposal.md) | 完成来源单向同步与成功历史 | 3 |
| [add-independent-recognition-mapping](../../add-independent-recognition-mapping/proposal.md) | 独立识别配置与多目标映射 | 3 |
| [add-emby-target-path-binding](../../add-emby-target-path-binding/proposal.md) | 识别目标与 Emby 媒体库路径关联 | 2 |
| [validate-local-file-readiness](../../validate-local-file-readiness/proposal.md) | 验证本地文件就绪与客户端自动策略 | 3 |
| [complete-macos-release-validation](../../complete-macos-release-validation/proposal.md) | 完成 Mac 发行与综合验收 | 11 |

## 逐项迁移映射

每一原任务恰有一个执行所有者；关联测试可共用同构建证据，但不得丢失原场景。

| 原任务 | 承接 change | 新任务 |
| --- | --- | --- |
| 1.3 | [complete-macos-release-validation](../../complete-macos-release-validation/tasks.md) | 1.1 |
| 1.4 | [complete-macos-release-validation](../../complete-macos-release-validation/tasks.md) | 1.2 |
| 2.6 | [complete-macos-release-validation](../../complete-macos-release-validation/tasks.md) | 1.3 |
| 4.1 | [validate-local-file-readiness](../../validate-local-file-readiness/tasks.md) | 1.1 |
| 4.4 | [validate-local-file-readiness](../../validate-local-file-readiness/tasks.md) | 1.2 |
| 4.6 | [add-independent-recognition-mapping](../../add-independent-recognition-mapping/tasks.md) | 1.1 |
| 7.3 | [validate-local-file-readiness](../../validate-local-file-readiness/tasks.md) | 1.3 |
| 8.1 | [complete-macos-release-validation](../../complete-macos-release-validation/tasks.md) | 1.4 |
| 8.2 | [complete-macos-release-validation](../../complete-macos-release-validation/tasks.md) | 1.5 |
| 8.4 | [complete-macos-release-validation](../../complete-macos-release-validation/tasks.md) | 1.6 |
| 8.5 | [complete-macos-release-validation](../../complete-macos-release-validation/tasks.md) | 1.7 |
| 9.1 | [complete-macos-release-validation](../../complete-macos-release-validation/tasks.md) | 1.8 |
| 9.2 | [complete-macos-release-validation](../../complete-macos-release-validation/tasks.md) | 1.9 |
| 18.4 | [complete-macos-release-validation](../../complete-macos-release-validation/tasks.md) | 1.10 |
| 21.3 | [finish-source-sync-rules](../../finish-source-sync-rules/tasks.md) | 1.1 |
| 21.4 | [finish-source-sync-rules](../../finish-source-sync-rules/tasks.md) | 1.2 |
| 21.5 | [finish-source-sync-rules](../../finish-source-sync-rules/tasks.md) | 1.3 |
| 21.6 | [add-independent-recognition-mapping](../../add-independent-recognition-mapping/tasks.md) | 1.2 |
| 21.7 | [add-independent-recognition-mapping](../../add-independent-recognition-mapping/tasks.md) | 1.3 |
| 21.8 | [add-emby-target-path-binding](../../add-emby-target-path-binding/tasks.md) | 1.1 |
| 21.9 | [add-emby-target-path-binding](../../add-emby-target-path-binding/tasks.md) | 1.2 |
| 21.10 | [complete-macos-release-validation](../../complete-macos-release-validation/tasks.md) | 1.11 |

## 执行顺序与边界

优先完成来源同步，再联调独立识别和 Emby 目标路径关联。本地客户端观察和 Mac 构建／生命周期可独立推进；最终综合验收等待相关功能完成。已有非 macOS 客户端、多语言和 Emby 初始化三个 change 保持独立，既有提案链接已改到本归档。

本次仅移动和补齐规划，不改运行代码、不执行 schema 迁移、不运行媒体任务、不生成或发布安装包。所有旧版本截图、构建摘要和测试数字保留原口径。
