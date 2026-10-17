---
layout: home

hero:
  name: Media Marshal
  text: 让媒体文件整理更可靠
  tagline: 自动识别电影与剧集，在低置信度时保留人工确认，按你的命名规则整理到 Emby、Jellyfin 或 Plex 媒体库。
  actions:
    - theme: brand
      text: 阅读用户手册
      link: /user-guide
    - theme: alt
      text: 查看部署指南
      link: /deployment
    - theme: alt
      text: GitHub
      link: https://github.com/media-marshal/media-marshal

features:
  - title: 自动发现与识别
    details: 监控或扫描源目录，使用 guessit 解析文件名，并通过 TMDB 匹配电影和剧集信息。
  - title: 人工确认保护
    details: 低置信度任务进入待确认队列，避免错误识别直接污染媒体库。
  - title: 灵活整理规则
    details: 支持路径模板以及移动、复制、硬链接和符号链接等文件操作方式。
---

## 产品边界

Media Marshal 是自托管媒体文件整理工具，不下载内容，不集成 PT 站或下载器，也不替代 Emby、Jellyfin 或 Plex 的播放能力。

当前版本不提供用户认证。应用 Web UI 和后端 API 建议仅部署在本机、家庭局域网或可信内网；如需远程访问，请在外部配置 VPN、反向代理认证或其它访问控制。

## 当前能力

以下按 2026-09-05 的 v0.2.13.1 工作区核对；安装时仍需确认所用镜像的实际版本。

| 能力 | 状态 |
|---|---|
| 普通电影、普通剧集、连续多集、电影蓝光目录 | 支持 |
| 四种文件操作、路径模板、Sample 过滤、常见附属文件 | 支持，具体范围见用户手册 |
| Queue 编辑 / 搜索 / 批量确认 / 顺序集号 | 支持，批量操作限当前页 |
| 已完成任务修正、普通剧集同季 / 同剧集批量修正 | 支持预览、后台执行和失败重试；范围由后端跨页解析 |
| TMDB HTTP 代理、路径规则导入导出 | 支持；代理仅用于 TMDB API |
| ISO、剧集蓝光、裸 BDMV、离散多集 | 当前不支持整理 |
| Webhook、内置认证、邮件通知页面、独立媒体库 / 播放统计 | 尚未开放 |

最近修正作业的重新打开依赖同一浏览器的本地记录；尚无服务端作业检索页面。完整使用边界见[用户手册](./user-guide.md)，安装与升级见[部署指南](./deployment.md)。

## 开发者文档

维护者可从[架构总览](./architecture/index.md)了解部署拓扑和模块边界，再阅读[发现与整理流程](./architecture/processing.md)及[数据与恢复机制](./architecture/data-and-recovery.md)。架构文档按 2026-10-17 当前工作区核对，包含尚未提交的实现；与上方较早的能力表核对时间不同，也不代表对应镜像已发行。
