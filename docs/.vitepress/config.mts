import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Media Marshal',
  description: '面向 Emby、Jellyfin 和 Plex 用户的自托管媒体文件整理工具',
  cleanUrls: true,

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '用户手册', link: '/user-guide' },
      { text: '部署指南', link: '/deployment' },
      { text: '架构文档', link: '/architecture/' },
      { text: '常见问题', link: '/faq' },
    ],

    sidebar: [
      {
        text: 'Media Marshal',
        items: [
          { text: '项目介绍', link: '/' },
          { text: '用户手册', link: '/user-guide' },
          { text: '部署指南', link: '/deployment' },
          { text: '常见问题', link: '/faq' },
        ],
      },
      {
        text: '产品规划',
        items: [
          { text: '产品定位与运营方向', link: '/product/positioning' },
          { text: '商业与付费策略', link: '/product/business-and-operations' },
        ],
      },
      {
        text: '开发与架构',
        items: [
          { text: '架构总览', link: '/architecture/' },
          { text: '发现与整理流程', link: '/architecture/processing' },
          { text: '数据与恢复机制', link: '/architecture/data-and-recovery' },
          { text: '桌面迁移基线', link: '/architecture/desktop-migration' },
          { text: '桌面客户端开发', link: '/architecture/desktop-development' },
          { text: 'Codex 识别兜底', link: '/codex-fallback' },
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
