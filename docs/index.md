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
