# Media Marshal 产品上下文

<!-- impeccable:product-schema 1 -->

## Platform

web

Electron 内的 React 桌面界面。此字段描述渲染技术，不表示提供浏览器版服务。

## Users

已有电脑、使用网盘下载，但不熟悉媒体库搭建的家庭影音用户；中国用户优先。

## Product Purpose

用现有电脑与存储建立自己的本地媒体库，持续将下载文件识别、整理并交付已有 Emby。成功意味着第一次能观看，之后新增文件仍能顺利入库。

## Operating Context

主要路径：连接账号或本地输入 → 配置来源同步 → 配置识别与映射 → 核对待处理文件 → 确认整理 → 查看文件与 Emby 各自状态。首次使用与已有配置必须呈现不同提示。

## Capabilities and Constraints

- 桌面主体为本目录、contracts 与 media-core；旧 Web/Java 工程不是本次设计对象。
- 保留文件预览、显式授权、幂等和恢复边界；默认复制保留来源。
- 文件整理成功与 Emby 收录成功分开表达，不能把统计数量当成成功数量。
- Renderer 只使用受限业务 IPC；不读取本机业务数据库或凭据。
- 简体中文优先；现有双语入口新增公共文案同步提供英文。
- 最小桌面窗口 920 × 640；长路径、长片名、英文换行与键盘操作必须可用。
- 商业服务、跨平台发行状态和未实施能力不能作为已上线承诺。

## Brand Commitments

名称 Media Marshal；定位「你的本地媒体库」。文案具体、直接，使用用户熟悉的文件、目录、识别和媒体库术语。

## Evidence on Hand

产品事实来自 ../../docs/product/positioning.md；实现边界来自 ../../AGENTS.md 和 ../../docs/architecture/desktop-development.md；需求范围以 ../../openspec/ 为准。本文是设计工具的上下文入口，不另立需求权威。

## Product Principles

- 让用户清楚下一步要做什么。
- 真实状态优先，空状态不掩盖已有记录或查询失败。
- 渐进呈现复杂配置，保留失败对象、原因和修复入口。
- 先保护用户文件，再降低操作成本。

## Accessibility & Inclusion

公共文字保证可读对比度，状态同时使用文字；键盘焦点可见，支持减少动态效果。保持系统字体，无需外部字体服务。
