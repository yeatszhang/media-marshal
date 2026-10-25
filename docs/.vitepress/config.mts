import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Media Marshal',
  description: '面向 Emby、Jellyfin 和 Plex 用户的自托管媒体文件整理工具',
  cleanUrls: true,

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '桌面开发', link: '/architecture/desktop-development' },
      { text: '旧工程资料', link: '/legacy/' },
      { text: '架构文档', link: '/architecture/' },
    ],

    sidebar: [
      {
        text: 'Media Marshal',
        items: [
          { text: '项目介绍', link: '/' },
        ],
      },
      {
        text: '产品规划',
        items: [
          { text: '产品定位与运营方向', link: '/product/positioning' },
          { text: '商业与付费策略', link: '/product/business-and-operations' },
          { text: 'Mac 来源、下载与整理内测', link: '/product/cloud-downloads' },
        ],
      },
      {
        text: '开发与架构',
        items: [
          { text: '架构总览', link: '/architecture/' },
          { text: '桌面识别规则', link: '/architecture/desktop-recognition' },
          { text: '桌面整理流水线', link: '/architecture/desktop-ingestion' },
          { text: '桌面迁移基线', link: '/architecture/desktop-migration' },
          { text: '桌面客户端开发', link: '/architecture/desktop-development' },
          { text: '统一来源配置与版本', link: '/architecture/source-rules' },
          { text: '统一来源与真实 Emby 验收', link: '/architecture/mac-unified-source-validation' },
          { text: '云端下载内部边界', link: '/architecture/cloud-downloads-internal' },
          { text: '网盘与传输扩展开发', link: '/architecture/cloud-adapter-development' },
          { text: 'Mac 云端下载验收', link: '/architecture/mac-cloud-downloads-validation' },
        ],
      },
      {
        text: '旧工程资料（Java / Vue / Docker）',
        collapsed: true,
        items: [
          { text: '归档索引', link: '/legacy/' },
          { text: '旧项目介绍', link: '/legacy/overview' },
          { text: '用户手册', link: '/legacy/user-guide' },
          { text: '部署指南', link: '/legacy/deployment' },
          { text: '常见问题', link: '/legacy/faq' },
          { text: '架构总览', link: '/legacy/architecture/' },
          { text: '发现与整理流程', link: '/legacy/architecture/processing' },
          { text: '数据与恢复机制', link: '/legacy/architecture/data-and-recovery' },
          { text: 'Codex 识别兜底', link: '/legacy/codex-fallback' },
        ],
      },
    ],

    search: {
      provider: 'local',
    },

    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/media-marshal/media-marshal',
      },
    ],

    footer: {
      message: '基于 GPL-3.0 许可证发布',
      copyright: 'Copyright © Media Marshal',
    },
  },
})
