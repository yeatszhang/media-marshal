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
